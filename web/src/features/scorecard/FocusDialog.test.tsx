import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import type { components } from '../../api/schema'
import { meFor, tenant } from '../../test/fixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addServiceUptime, buildView, viewHandlers } from '../../test/viewFixtures'
import { FOCUS_CHART_HEIGHT } from './charts/MetricChart'

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
    expect(screen.queryByRole('button', { name: 'Next metric' })).toBeNull()
  })

  it('Next moves to the following metric in layout order', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Next metric' }))
    expect(await screen.findByRole('dialog', { name: /Defect rate/i })).toBeTruthy()
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

  it('View as table links to /table without focus in the query', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    for (const link of within(dialog).getAllByRole('link', { name: 'View as table' })) {
      const href = link.getAttribute('href') ?? ''
      expect(href).toContain('/scorecards/sc-main/table')
      expect(href).not.toContain('focus=')
    }
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
    // Nothing visible between the ribbon and the strip, and the breakdown follows.
    const links = within(dialog).getAllByRole('link', { name: 'View as table' })
    expect(links).toHaveLength(1)
    expect(strip.compareDocumentPosition(links[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    expect(within(breakdown).queryByRole('button')).toBeNull()
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
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Export SVG' }))
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
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Export PNG' }))
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
