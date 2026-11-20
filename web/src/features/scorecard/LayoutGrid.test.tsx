import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { LayoutGrid } from './LayoutGrid'
import { defaultLayout } from './logic/layout'

type LayoutItem = components['schemas']['LayoutItem']
type LayoutResponse = components['schemas']['LayoutResponse']

const ROUTE = '/scorecards/sc-main/overview?period=2026-M10'

/** The metric's tile; its Needs attention card is an article with the same name. */
function tileOf(name: RegExp): HTMLElement {
  return screen.getAllByRole('article', { name }).find((a) => a.closest('[data-layout-item^="metric:"]'))!
}

function baseFallback(): LayoutItem[] {
  return defaultLayout(
    [
      { id: 'delivery', name: 'Delivery', order: 1 },
      { id: 'quality', name: 'Quality', order: 2 },
    ] as components['schemas']['Category'][],
    {
      delivery: [{ key: 'on_time_pct' }],
      quality: [{ key: 'defect_rate' }],
    },
  )
}

function layoutHandlers(opts: {
  initial?: LayoutItem[]
  revision?: number
  onPut?: (body: { items: LayoutItem[]; expectedRevision: number }) => void
  onFetched?: () => void
}) {
  let revision = opts.revision ?? 1

  let state: LayoutResponse = {
    items: opts.initial !== undefined ? opts.initial : [],
    revision,
    source: opts.initial !== undefined ? 'user' : 'empty',
    defaultRevision: 0,
  }

  return [
    http.get(`${API}/v1/me/layouts/:sc`, () => {
      opts.onFetched?.()
      return HttpResponse.json(state)
    }),
    http.put(`${API}/v1/me/layouts/:sc`, async ({ request }) => {
      const body = (await request.json()) as { items: LayoutItem[]; expectedRevision: number }
      opts.onPut?.(body)
      if (body.expectedRevision !== revision) {
        return HttpResponse.json(
          { error: { code: 'conflict', message: 'stale', details: [] } },
          { status: 409 },
        )
      }
      revision += 1
      state = { ...state, items: body.items, revision, source: 'user' }
      return HttpResponse.json(state)
    }),
  ]
}

function mockDesktopPointer() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

function renderOverviewWithLayout(
  layoutItems: LayoutItem[],
  onPut?: (body: { items: LayoutItem[]; expectedRevision: number }) => void,
) {
  mockDesktopPointer()
  server.use(...viewHandlers())
  server.use(...layoutHandlers({ initial: layoutItems, onPut }))
  return renderApp(<App />, { route: ROUTE })
}

/**
 * Lays the grid's items out in one column, 100px apart, in document order:
 * jsdom has no layout, and keyboard moves pick the nearest item by its box.
 */
function stackItems() {
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-layout-item')) return original.call(this)
    const items = [...document.querySelectorAll('[data-layout-item]')]
    const top = items.indexOf(this) * 100
    return { x: 0, y: top, top, left: 0, right: 600, bottom: top + 90, width: 600, height: 90, toJSON: () => ({}) } as DOMRect
  })
}

async function customize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Customize layout' }))
  return screen.getByRole('region', { name: 'Customize layout' })
}

async function openSectionMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await customize(user)
  await user.click(screen.getByRole('button', { name: `Layout options for section ${name}` }))
}

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom unless a test defines it.
  delete window.matchMedia
  vi.restoreAllMocks()
})

