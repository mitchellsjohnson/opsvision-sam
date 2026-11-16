import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { monthLabel, parsePeriod } from '../../lib/period'
import { meFor, orgUnits, tenant } from '../../test/fixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import {
  addQuarterly,
  addServiceUptime,
  buildView,
  QUARTERLY_VALUES,
  quarterlyVersions,
  UPTIME_ITEMS,
  versions,
  viewHandlers,
} from '../../test/viewFixtures'

type ScorecardView = components['schemas']['ScorecardView']
type Cell = components['schemas']['Cell']

const ROUTE = '/scorecards/sc-main/overview?period=2026-M10'

function renderOverview(route = ROUTE, edit?: (view: ScorecardView) => void) {
  server.use(
    ...viewHandlers({
      respond: edit
        ? (u) => {
            const view = buildView(u.searchParams)
            edit(view)
            return HttpResponse.json(view)
          }
        : undefined,
    }),
  )
  return renderApp(<App />, { route })
}

function cellOf(view: ScorecardView, metric: string, subject: string, period: string): Cell {
  const row = view.rows.find((r) => r.metricKey === metric && r.subjectId === subject)
  const cell = row?.cells.find((c) => c.period === period && !c.ytd)
  if (!cell) throw new Error(`no cell for ${metric} ${subject} ${period}`)
  return cell
}

function metricCard(name: string): HTMLElement {
  return screen.getByRole('article', { name: new RegExp(name) })
}

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom; tests that need it add it.
  delete window.matchMedia
})

