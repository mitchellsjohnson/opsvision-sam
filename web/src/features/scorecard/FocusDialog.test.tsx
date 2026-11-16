import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import type { components } from '../../api/schema'
import { meFor, tenant } from '../../test/fixtures'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addServiceUptime, buildView, versions, viewHandlers } from '../../test/viewFixtures'
import { FOCUS_CHART_HEIGHT } from './charts/MetricChart'

type MethodologyVersion = components['schemas']['MethodologyVersion']
type Metric = components['schemas']['Metric']

const OVERVIEW = '/scorecards/sc-main/overview?period=2026-M10'

function renderOverview(route = OVERVIEW) {
  server.use(...viewHandlers())
  renderApp(<App />, { route })
}

/** On-time delivery at the top level rises one point a fiscal month, from 50.0% in 2024-M11. */
function ramp(view: components['schemas']['ScorecardView']) {
  for (const row of view.rows.filter((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')) {
    for (const c of row.cells) {
      const [y, m] = c.period.split('-M').map(Number)
      const v = 50 + (y! * 12 + m!) - (2024 * 12 + 11)
      Object.assign(c, { value: v, display: `${v.toFixed(1)}%` })
    }
  }
  return view
}

function renderRamp(route: string) {
  server.use(...viewHandlers({ respond: (u) => HttpResponse.json(ramp(buildView(u.searchParams))) }))
  renderApp(<App />, { route })
}

function metricCard(name: string): HTMLElement {
  return screen.getByRole('article', { name: new RegExp(name) })
}

async function openMore(dialog: HTMLElement) {
  const user = userEvent.setup()
  await user.click(within(dialog).getByRole('button', { name: 'More actions' }))
  return { user, menu: await screen.findByRole('menu', { name: 'More actions' }) }
}

/** ver-1 with on-time delivery defined, and ver-3, in force from Jul 2026, defining it again. */
function definedVersions(): MethodologyVersion[] {
  const define = (m: Metric, over: Partial<Metric>): Metric =>
    m.key !== 'on_time_pct'
      ? m
      : {
          ...m,
          reportedAt: [{ kind: 'level', id: 'l1' }],
          rule: {
            type: 'bands',
            bands: [
              { status: 'G', op: '>=', value: 90 },
              { status: 'Y', op: '>=', value: 80 },
              { status: 'R', op: '', value: 0 },
            ],
          },
          ...over,
        }
  const v1 = versions.find((v) => v.id === 'ver-1')!
  const withMetrics = (v: MethodologyVersion, over: Partial<Metric>): MethodologyVersion => ({
    ...v,
    content: { ...v.content, metrics: v.content.metrics.map((m) => define(m, over)) },
  })
  return [
    ...versions.filter((v) => v.id !== 'ver-1'),
    withMetrics(v1, { definition: 'Share of epics shipped by their committed date.', source: 'Old tracker' }),
    {
      ...withMetrics(v1, {
        definition: 'Share of committed epics shipped on time; moved epics count as late.',
        source: 'Delivery tracker',
        rule: {
          type: 'bands',
          bands: [
            { status: 'G', op: '>=', value: 92 },
            { status: 'Y', op: '>=', value: 80 },
            { status: 'R', op: '', value: 0 },
          ],
        },
      }),
      id: 'ver-3',
      name: 'FY26 v2',
      effectiveFrom: '2026-M07',
    },
  ]
}

function renderDefined(route: string) {
  server.use(
    http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: definedVersions() })),
    http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ levels: [{ id: 'l1', name: 'Units', depth: 1 }] })),
    ...viewHandlers({
      respond: (u) => {
        const view = buildView(u.searchParams)
        for (const r of view.rows) for (const c of r.cells) if (c.period >= '2026-M07') c.versionId = 'ver-3'
        return HttpResponse.json(view)
      },
    }),
  )
  renderApp(<App />, { route })
}