describe('LayoutGrid', () => {
  it('Move down on a section PUTs reordered items and shows headings in that order', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    let layoutFetched = false
    const saved: LayoutItem[] = [
      { id: 'widget:health', size: 'wide', hidden: false },
      { id: 'section:delivery', size: 'wide', hidden: false },
      { id: 'metric:on_time_pct', size: 'small', hidden: false },
      { id: 'section:quality', size: 'wide', hidden: false },
      { id: 'metric:defect_rate', size: 'small', hidden: false },
    ]
    mockDesktopPointer()
    server.use(...viewHandlers())
    server.use(...layoutHandlers({ initial: saved, onPut: (body) => puts.push(body), onFetched: () => { layoutFetched = true } }))
    renderApp(<App />, { route: ROUTE })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    await waitFor(() => expect(layoutFetched).toBe(true))

    const user = userEvent.setup()
    await openSectionMenu(user, 'Delivery')
    await user.click(await screen.findByRole('menuitem', { name: 'Move section down' }))

    await waitFor(() => expect(puts.length).toBeGreaterThan(0))
    const ids = puts[puts.length - 1]!.items.map((i) => i.id)
    const qualityIdx = ids.indexOf('section:quality')
    const deliveryIdx = ids.indexOf('section:delivery')
    expect(qualityIdx).toBeGreaterThanOrEqual(0)
    expect(deliveryIdx).toBeGreaterThan(qualityIdx)

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '')
    const qualityPos = headings.findIndex((t) => t.includes('Quality'))
    const deliveryPos = headings.findIndex((t) => t.includes('Delivery'))
    expect(qualityPos).toBeGreaterThanOrEqual(0)
    expect(deliveryPos).toBeGreaterThan(qualityPos)
  })

  it('Hidden (1) restores one hidden card in saved order', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    let layoutFetched = false
    const saved: LayoutItem[] = baseFallback().map((item) =>
      item.id === 'metric:defect_rate' ? { ...item, hidden: true } : item,
    )
    mockDesktopPointer()
    server.use(...viewHandlers())
    server.use(
      ...layoutHandlers({
        initial: saved,
        onPut: (body) => puts.push(body),
        onFetched: () => {
          layoutFetched = true
        },
      }),
    )
    renderApp(<App />, { route: ROUTE })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    await waitFor(() => expect(layoutFetched).toBe(true))
    const user = userEvent.setup()
    const bar = await customize(user)
    await within(bar).findByRole('button', { name: 'Hidden (1)' })
    expect(screen.queryByRole('article', { name: /Defect rate/ })).toBeNull()

    await user.click(within(bar).getByRole('button', { name: 'Hidden (1)' }))
    await waitFor(() => expect(screen.getByRole('article', { name: /Defect rate/ })).toBeTruthy())
    expect(puts.length).toBeGreaterThan(0)
    const defect = puts[puts.length - 1]!.items.find((i) => i.id === 'metric:defect_rate')
    expect(defect?.hidden).toBe(false)
  })

  const saved: LayoutItem[] = [
    { id: 'widget:health', size: 'wide', hidden: false },
    { id: 'section:delivery', size: 'wide', hidden: false },
    { id: 'metric:on_time_pct', size: 'small', hidden: false },
    { id: 'section:quality', size: 'wide', hidden: false },
    { id: 'metric:defect_rate', size: 'small', hidden: false },
  ]

  function sectionOrder(): string[] {
    return screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((t) => /Delivery|Quality/.test(t))
      .map((t) => (t.includes('Delivery') ? 'Delivery' : 'Quality'))
  }

  async function moveDeliveryDown(put: Parameters<typeof http.put>[1], get?: Parameters<typeof http.get>[1]) {
    mockDesktopPointer()
    server.use(...viewHandlers())
    server.use(
      http.get(
        `${API}/v1/me/layouts/:sc`,
        get ?? (() => HttpResponse.json({ items: saved, revision: 1, source: 'user', defaultRevision: 0 })),
      ),
      http.put(`${API}/v1/me/layouts/:sc`, put),
    )
    renderApp(<App />, { route: ROUTE })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    await waitFor(() => expect(sectionOrder()).toEqual(['Delivery', 'Quality']))
    const user = userEvent.setup()
    await openSectionMenu(user, 'Delivery')
    await user.click(await screen.findByRole('menuitem', { name: 'Move section down' }))
  }

  it('reorders at once, before the save finishes', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((r) => (release = r))
    await moveDeliveryDown(async ({ request }) => {
      const body = (await request.json()) as { items: LayoutItem[] }
      await pending
      return HttpResponse.json({ items: body.items, revision: 2, source: 'user', defaultRevision: 0 })
    })
    await waitFor(() => expect(sectionOrder()).toEqual(['Quality', 'Delivery']))
    release()
  })

  it('a failed save puts the layout back and says so', async () => {
    await moveDeliveryDown(() =>
      HttpResponse.json({ error: { code: 'internal', message: 'The server had a problem.', details: [] } }, { status: 500 }),
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn’t save your layout/i)
    await waitFor(() => expect(sectionOrder()).toEqual(['Delivery', 'Quality']))
  })

  it('a 409 reloads the layout and explains why', async () => {
    let gets = 0
    const theirs: LayoutItem[] = [saved[0]!, saved[3]!, saved[4]!, saved[1]!, saved[2]!]
    await moveDeliveryDown(
      () => HttpResponse.json({ error: { code: 'conflict', message: 'stale', details: [] } }, { status: 409 }),
      () => {
        gets += 1
        return HttpResponse.json(
          gets === 1
            ? { items: saved, revision: 1, source: 'user', defaultRevision: 0 }
            : { items: theirs, revision: 2, source: 'user', defaultRevision: 0 },
        )
      },
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Someone else changed this layout. We reloaded it.')
    await waitFor(() => expect(gets).toBeGreaterThan(1))
    await waitFor(() => expect(sectionOrder()).toEqual(['Quality', 'Delivery']))
  })

  it('drops an unknown saved id and still renders a metric missing from the save', async () => {
    const saved: LayoutItem[] = [
      { id: 'widget:health', size: 'wide', hidden: false },
      { id: 'metric:removed', size: 'small', hidden: false },
      { id: 'section:quality', size: 'wide', hidden: false },
      { id: 'metric:defect_rate', size: 'small', hidden: false },
      { id: 'section:delivery', size: 'wide', hidden: false },
    ]
    renderOverviewWithLayout(saved)
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(tileOf(/On-time delivery/)).toBeTruthy()
    expect(screen.getByRole('article', { name: /Defect rate/ })).toBeTruthy()
  })
})

