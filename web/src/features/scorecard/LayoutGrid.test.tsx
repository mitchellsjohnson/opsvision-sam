import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { defaultLayout } from './logic/layout'

type LayoutItem = components['schemas']['LayoutItem']
type LayoutResponse = components['schemas']['LayoutResponse']

const ROUTE = '/scorecards/sc-main/overview?period=2026-M10'

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
  renderApp(<App />, { route: ROUTE })
}

function openCardMenu(cardName: string) {
  const article = screen.getByRole('article', { name: new RegExp(`^${cardName}$`, 'i') })
  return within(article).getByRole('button', { name: 'Layout options' })
}

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom unless a test defines it.
  delete window.matchMedia
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
    await user.click(openCardMenu('Delivery'))
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }))

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
    await screen.findByRole('button', { name: 'Hidden (1)' })
    expect(screen.queryByRole('article', { name: /Defect rate/ })).toBeNull()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Hidden (1)' }))
    await waitFor(() => expect(screen.getByRole('article', { name: /Defect rate/ })).toBeTruthy())
    expect(puts.length).toBeGreaterThan(0)
    const defect = puts[puts.length - 1]!.items.find((i) => i.id === 'metric:defect_rate')
    expect(defect?.hidden).toBe(false)
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
    expect(screen.getByRole('article', { name: /On-time delivery/ })).toBeTruthy()
    expect(screen.getByRole('article', { name: /Defect rate/ })).toBeTruthy()
  })
})