describe('OverviewPage', () => {
  it('a ratio metric renders its chart summary with the status letter', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    const summary = within(card).getByText(/On-time delivery.*84\.3%.*status Y/i)
    expect(summary.className).toContain('sr-only')
  })

  it('with no company value and two child segments shows worst of 2 segments and counts it in health', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), {
        value: null,
        display: '',
        status: '',
        naReason: '',
        components: {},
      })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(within(screen.getByTestId('ribbon-on_time_pct').parentElement!).getByText('worst of 2 segments')).toBeTruthy()
    expect(
      within(within(screen.getByRole('region', { name: 'Needs attention' })).getByRole('listitem')).getByText('worst of 2 segments'),
    ).toBeTruthy()
    const card = metricCard('On-time delivery')
    expect(within(card).getByText('Company total not reported; 2 segments reported')).toBeTruthy()
    expect(within(card).getByText('R')).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Oct: 70\.0%/ })).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Oct: 95\.0%/ })).toBeTruthy()
    const health = screen.getByRole('region', { name: 'Health this month' })
    const offTrack = within(health).getByRole('button', { name: /Off track/ })
    expect(offTrack.textContent).toMatch(/1\b/)
  })

  it('clicking Off track leaves only off-track metric cards', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), {
        value: 60,
        display: '60.0%',
        status: 'R',
        naReason: '',
      })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('region', { name: 'Health this month' })).getByRole('button', { name: /Off track/ }))
    expect(screen.getByRole('article', { name: /On-time delivery/ })).toBeTruthy()
    expect(screen.queryByRole('article', { name: /Defect rate/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Clear health filter/ })).toBeTruthy()
  })

  it('shows not applicable and missing as different text', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'defect_rate', 'root', '2026-M09'), {
        value: null,
        display: '',
        status: '',
        naReason: '',
      })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const defect = metricCard('Defect rate')
    // The point button and the status ribbon both say so.
    expect(within(defect).getAllByText('n/a')).toHaveLength(2)
    expect(within(defect).getByRole('button', { name: 'Sep: no data' })).toBeTruthy()
  })

  it('with year to date on shows the secondary YTD figure on cards', async () => {
    renderOverview(`${ROUTE}&ytd=1`)
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    await waitFor(() => expect(within(card).getByText(/YTD 95\.0%/)).toBeTruthy())
  })

  it('tints each band with the status the engine gives its values', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), {
        rule: {
          type: 'bands',
          bands: [
            { status: 'G', op: '>=', value: 90 },
            { status: 'Y', op: '>=', value: 80 },
            { status: 'R', op: '', value: 0 },
          ],
        },
      })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const chart = within(metricCard('On-time delivery')).getByTestId('metric-chart')
    const bands = (chart.getAttribute('data-bands') ?? '').split(' ').map((b) => {
      const [status, range] = b.split(':')
      const [y0, y1] = (range ?? '').split('-').map(Number)
      return { status, y0, y1 }
    })
    expect(bands.map((b) => b.status)).toEqual(['Y', 'G'])
    expect(bands[0]!.y1).toBe(90)
    expect(bands[1]!.y0).toBe(90)
    // The value row carries the current value; the tile has no separate Current line.
    expect(within(metricCard('On-time delivery')).queryByTestId('current-point-label')).toBeNull()
    expect(within(metricCard('On-time delivery')).getByTestId('header-value').textContent).toBe('84.3%')
  })

  it('a metric card shows its change once, beside the value', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    expect(within(card).getAllByText(/\+2\.1 pts vs Sep/)).toHaveLength(1)
    expect(within(card).getByTestId('header-change').textContent).toBe('▲ +2.1 pts vs Sep')
  })

  it('omits YTD on the card when the scope row has no YTD value', async () => {
    renderOverview(`${ROUTE}&ytd=1`, (view) => {
      const row = view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')
      const ytd = row?.cells.find((c) => c.ytd)
      if (ytd) Object.assign(ytd, { value: null, display: '', status: '' })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    expect(within(card).queryByText(/^YTD /)).toBeNull()
  })

  it('uptime rows show a status marker for each period in the window', async () => {
    renderOverview(ROUTE, (view) => {
      for (const row of view.rows.filter((r) => r.metricKey === 'on_time_pct')) {
        row.chartKind = 'uptime'
      }
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    const strip = within(card).getByTestId('uptime-strip-unit-a')
    expect(strip.children.length).toBe(12)
    // Twelve markers wrap rather than push a phone-width page sideways.
    expect(strip.className).toContain('flex-wrap')
  })

  it('needs-attention cards show status, value, change, a trend and Expand; Driver names an off-track child', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const needs = screen.getByRole('region', { name: 'Needs attention' })
    const item = within(needs).getByRole('listitem')
    expect(within(item).getByRole('img', { name: /Status: / }).textContent).toBe('Y')
    expect(within(item).getByText('84.3%')).toBeTruthy()
    expect(within(item).getByText(/\+2\.1 pts vs Sep/)).toBeTruthy()
    expect(within(item).getByTestId('sparkline-graphic')).toBeTruthy()
    expect(within(item).getByText('Driver: Unit A')).toBeTruthy()
    const user = userEvent.setup()
    await user.click(within(item).getByRole('button', { name: 'Expand On-time delivery' }))
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('a needs-attention card names no driver when no child is off track', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'unit-a', '2026-M10'), { status: 'Y' })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const item = within(screen.getByRole('region', { name: 'Needs attention' })).getByRole('listitem')
    expect(within(item).queryByText(/Driver/)).toBeNull()
  })

  it('the 12-month status widget uses the shared rule for each column', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), {
        value: null,
        display: '',
        status: '',
        naReason: '',
        components: {},
      })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const ribbon = screen.getByTestId('ribbon-on_time_pct')
    const cells = within(ribbon).getAllByRole('button')
    expect(cells).toHaveLength(12)
    expect(cells.at(-1)!.textContent).toBe('R')
    expect(cells.at(-1)!.getAttribute('aria-label')).toBe('On-time delivery, Oct 2026: Red, worst of 2 segments')
    expect(cells.at(-2)!.textContent).toBe('G')
  })

  it('the status board is a grid of the trend window; a cell opens its metric full screen', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const grid = screen.getByRole('grid', { name: '12-month status' })
    expect(within(grid).getByRole('columnheader', { name: 'Oct' }).hasAttribute('data-selected')).toBe(true)
    expect(within(grid).getByRole('rowheader', { name: 'On-time delivery' })).toBeTruthy()
    const user = userEvent.setup()
    const cell = within(grid).getByRole('button', { name: 'On-time delivery, Oct 2026: Yellow, 84.3%, up 2.1 pts vs Sep' })
    await user.click(cell)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(cell))
    // Focus handed back on close does not pop the cell's tooltip.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('the overview, status board included, has no axe violations', async () => {
    const { container } = renderOverview()
    await screen.findByRole('grid', { name: '12-month status' })
    expect((await axe(container)).violations).toEqual([])
  })

  it('an item-only metric shows the worst of its services, not one service as the company', async () => {
    renderOverview(ROUTE, (view) => {
      addServiceUptime(view)
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('Service uptime')
    expect(within(card).getByText('worst of 2 services')).toBeTruthy()
    expect(within(card).getByText(/Service uptime: no data, status R/)).toBeTruthy()
    expect(within(card).queryByText(/^Company total not reported/)).toBeNull()
    expect(within(card).getByTestId('uptime-strip-svc-api')).toBeTruthy()
    expect(within(card).getByTestId('uptime-strip-svc-web')).toBeTruthy()
  })

  describe('under a scope', () => {
    // Team A1 sits under Unit A and has the Web service; Unit B has no services.
    function scoped(scope: string, seen: URL[] = []) {
      const uptime = versions.map((v) =>
        v.id !== 'ver-1'
          ? v
          : {
              ...v,
              content: {
                ...v.content,
                metrics: [
                  ...v.content.metrics,
                  {
                    ...v.content.metrics[0]!,
                    key: 'svc_uptime',
                    name: 'Service uptime',
                    format: 'percent2' as const,
                    reportedAt: [{ kind: 'item_kind' as const, id: 'service' }],
                  },
                ],
              },
            },
      )
      server.use(
        // Before viewHandlers: the first matching handler answers.
        http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: uptime })),
        ...viewHandlers({
          onView: (u) => seen.push(u),
          respond: (u) => HttpResponse.json(addServiceUptime(buildView(u.searchParams), u.searchParams.getAll('subjects'))),
        }),
        http.get(`${API}/v1/org/units`, () =>
          HttpResponse.json({
            units: [...orgUnits, { id: 'team-a1', name: 'Team A1', levelId: 'l2', parentId: 'unit-a', sourceKeys: [] }],
          }),
        ),
        http.get(`${API}/v1/items`, () => HttpResponse.json({ items: UPTIME_ITEMS })),
      )
      renderApp(<App />, { route: `${ROUTE}&scope=${scope}` })
    }

    it("an item-only metric shows the worst of the subtree's services, which the request asks for", async () => {
      const seen: URL[] = []
      scoped('unit-a', seen)
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('Service uptime')
      expect(within(card).getByText('worst of 1 service')).toBeTruthy()
      expect(within(card).getByTestId('uptime-strip-svc-web')).toBeTruthy()
      expect(within(card).queryByTestId('uptime-strip-svc-api')).toBeNull()
      expect(seen).toHaveLength(1)
      expect(seen[0]!.searchParams.getAll('subjects')).toEqual(['unit-a', 'team-a1', 'svc-web'])
    })

    it('an item-only metric is Not reported when the subtree has no services', async () => {
      scoped('unit-b')
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const notReported = await screen.findByRole('region', { name: /^Not reported for Oct 2026/ })
      await waitFor(() => expect(within(notReported).getByRole('rowheader', { name: 'Service uptime' })).toBeTruthy())
      expect(screen.queryByRole('article', { name: /Service uptime/ })).toBeNull()
      expect(within(screen.getByRole('region', { name: 'Health this month' })).getByText(/Not reported \d/)).toBeTruthy()
    })
  })

  it('each uptime square has a per-period accessible name', async () => {
    renderOverview(ROUTE, (view) => {
      addServiceUptime(view)
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const strip = within(metricCard('Service uptime')).getByTestId('uptime-strip-svc-web')
    const squares = within(strip).getAllByRole('img')
    expect(squares).toHaveLength(12)
    expect(squares.at(-1)!.getAttribute('aria-label')).toMatch(/^Oct\w* 2026: 99\.20%, status R/)
    expect(squares.at(-2)!.getAttribute('aria-label')).toMatch(/^Sep\w* 2026: 99\.90%, status G/)
  })

  describe('a quarterly metric', () => {
    function renderQuarterly(values?: Parameters<typeof addQuarterly>[1]) {
      server.use(
        http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: quarterlyVersions })),
        ...viewHandlers({ respond: (u) => HttpResponse.json(addQuarterly(buildView(u.searchParams), values)) }),
      )
      return renderApp(<App />, { route: ROUTE })
    }

    it('reported for Q3: counted once in Health, not listed as not reported, named in the quiet line', async () => {
      renderQuarterly()
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const health = screen.getByRole('region', { name: 'Health this month' })
      expect(within(health).getByRole('button', { name: /On track/ }).textContent).toBe('On track 1')
      expect(within(health).getByRole('button', { name: /Watch/ }).textContent).toBe('Watch 1')
      expect(within(health).getByText('Not reported 1')).toBeTruthy()
      const listed = screen.getByRole('region', { name: /^Not reported for Oct 2026/ })
      const defect = within(listed).getByRole('rowheader', { name: 'Defect rate' }).closest('tr')!
      expect(within(defect).getByText('Not applicable: Not measured this month')).toBeTruthy()
      expect(within(defect).getByText('Quality')).toBeTruthy()
      expect(within(listed).queryByRole('rowheader', { name: /Concepts/ })).toBeNull()
      expect(
        screen.getByText('Reported less often and up to date: Concepts delivered expected value (Q3 FY2026; Q4 due by Jan).'),
      ).toBeTruthy()
    })

    it('overdue in Nov: listed as not reported with when it was due', async () => {
      server.use(
        http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: quarterlyVersions })),
        ...viewHandlers({
          respond: (u) => HttpResponse.json(addQuarterly(buildView(u.searchParams), { '2026-Q2': QUARTERLY_VALUES['2026-Q2']! })),
        }),
      )
      renderApp(<App />, { route: '/scorecards/sc-main/overview?period=2026-M11' })
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const listed = screen.getByRole('region', { name: /^Not reported for Nov 2026/ })
      const row = within(listed).getByRole('rowheader', { name: 'Concepts delivered expected value' }).closest('tr')!
      expect(within(row).getByText('Q3 FY2026 overdue (due by Oct 2026)')).toBeTruthy()
      expect(screen.queryByText(/^Reported less often/)).toBeNull()
    })

    it('the board puts Q3 in Sep and leaves the other months not due, with no dot', async () => {
      renderQuarterly()
      const grid = await screen.findByRole('grid', { name: '12-month status' })
      const ribbon = within(grid).getByTestId('ribbon-concepts_value')
      const sep = within(ribbon).getByRole('button', { name: 'Concepts delivered expected value, Sep 2026: Green, 90%' })
      expect(sep.textContent).toBe('G')
      for (const month of ['Jul', 'Aug', 'Oct']) {
        const cell = within(ribbon).getByRole('button', { name: `Concepts delivered expected value, ${month} 2026: Not due` })
        expect(cell.querySelector('[data-dot]')).toBeNull()
        expect(cell.textContent).toBe('')
      }
      expect(within(ribbon).getByText('90%')).toBeTruthy()
      expect(within(ribbon).getByText('Q3 FY2026')).toBeTruthy()
    })

    it('the quarterly tile charts its quarters, with Q3 as the current value', async () => {
      renderQuarterly()
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('Concepts delivered expected value')
      expect(within(card).getByTestId('header-value').textContent).toBe('90%')
      expect(within(card).getByText(/Concepts delivered expected value: 90%, status G/)).toBeTruthy()
    })

    it('the quarterly tile gets quarter columns, not months', async () => {
      renderQuarterly()
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('Concepts delivered expected value')
      const points = within(card)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((n) => /^(Q\d|[A-Z][a-z]{2}): /.test(n))
      expect(points).toEqual(['Q4: 70%', 'Q1: 75%', 'Q2: 85%', 'Q3: 90%'])
      expect(within(card).getByText(/^Reported quarterly · /)).toBeTruthy()
    })
  })

  describe('frame', () => {
    function blankCells(view: ScorecardView, metric: string, periods?: string[]) {
      for (const row of view.rows.filter((r) => r.metricKey === metric)) {
        for (const c of row.cells) {
          if (periods && !periods.includes(c.period)) continue
          Object.assign(c, { value: null, display: '', status: '', naReason: '', components: {}, change: null, changeKind: '' })
        }
      }
    }

    it('renders the title, header and a busy page skeleton before the view loads', async () => {
      server.use(
        // Before viewHandlers, so it answers first: the view never arrives.
        http.get(`${API}/v1/scorecards/sc-main/view`, async () => {
          await new Promise(() => {})
          return HttpResponse.json({})
        }),
        ...viewHandlers(),
      )
      renderApp(<App />, { route: ROUTE })
      const status = await screen.findByText('Loading overview')
      // The title is drawn at once; the h1 waits for content.
      expect(screen.getByText('Overview', { selector: 'p' }).getAttribute('aria-hidden')).toBe('true')
      expect(screen.queryByRole('heading', { name: 'Overview', level: 1 })).toBeNull()
      expect(status.getAttribute('role')).toBe('status')
      expect(status.className).toContain('sr-only')
      const busy = status.closest('[aria-busy="true"]')
      expect(busy).toBeTruthy()
      expect(busy!.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(2)
      expect(screen.queryByText(/Loading overview…/)).toBeNull()
      expect(screen.getByRole('button', { name: 'Customize layout' })).toBeTruthy()
    })

    it('section headers carry the roll-up in the tenant’s labels', async () => {
      server.use(
        http.get(`${API}/v1/me`, () =>
          HttpResponse.json({
            ...meFor('admin'),
            tenant: {
              ...tenant,
              statusScale: [
                { key: 'G', label: 'On track', color: '#137A3A', rank: 1 },
                { key: 'Y', label: 'Watch', color: '#8A5A00', rank: 2 },
                { key: 'R', label: 'Off track', color: '#B42318', rank: 3 },
              ],
            },
          }),
        ),
      )
      renderOverview(ROUTE, (view) => {
        addServiceUptime(view)
      })
      await screen.findByRole('article', { name: /Service uptime/ })
      const heading = screen.getAllByRole('heading', { level: 2 }).find((h) => h.textContent === 'Delivery')!
      const header = heading.closest<HTMLElement>('[data-section-header]')!
      await waitFor(() => expect(header.textContent).toBe('Delivery◆ 1 Off track · ▲ 1 Watch'))
      expect(header.className).toContain('border-b')
      expect(header.textContent).not.toMatch(/1R|1Y/)
    })

    it('a tile under its own section has no category eyebrow; moved under another, it keeps one', async () => {
      server.use(
        http.get(`${API}/v1/me/layouts/:sc`, () =>
          HttpResponse.json({
            items: [
              { id: 'widget:health', size: 'wide', hidden: false },
              { id: 'section:delivery', size: 'wide', hidden: false },
              { id: 'metric:on_time_pct', size: 'small', hidden: false },
              { id: 'metric:defect_rate', size: 'small', hidden: false },
              { id: 'section:quality', size: 'wide', hidden: false },
            ],
            revision: 1,
            source: 'user',
            defaultRevision: 0,
          }),
        ),
      )
      renderOverview()
      await screen.findByRole('article', { name: /Defect rate/ })
      const eyebrowOf = (tile: HTMLElement) => tile.closest('[data-layout-item]')!.querySelector('[data-eyebrow]')
      // The saved layout arrives after the view; tiles move once it does.
      await waitFor(() => expect(eyebrowOf(metricCard('Defect rate'))?.textContent).toBe('Quality'))
      expect(eyebrowOf(metricCard('On-time delivery'))).toBeNull()
    })

    it('a tile is an article with an h3, the threshold line and an Expand icon; no table link or Current line', async () => {
      renderOverview(ROUTE, (view) => {
        Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), {
          rule: {
            type: 'bands',
            bands: [
              { status: 'G', op: '>=', value: 90 },
              { status: 'Y', op: '>=', value: 80 },
              { status: 'R', op: '', value: 0 },
            ],
          },
        })
      })
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('On-time delivery')
      expect(within(card).getByRole('heading', { level: 3, name: 'On-time delivery' })).toBeTruthy()
      expect(within(card).getByText('Green at 90.0% or better · Red below 80.0%')).toBeTruthy()
      expect(within(card).queryByRole('link', { name: 'View as table' })).toBeNull()
      expect(within(card).queryByText(/Current:/)).toBeNull()
      const user = userEvent.setup()
      const expand = within(card).getByRole('button', { name: 'Expand On-time delivery' })
      await user.click(expand)
      expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(document.activeElement).toBe(expand))
    })

    it('stopped reporting: the last value as history, with when it stopped', async () => {
      renderOverview(ROUTE, (view) => blankCells(view, 'on_time_pct', ['2026-M09', '2026-M10']))
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('On-time delivery')
      expect(within(card).getByTestId('header-value').textContent).toBe('95.0%')
      expect(within(card).getByText('Last reported Aug 2026')).toBeTruthy()
      expect(within(card).getByText('· nothing for Sep–Oct')).toBeTruthy()
      expect(within(card).getByRole('button', { name: 'Expand On-time delivery' })).toBeTruthy()
      const listed = screen.getByRole('region', { name: /^Not reported for Oct 2026/ })
      expect(within(listed).getByText('Last reported Aug 2026 (95.0%)')).toBeTruthy()
    })

    it('no reports in the window: no plot and no Expand, an entry link for admins', async () => {
      renderOverview(ROUTE, (view) => blankCells(view, 'on_time_pct'))
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('On-time delivery')
      expect(within(card).getByText('No reports in the last 12 months')).toBeTruthy()
      expect(within(card).getByText(/^Nothing has been entered for Nov 2025 – Oct 2026\. Measured monthly/)).toBeTruthy()
      expect(within(card).queryByRole('button', { name: /Expand/ })).toBeNull()
      expect(within(card).queryByTestId('metric-chart')).toBeNull()
      expect(within(card).getByRole('link', { name: 'Enter Oct 2026 data ›' }).getAttribute('href')).toBe('/entry?period=2026-M10')
    })
  })

  it('shows the period header sentence', async () => {
    renderOverview()
    const fy = 1
    const parsed = parsePeriod('2026-M10')!
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(screen.getByText(new RegExp(`${monthLabel(parsed, fy)}.*All of Example Co`))).toBeTruthy()
  })
})