describe('Customize layout mode', () => {
  const TILES = ['Health this month', '12-month status', 'Needs attention', 'On-time delivery', 'Defect rate', 'Not reported']

  async function renderDefault() {
    renderOverviewWithLayout([])
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    await screen.findAllByRole('article', { name: /On-time delivery/ })
  }

  it('at rest has one layout control and no handles or menus on tiles', async () => {
    await renderDefault()
    expect(screen.getAllByRole('button', { name: 'Customize layout' })).toHaveLength(1)
    expect(screen.queryAllByRole('button', { name: /^(Drag|Move) / })).toEqual([])
    expect(screen.queryAllByRole('button', { name: /Layout options/ })).toEqual([])
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save as default' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Customize layout' })).toBeNull()
  })

  it('sits beside the page title', async () => {
    await renderDefault()
    const button = screen.getByRole('button', { name: 'Customize layout' })
    const title = screen.getByRole('heading', { name: 'Overview', level: 1 })
    expect(button.parentElement!.contains(title)).toBe(true)
  })

  it('in the mode every tile and section has a handle and a menu, and its content is inert', async () => {
    await renderDefault()
    const user = userEvent.setup()
    const bar = await customize(user)
    for (const title of TILES) {
      expect(screen.getByRole('button', { name: `Move ${title}. Space to pick up` })).toBeTruthy()
      expect(screen.getByRole('button', { name: `Layout options for ${title}` })).toBeTruthy()
    }
    for (const name of ['Delivery', 'Quality']) {
      expect(screen.getByRole('button', { name: `Move section ${name}. Space to pick up` })).toBeTruthy()
      expect(screen.getByRole('button', { name: `Layout options for section ${name}` })).toBeTruthy()
    }
    expect(screen.getByText('On-time delivery · Small')).toBeTruthy()
    expect(screen.getByText('Health this month · Wide')).toBeTruthy()
    expect(screen.getByText('Section · Delivery')).toBeTruthy()
    const tile = tileOf(/On-time delivery/)
    const content = tile.closest('[inert]')
    expect(content).toBeTruthy()
    expect(content!.className).toContain('opacity-70')
    expect(within(bar).getByRole('button', { name: 'Reset layout' })).toBeTruthy()
    expect(within(bar).getByRole('button', { name: 'Save as default' })).toBeTruthy()
    expect(within(bar).getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(within(bar).getByText('Customizing layout')).toBeTruthy()
  })

  it('offers Save as default to admins only', async () => {
    state.role = 'viewer'
    await renderDefault()
    const bar = await customize(userEvent.setup())
    expect(within(bar).getByRole('button', { name: 'Reset layout' })).toBeTruthy()
    expect(within(bar).queryByRole('button', { name: 'Save as default' })).toBeNull()
  })

  it('Done leaves the mode and returns focus to Customize layout', async () => {
    await renderDefault()
    const user = userEvent.setup()
    const bar = await customize(user)
    await user.click(within(bar).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('region', { name: 'Customize layout' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /Layout options/ })).toEqual([])
    expect(tileOf(/On-time delivery/).closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Customize layout' }))
  })

  it('Esc with nothing picked up leaves the mode; Esc in a menu only closes the menu', async () => {
    await renderDefault()
    const user = userEvent.setup()
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Layout options for On-time delivery' }))
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('region', { name: 'Customize layout' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Customize layout' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Customize layout' }))
  })

  it('a tile menu shows its size as checked, then Hide and the moves', async () => {
    await renderDefault()
    const user = userEvent.setup()
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Layout options for On-time delivery' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitemradio', { name: 'Small' }).getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Wide' }).getAttribute('aria-checked')).toBe('false')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Hide', 'Move up', 'Move down', 'Move to top'])
  })

  it('a section menu moves the section with its tiles and can hide its header', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    renderOverviewWithLayout(baseFallback(), (body) => puts.push(body))
    await screen.findAllByRole('article', { name: /On-time delivery/ })
    const user = userEvent.setup()
    await openSectionMenu(user, 'Quality')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Move section up',
      'Move section down',
      'Move section to top',
      'Hide section header',
    ])
    await user.click(within(menu).getByRole('menuitem', { name: 'Move section up' }))
    await waitFor(() => expect(puts.length).toBe(1))
    const ids = puts[0]!.items.map((i) => i.id)
    expect(ids.indexOf('metric:defect_rate')).toBe(ids.indexOf('section:quality') + 1)
    expect(ids.indexOf('section:quality')).toBeLessThan(ids.indexOf('section:delivery'))
    expect(ids.indexOf('section:delivery') + 1).toBe(ids.indexOf('metric:on_time_pct'))

    await user.click(screen.getByRole('button', { name: 'Layout options for section Quality' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Hide section header' }))
    await waitFor(() => expect(puts.length).toBe(2))
    expect(puts[1]!.items.find((i) => i.id === 'section:quality')?.hidden).toBe(true)
    expect(puts[1]!.items.find((i) => i.id === 'metric:defect_rate')?.hidden).toBe(false)
  })

  it('the bar stays above a dragged tile, and on phones folds its actions into one menu beside Done', async () => {
    await renderDefault()
    const user = userEvent.setup()
    const bar = await customize(user)
    expect(bar.className).toContain('z-40')
    expect(within(bar).getByRole('button', { name: 'Reset layout' }).className).toContain('max-sm:hidden')
    expect(within(bar).getByRole('button', { name: 'Done' }).className).not.toContain('hidden')
    const more = within(bar).getByRole('button', { name: 'More layout actions' })
    expect(more.className).toContain('sm:hidden')
    await user.click(more)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Reset layout', 'Save as default'])
  })

  it('has no axe violations in the mode', async () => {
    const { container } = renderOverviewWithLayout([])
    await screen.findAllByRole('article', { name: /On-time delivery/ })
    await customize(userEvent.setup())
    expect((await axe(container)).violations).toEqual([])
  })

  it('moves a tile with the keyboard: Space picks up, an arrow moves, Space drops and saves', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    renderOverviewWithLayout(baseFallback(), (body) => puts.push(body))
    await screen.findAllByRole('article', { name: /On-time delivery/ })
    stackItems()
    const user = userEvent.setup()
    await customize(user)
    screen.getByRole('button', { name: 'Move On-time delivery. Space to pick up' }).focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard(' ')
    await waitFor(() => expect(puts).toHaveLength(1))
    const ids = puts[0]!.items.map((i) => i.id)
    expect(ids.indexOf('metric:on_time_pct')).toBe(ids.indexOf('section:quality') + 1)
    expect(screen.getByRole('region', { name: 'Customize layout' })).toBeTruthy()
  })

  it('Esc cancels a keyboard move without leaving the mode; a second Esc leaves', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    renderOverviewWithLayout(baseFallback(), (body) => puts.push(body))
    await screen.findAllByRole('article', { name: /On-time delivery/ })
    stackItems()
    const user = userEvent.setup()
    await customize(user)
    const handle = screen.getByRole('button', { name: 'Move On-time delivery. Space to pick up' })
    handle.focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('region', { name: 'Customize layout' })).toBeTruthy()
    expect(puts).toEqual([])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Customize layout' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Customize layout' }))
  })

  it('on desktop, tiles keep their content and handle; no compact rows', async () => {
    await renderDefault()
    await customize(userEvent.setup())
    expect(screen.queryByRole('button', { name: /^Move (?!.*Space to pick up).* (up|down)$/ })).toBeNull()
    expect(tileOf(/On-time delivery/)).toBeTruthy()
  })

  it('pins Health, then Needs attention, to the top', async () => {
    const fallback = baseFallback()
    const health = fallback.find((i) => i.id === 'widget:health')!
    const needs = fallback.find((i) => i.id === 'widget:needs')!
    const rest = fallback.filter((i) => i !== health && i !== needs)
    renderOverviewWithLayout([...rest.slice(0, 3), needs, ...rest.slice(3), health])
    await screen.findAllByRole('article', { name: /On-time delivery/ })
    await customize(userEvent.setup())
    const order = screen.getAllByRole('button', { name: /^Move .*Space to pick up$/ }).map((b) => b.getAttribute('aria-label'))
    expect(order.slice(0, 2)).toEqual([
      'Move Health this month. Space to pick up',
      'Move Needs attention. Space to pick up',
    ])
  })
})