describe('FocusDialog', () => {
  it('shows a dialog named with the metric when focus is set', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('closes on Escape and clears focus from the URL', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Next metric/ })).toBeNull()
  })

  it('header: eyebrow, title, position, named prev/next', async () => {
    server.use(...viewHandlers({ respond: (u) => HttpResponse.json(addServiceUptime(buildView(u.searchParams))) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: 'On-time delivery' })
    expect(within(dialog).getByRole('heading', { level: 2, name: 'On-time delivery' })).toBeTruthy()
    expect(within(dialog).getByText('Delivery')).toBeTruthy()
    const nav = await within(dialog).findByRole('navigation', { name: 'Metrics' })
    expect(within(nav).getByText('1 of 3')).toBeTruthy()
    // Layout order: Delivery (on-time, uptime), then Quality (defect rate); previous wraps around.
    const prev = within(nav).getByRole('button', { name: 'Previous metric: Defect rate' })
    expect(prev.getAttribute('aria-keyshortcuts')).toBe('ArrowLeft')
    expect(prev.getAttribute('title')).toBe('Previous metric (←)')
    const next = within(nav).getByRole('button', { name: 'Next metric: Service uptime' })
    expect(next.getAttribute('aria-keyshortcuts')).toBe('ArrowRight')
    expect(within(dialog).getByRole('button', { name: 'Close' }).getAttribute('title')).toBe('Close (Esc)')
    expect(within(dialog).getByRole('button', { name: 'Ask SAM' }).getAttribute('aria-haspopup')).toBe('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Export PNG' })).toBeNull() // moved into More

    await userEvent.setup().click(next)
    const moved = await screen.findByRole('dialog', { name: 'Service uptime' })
    expect(within(moved).getByText('2 of 3')).toBeTruthy()
    expect(within(moved).getByTestId('dialog-live').textContent).toBe('Service uptime, 2 of 3')
  })

  it('arrow keys move between metrics; the hint row names the shortcuts and turns them off', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const user = userEvent.setup()
    // The dialog itself has focus on open, so a shortcut works at once.
    expect(document.activeElement).toBe(dialog)
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByRole('dialog', { name: /Defect rate/i })).toBeTruthy()
    const toggle = within(screen.getByRole('dialog')).getByRole('switch', { name: 'Shortcuts: On' })
    expect(toggle.closest('[data-hints]')!.textContent).toContain('previous / next metric')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.textContent).toBe('Shortcuts: Off')
    expect(localStorage.getItem('opsvision.shortcuts')).toBe('off')
    within(screen.getByRole('dialog')).getByRole('button', { name: /^Previous metric/ }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('dialog', { name: /Defect rate/i })).toBeTruthy()
  })

  it('More menu holds copy link, table, present and exports; copy announces', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByTestId('metric-chart')
    const { user, menu } = await openMore(dialog)
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Copy linkL',
      'View as tableT',
      'PresentP',
      'Export PNG',
      'Export SVG',
      'Export CSV',
    ])
    expect(within(menu).getByRole('menuitem', { name: 'Copy link' }).getAttribute('aria-keyshortcuts')).toBe('L')
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(within(dialog).getByTestId('dialog-live').textContent).toBe('Link copied'))
    expect(await navigator.clipboard.readText()).toBe(window.location.href)
  })

  it('says so when the link cannot be copied', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByTestId('metric-chart')
    const { user, menu } = await openMore(dialog)
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    try {
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy link' }))
      await waitFor(() => expect(within(dialog).getByTestId('dialog-live').textContent).toBe('Couldn’t copy the link'))
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('View as table opens the table without focus in the query', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByTestId('metric-chart')
    expect(within(dialog).queryByRole('link', { name: 'View as table' })).toBeNull()
    const { user, menu } = await openMore(dialog)
    await user.click(within(menu).getByRole('menuitem', { name: 'View as table' }))
    expect(await screen.findByRole('grid', { name: /table/i })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
  })

  it('definition line uses the version in force and shows Methodology only to admins', async () => {
    renderDefined(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const definition = await within(dialog).findByText(/^Share of committed epics shipped on time/)
    expect(definition.textContent).toBe(
      'Share of committed epics shipped on time; moved epics count as late. Green at 92.0% or better · Red below 80.0%.',
    )
    const source = within(dialog).getByText(/^Source:/)
    expect(source.textContent).toBe('Source: Delivery tracker · Measured monthly, by unit · Methodology ›')
    expect(within(source).getByRole('link', { name: 'Methodology' }).getAttribute('href')).toBe('/admin/methodology')
    expect(within(dialog).queryByText(/Old tracker/)).toBeNull()
  })

  it('a viewer sees the definition without the Methodology link', async () => {
    state.role = 'viewer'
    renderDefined(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const source = await within(dialog).findByText(/^Source:/)
    expect(source.textContent).toBe('Source: Delivery tracker · Measured monthly, by unit')
    expect(within(dialog).queryByRole('link', { name: 'Methodology' })).toBeNull()
  })

  it('value row: value, chip, change, since when, goal and YTD', async () => {
    renderOverview(`${OVERVIEW}&ytd=1&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const row = await within(dialog).findByTestId('focus-value-row')
    expect(within(row).getByText('84.3%').className).toContain('text-[28px]')
    expect(within(row).getByRole('img', { name: 'Yellow' })).toBeTruthy()
    expect(within(row).getByText('+2.1 pts vs Sep')).toBeTruthy()
    expect(within(row).getByText('Yellow since Oct 2026 · 1 month')).toBeTruthy()
    expect(within(row).getByText('Goal 90.0%')).toBeTruthy()
    expect(within(row).getByText('YTD 95.0%')).toBeTruthy()
  })

  it('no "Loading chart…" line once loaded; aria-busy while switching to 24M', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(...viewHandlers())
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/view`, async ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.has('metrics')) await gate
        return HttpResponse.json(ramp(buildView(url.searchParams)))
      }),
    )
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    expect(within(dialog).queryByText(/Loading chart/)).toBeNull()
    const region = within(dialog).getByTestId('metric-chart').closest('[data-chart-region]')!
    expect(region.getAttribute('aria-busy')).toBeNull()
    await userEvent.setup().click(within(dialog).getByRole('button', { name: /^24M/ }))
    await waitFor(() => expect(region.getAttribute('aria-busy')).toBe('true'))
    expect(within(dialog).getByTestId('dialog-live').textContent).toBe('Loading chart')
    release()
    await waitFor(() => expect(region.getAttribute('aria-busy')).toBeNull())
    expect(within(dialog).getByTestId('dialog-live').textContent).toBe('')
  })

  it('the chart fills the dialog height, ahead of the breakdown; tile charts keep their size', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const breakdown = await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const chart = within(dialog).getByTestId('metric-chart')
    expect(chart.dataset.size).toBe('focus')
    expect(chart.className).toContain(FOCUS_CHART_HEIGHT)
    expect(chart.style.height).toBe('')
    expect(chart.compareDocumentPosition(breakdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The Overview behind the dialog is hidden from the accessibility tree.
    const tile = document.querySelector<HTMLElement>('article[aria-label="On-time delivery"] [data-testid="metric-chart"]')!
    expect(tile.dataset.size).toBe('tile')
    expect(tile.style.height).toBe('120px')
    expect(tile.className).not.toContain(FOCUS_CHART_HEIGHT)
  })

  it('the dialog has no axe violations', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    await within(dialog).findByRole('navigation', { name: 'Metrics' })
    expect((await axe(dialog)).violations).toEqual([])
  })

  it('does not open focus when a chart point is clicked; empty card space sets focus', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: /Oct: 84\.3%/ }))
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    await user.click(card)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('a range strip under the chart offers 3M, 6M, 12M, YTD and 24M, each with its own change; 12M is selected', async () => {
    renderRamp(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const strip = within(dialog).getByRole('group', { name: 'Range' })
    const ribbon = within(dialog).getByTestId('status-ribbon')
    expect(ribbon.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The breakdown follows the strip.
    expect(strip.compareDocumentPosition(within(dialog).getByRole('region', { name: 'Org breakdown' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const tabs = within(strip).getAllByRole('button')
    // One point a month up to October's 73.0%: Aug 71, May 68, Nov 62, Jan 64. 24 months are not loaded yet.
    expect(tabs.map((t) => t.textContent)).toEqual(['3M▲+2.0 pts', '6M▲+5.0 pts', '12M▲+11.0 pts', 'YTD▲+9.0 pts', '24M—'])
    // The arrow is decoration; the name carries the change in words.
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      '3M, change +2.0 pts',
      '6M, change +5.0 pts',
      '12M, change +11.0 pts',
      'YTD, change +9.0 pts',
      '24M, change not available',
    ])
    expect(tabs.map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false'])
    // Higher is better, so the rise reads as good.
    expect(tabs.slice(0, 4).map((t) => t.querySelector('[data-tone]')!.getAttribute('data-tone'))).toEqual(['good', 'good', 'good', 'good'])
    expect(within(dialog).queryByText('Period window')).toBeNull()
  })

  it('range strip has a caption and is hidden for a quarterly metric', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const strip = within(dialog).getByRole('group', { name: 'Range' })
    expect(strip.closest('[data-range-strip]')).toBeTruthy()
    expect(within(dialog).getByText('Change from the first month in each range to Oct 2026')).toBeTruthy()
  })

  it('a quarterly metric has no range strip', async () => {
    server.use(
      ...viewHandlers({
        respond: (u) => {
          const view = buildView(u.searchParams)
          for (const r of view.rows) if (r.metricKey === 'on_time_pct') r.frequency = 'quarterly'
          return HttpResponse.json(view)
        },
      }),
    )
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByTestId('metric-chart')
    expect(within(dialog).queryByRole('group', { name: 'Range' })).toBeNull()
    expect(within(dialog).queryByText(/^Change from the first month/)).toBeNull()
  })

  it('breakdown is a sortable table with scope buttons; vs goal column only with a percent target', async () => {
    const seen: URL[] = []
    server.use(...viewHandlers({ onView: (u) => seen.push(u) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const breakdown = await within(dialog).findByRole('region', { name: 'Org breakdown' })
    expect(within(breakdown).getByRole('heading', { level: 3, name: 'By unit' })).toBeTruthy()
    const table = within(breakdown).getByRole('table')
    expect(within(table).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Unit A', 'Unit B'])
    expect(within(table).getByRole('columnheader', { name: 'Oct' }).getAttribute('aria-sort')).toBe('ascending')
    expect(within(table).getByRole('columnheader', { name: 'vs goal 90.0%' })).toBeTruthy()
    await userEvent.setup().click(within(table).getByRole('button', { name: 'Unit A' }))
    await waitFor(() => expect(seen.some((u) => u.searchParams.getAll('subjects').includes('unit-a'))).toBe(true))
  })

  it('selecting 3M or YTD sets the chart to that range', async () => {
    renderRamp(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const user = userEvent.setup()
    const pointButtons = () => within(within(dialog).getByTestId('point-controls')).getAllByRole('button')
    expect(pointButtons()).toHaveLength(12)
    await user.click(within(dialog).getByRole('button', { name: /^3M/ }))
    expect(within(dialog).getByRole('button', { name: /^3M/ }).getAttribute('aria-pressed')).toBe('true')
    expect(pointButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Aug: 71.0%', 'Sep: 72.0%', 'Oct: 73.0%'])
    expect(within(dialog).getByTestId('status-ribbon').children).toHaveLength(3)
    // The fiscal year starts in January: YTD is Jan through Oct.
    await user.click(within(dialog).getByRole('button', { name: /^YTD/ }))
    expect(pointButtons()).toHaveLength(10)
    expect(pointButtons()[0]!.getAttribute('aria-label')).toBe('Jan: 64.0%')
  })

  it('number keys pick a range', async () => {
    renderRamp(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    within(dialog).getByRole('button', { name: /^Previous metric/ }).focus()
    await userEvent.setup().keyboard('1')
    expect(within(dialog).getByRole('button', { name: /^3M/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a range whose ends match says no change', async () => {
    server.use(
      ...viewHandlers({
        respond: (u) => {
          const view = buildView(u.searchParams)
          const oct = view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!.cells.find((c) => c.period === '2026-M10')!
          Object.assign(oct, { value: 95, display: '95.0%' })
          return HttpResponse.json(view)
        },
      }),
    )
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const tab = within(dialog).getByRole('button', { name: /^3M/ })
    expect(tab.getAttribute('aria-label')).toBe('3M, no change')
    expect(tab.textContent).toBe('3MNo change')
    expect(tab.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('neutral')
  })

  it('YTD starts at the fiscal year start: with a July start, Jul through Oct', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ ...meFor('admin'), tenant: { ...tenant, fiscalYearStartMonth: 7 } })),
    )
    // Fiscal 2027-M04 is October 2026 with a July start.
    renderRamp('/scorecards/sc-main/overview?period=2027-M04&focus=on_time_pct')
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const ytd = within(dialog).getByRole('button', { name: /^YTD/ })
    // Fiscal 2027-M01 (Jul) is 76.0%, M04 (Oct) 79.0%; 12M runs from 2026-M05, 68.0%.
    expect(ytd.getAttribute('aria-label')).toBe('YTD, change +3.0 pts')
    expect(within(dialog).getByRole('button', { name: /^12M/ }).getAttribute('aria-label')).toBe('12M, change +11.0 pts')
    await userEvent.setup().click(ytd)
    const buttons = within(within(dialog).getByTestId('point-controls')).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Jul: 76.0%', 'Aug: 77.0%', 'Sep: 78.0%', 'Oct: 79.0%'])
  })

  it.each(['2026-Q3', '2026-H2', '2026-FY'])('%s: no range strip outside month periods', async (p) => {
    renderOverview(`/scorecards/sc-main/overview?period=${p}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByTestId('metric-chart')
    expect(within(dialog).queryByRole('group', { name: 'Range' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /^24M/ })).toBeNull()
  })

  it('24M asks for this metric only and keeps focus on the tab while it loads; its change stays known', async () => {
    const seen: URL[] = []
    server.use(...viewHandlers({ onView: (u) => seen.push(u), respond: (u) => HttpResponse.json(ramp(buildView(u.searchParams))) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    expect(seen.some((u) => u.searchParams.has('metrics'))).toBe(false)
    const user = userEvent.setup()
    const toggle = within(dialog).getByRole('button', { name: /^24M/ })
    await user.click(toggle)
    expect(document.activeElement).toBe(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    await waitFor(() => expect(within(dialog).getAllByRole('button', { name: /^Sep: / })).toHaveLength(2))
    const req = seen.find((u) => u.searchParams.has('metrics'))
    expect(req?.searchParams.getAll('metrics')).toEqual(['on_time_pct'])
    expect(req?.searchParams.getAll('periods')).toHaveLength(24)
    expect(document.activeElement).toBe(toggle)
    // With 24 months loaded, the 24M change is known: Nov 2024 was 50.0%.
    expect(toggle.getAttribute('aria-label')).toBe('24M, change +23.0 pts')
    // It stays known after picking a shorter range.
    await user.click(within(dialog).getByRole('button', { name: /^3M/ }))
    await waitFor(() => expect(within(within(dialog).getByTestId('point-controls')).getAllByRole('button')).toHaveLength(3))
    expect(within(dialog).getByRole('button', { name: /^24M/ }).getAttribute('aria-label')).toBe('24M, change +23.0 pts')
    expect(within(dialog).getByRole('button', { name: /^3M/ }).getAttribute('aria-label')).toBe('3M, change +2.0 pts')
  })

  it('a failed 24-month request says so and offers Try again', async () => {
    server.use(
      ...viewHandlers({
        respond: (u) =>
          u.searchParams.has('metrics')
            ? HttpResponse.json({ code: 'internal', message: 'The server had a problem.' }, { status: 500 })
            : undefined,
      }),
    )
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    await userEvent.setup().click(within(dialog).getByRole('button', { name: /^24M/ }))
    const alert = await within(dialog).findByRole('alert', {}, { timeout: 4000 })
    expect(alert.textContent).toMatch(/couldn’t load this chart/)
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    // The strip stays, so another range is one click away.
    expect(within(dialog).getByRole('button', { name: /^24M/ })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /^12M/ })).toBeTruthy()
  })

  it('an item-only metric shows the worst of its services and lists them without scope buttons', async () => {
    server.use(...viewHandlers({ respond: (u) => HttpResponse.json(addServiceUptime(buildView(u.searchParams))) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=svc_uptime` })
    const dialog = await screen.findByRole('dialog', { name: /Service uptime/i })
    expect(await within(dialog).findByText('worst of 2 services')).toBeTruthy()
    const breakdown = within(dialog).getByRole('region', { name: 'Org breakdown' })
    expect(within(breakdown).getByText('Web service')).toBeTruthy()
    expect(within(breakdown).queryByRole('button', { name: 'Web service' })).toBeNull()
    expect(within(breakdown).queryByRole('button', { name: 'API service' })).toBeNull()
  })

  it('exports a slide-ready SVG that names the metric, scope, period range and version', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob)
      return 'blob:svg'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      renderOverview(`${OVERVIEW}&scope=unit-a&restate=ver-2&focus=on_time_pct`)
      const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
      await within(dialog).findByTestId('metric-chart')
      // The control bar names the restated version once the versions have loaded.
      await screen.findByText('Restated under FY27 proposal')
      const { user, menu } = await openMore(dialog)
      await user.click(within(menu).getByRole('menuitem', { name: 'Export SVG' }))
      await waitFor(() => expect(blobs).toHaveLength(1))
      const doc = new DOMParser().parseFromString(await blobs[0]!.text(), 'image/svg+xml')
      expect(doc.querySelector('[data-role="title"]')?.textContent).toBe('On-time delivery')
      expect(doc.querySelector('[data-role="subtitle"]')?.textContent).toBe(
        'Unit A · Nov 2025 – Oct 2026 · restated under FY27 proposal',
      )
      expect(doc.querySelectorAll('[data-role="x-label"]')).toHaveLength(12)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('says so in plain words when the PNG cannot be made', async () => {
    class FailingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    vi.stubGlobal('Image', FailingImage)
    try {
      renderOverview(`${OVERVIEW}&focus=on_time_pct`)
      const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
      await within(dialog).findByRole('region', { name: 'Org breakdown' })
      const { user, menu } = await openMore(dialog)
      await user.click(within(menu).getByRole('menuitem', { name: 'Export PNG' }))
      expect((await within(dialog).findByRole('alert')).textContent).toBe('We couldn’t make the image. Try SVG or CSV.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('closing after a card background click returns focus to that card’s Expand button', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    await user.click(metricCard('On-time delivery'))
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(within(metricCard('On-time delivery')).getByRole('button', { name: 'Expand' }))
  })
})