describe('Customize layout on phones', () => {
  const CATEGORIES = [
    { id: 'engineering', name: 'Engineering' },
    { id: 'design', name: 'Design' },
    { id: 'product', name: 'Product' },
  ]
  const METRICS: Record<string, { key: string; name: string }[]> = {
    engineering: [
      { key: 'deploys', name: 'Deployment frequency' },
      { key: 'incidents', name: 'Incidents resolved on time' },
      { key: 'uptime', name: 'Uptime' },
      { key: 'defects', name: 'Weighted defect score' },
    ],
    design: [
      { key: 'a11y', name: 'Accessibility compliance' },
      { key: 'csat', name: 'Customer satisfaction' },
    ],
    product: [
      { key: 'nps', name: 'Net promoter score' },
      { key: 'adoption', name: 'Feature adoption' },
      { key: 'spend', name: 'Spend vs plan' },
    ],
  }
  const LABELS: Record<string, string> = {
    'widget:health': 'Health this month',
    'widget:ribbon': '12-month status',
    'widget:needs': 'Needs attention',
    'widget:unreported': 'Not reported',
    ...Object.fromEntries(CATEGORIES.map((c) => [`section:${c.id}`, c.name])),
    ...Object.fromEntries(Object.values(METRICS).flat().map((m) => [`metric:${m.key}`, m.name])),
  }
  const content = (id: string) => <div data-testid={`content-${id}`}>{LABELS[id]} content</div>

  function mockPhone() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: /max-width: (639|767)px/.test(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  }

  /** 16 blocks: three widgets, three sections with nine tiles, and Not reported; Uptime is 7th. */
  function renderPhone(onPut?: (body: { items: LayoutItem[]; expectedRevision: number }) => void) {
    mockPhone()
    server.use(...layoutHandlers({ onPut }))
    return renderApp(
      <LayoutGrid
        scorecardId="sc-main"
        categories={CATEGORIES}
        metricsByCategory={METRICS}
        isAdmin
        itemLabels={LABELS}
        metricCategories={{}}
        renderHealth={() => content('widget:health')}
        renderRibbon={() => content('widget:ribbon')}
        renderNeeds={() => content('widget:needs')}
        renderUnreported={() => content('widget:unreported')}
        renderSection={(id) => content(`section:${id}`)}
        renderMetric={(key) => content(`metric:${key}`)}
      />,
    )
  }

  async function phoneCustomize(onPut?: (body: { items: LayoutItem[]; expectedRevision: number }) => void) {
    renderPhone(onPut)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Customize layout' }))
    return user
  }

  it('renders every block as a compact row with Move up, Move down and a menu, and no tile content', async () => {
    await phoneCustomize()
    expect(screen.queryByTestId('content-metric:uptime')).toBeNull()
    expect(screen.queryAllByTestId(/^content-/)).toEqual([])
    const rows = screen.getAllByTestId('customize-row')
    expect(rows).toHaveLength(16)
    const uptime = rows.find((r) => r.dataset.layoutItem === 'metric:uptime')!
    expect(within(uptime).getByText('Uptime').className).toContain('line-clamp-2')
    expect(uptime.className).toContain('min-h-14')
    expect(uptime.className).toContain('border-dashed')
    expect(uptime.className).toContain('ml-3')
    expect(within(uptime).getByRole('button', { name: 'Move Uptime up' }).className).toContain('size-8')
    expect(within(uptime).getByRole('button', { name: 'Move Uptime down' })).toBeTruthy()
    expect(within(uptime).getByRole('button', { name: 'Layout options for Uptime' })).toBeTruthy()
    const section = rows.find((r) => r.dataset.layoutItem === 'section:engineering')!
    expect(within(section).getByText('Section · Engineering').className).toContain('uppercase')
    expect(section.className).not.toContain('ml-3')
    // No drag handles: one column, moved by buttons.
    expect(screen.queryByRole('button', { name: /Space to pick up/ })).toBeNull()
  })

  it('Move down keeps focus on the moved row’s button, announces the new position and saves', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    const user = await phoneCustomize((body) => puts.push(body))
    await user.click(screen.getByRole('button', { name: 'Move Uptime down' }))
    await waitFor(() => expect(screen.getByTestId('customize-live').textContent).toBe('Moved Uptime to position 8 of 16'))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Uptime down' }))
    const ids = puts.at(-1)!.items.map((i) => i.id)
    expect(ids.indexOf('metric:uptime')).toBe(ids.indexOf('metric:defects') + 1)
    const order = screen.getAllByTestId('customize-row').map((r) => r.dataset.layoutItem)
    expect(order.indexOf('metric:uptime')).toBe(7)
  })

  it('quick moves during a slow save keep every move: one save at a time, the latest order, the returned revision', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let revision = 1
    const user = await phoneCustomize()
    server.use(
      http.put(`${API}/v1/me/layouts/:sc`, async ({ request }) => {
        const body = (await request.json()) as { items: LayoutItem[]; expectedRevision: number }
        puts.push(body)
        if (puts.length === 1) await gate
        if (body.expectedRevision !== revision) {
          return HttpResponse.json({ error: { code: 'conflict', message: 'stale', details: [] } }, { status: 409 })
        }
        revision += 1
        return HttpResponse.json({ items: body.items, revision, source: 'user', defaultRevision: 0 })
      }),
    )
    const order = () => screen.getAllByTestId('customize-row').map((r) => r.dataset.layoutItem)
    await user.click(screen.getByRole('button', { name: 'Move Uptime down' }))
    await user.click(screen.getByRole('button', { name: 'Move Uptime down' }))
    await user.click(screen.getByRole('button', { name: 'Move Uptime down' }))
    expect(order().indexOf('metric:uptime')).toBe(9)
    expect(puts).toHaveLength(1)
    release()
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]!.expectedRevision).toBe(2)
    await waitFor(() => expect(revision).toBe(3))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(order().indexOf('metric:uptime')).toBe(9)
    const saved = puts[1]!.items.filter((i) => !i.hidden).map((i) => i.id)
    expect(saved.indexOf('metric:uptime')).toBe(order().indexOf('metric:uptime'))
    expect(screen.getByTestId('customize-live').textContent).toBe('Moved Uptime to position 10 of 16')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Uptime down' }))
  })

  it('a failed move puts the row back and keeps focus on its button', async () => {
    const user = await phoneCustomize()
    server.use(
      http.put(`${API}/v1/me/layouts/:sc`, () =>
        HttpResponse.json({ error: { code: 'internal', message: 'The server had a problem.', details: [] } }, { status: 500 }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Move Uptime down' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t save your layout/i)
    await waitFor(() =>
      expect(screen.getAllByTestId('customize-row').map((r) => r.dataset.layoutItem).indexOf('metric:uptime')).toBe(6),
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Uptime down' }))
  })

  it('the button at either end is disabled', async () => {
    await phoneCustomize()
    expect((screen.getByRole('button', { name: 'Move Health this month up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move Not reported down' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move Not reported up' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('moving a row to the end disables its button and keeps focus on the row', async () => {
    const user = await phoneCustomize()
    await user.click(screen.getByRole('button', { name: 'Move Spend vs plan down' }))
    await waitFor(() => expect(screen.getByTestId('customize-live').textContent).toBe('Moved Spend vs plan to position 16 of 16'))
    expect((screen.getByRole('button', { name: 'Move Spend vs plan down' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Spend vs plan up' }))
  })

  it('the menu hides a tile or moves it to the top or bottom; no size options', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    const user = await phoneCustomize((body) => puts.push(body))
    await user.click(screen.getByRole('button', { name: 'Layout options for Uptime' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Hide', 'Move to top', 'Move to bottom'])
    expect(within(menu).queryByRole('menuitemradio')).toBeNull()
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to bottom' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.items.at(-1)!.id).toBe('metric:uptime')
  })

  it('Hide from the menu moves focus to the next row’s menu button and announces it', async () => {
    const puts: Array<{ items: LayoutItem[]; expectedRevision: number }> = []
    const user = await phoneCustomize((body) => puts.push(body))
    await user.click(screen.getByRole('button', { name: 'Layout options for Uptime' }))
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(screen.getByTestId('customize-live').textContent).toBe('Hid Uptime'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Layout options for Uptime' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Layout options for Weighted defect score' })))
    expect(puts.at(-1)!.items.find((i) => i.id === 'metric:uptime')!.hidden).toBe(true)
  })

  it('hiding the last row moves focus to the row before it', async () => {
    const user = await phoneCustomize()
    await user.click(screen.getByRole('button', { name: 'Layout options for Not reported' }))
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(screen.getByTestId('customize-live').textContent).toBe('Hid Not reported'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Layout options for Spend vs plan' })))
  })

  it('a failed hide puts the row back and drops the announcement', async () => {
    const user = await phoneCustomize()
    server.use(
      http.put(`${API}/v1/me/layouts/:sc`, () =>
        HttpResponse.json({ error: { code: 'internal', message: 'The server had a problem.', details: [] } }, { status: 500 }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Layout options for Uptime' }))
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Hide' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t save your layout/i)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Layout options for Uptime' })).toBeTruthy())
    expect(screen.getByTestId('customize-live').textContent).toBe('')
  })

  it('Esc leaves the mode and returns focus to Customize layout', async () => {
    const user = await phoneCustomize()
    screen.getByRole('button', { name: 'Move Uptime down' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Customize layout' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Customize layout' }))
    expect(screen.getByTestId('content-metric:uptime')).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { container } = renderPhone()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Customize layout' }))
    expect((await axe(container)).violations).toEqual([])
  })
})
