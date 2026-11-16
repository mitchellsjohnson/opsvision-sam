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
  return metricTile(name)
}

/** The metric tile (not the needs-attention card) of a metric, or null. */
function queryTile(name: string): HTMLElement | null {
  return screen.queryAllByRole('article', { name: new RegExp(name) }).find((a) => a.closest('[data-layout-item^="metric:"]')) ?? null
}

function metricTile(name: string): HTMLElement {
  const tile = queryTile(name)
  if (!tile) throw new Error(`no tile for ${name}`)
  return tile
}

/** ver-1 with `svc_uptime` reported for the `service` item kind, and that kind's name. */
const uptimeVersions = versions.map((v) =>
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
              rule: {
                type: 'bands' as const,
                bands: [
                  { status: 'G', op: '>=', value: 99.9 },
                  { status: 'Y', op: '>', value: 99.8 },
                  { status: 'R', op: '', value: 0 },
                ],
              },
            },
          ],
        },
      },
)

function uptimeHandlers() {
  return [
    // Before viewHandlers: the first matching handler answers.
    http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: uptimeVersions })),
    http.get(`${API}/v1/item-kinds`, () => HttpResponse.json({ itemKinds: [{ id: 'service', name: 'Services' }] })),
    http.get(`${API}/v1/items`, () => HttpResponse.json({ items: UPTIME_ITEMS })),
  ]
}

function renderUptime(route = ROUTE) {
  server.use(...uptimeHandlers(), ...viewHandlers({ respond: (u) => HttpResponse.json(addServiceUptime(buildView(u.searchParams))) }))
  return renderApp(<App />, { route })
}

/** Appends company-only metrics in Delivery that have been Red (60%) all window. */
function addRed(view: ScorecardView, count: number) {
  const base = view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
  for (let i = 1; i <= count; i++) {
    const key = `red_${i}`
    view.rows.push({
      ...base,
      metricKey: key,
      metricName: `Red metric ${i}`,
      cells: base.cells.map((c) => ({ ...c, metricKey: key, value: 60, display: '60.0%', status: 'R', change: null, changeKind: '' })),
    })
  }
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
    const card = metricTile('On-time delivery')
    expect(within(card).getByText('Company total not reported; 2 segments reported')).toBeTruthy()
    // The value row leads with the worst segment (§7.6).
    const valueRow = within(card).getByTestId('header-value').parentElement!
    expect(within(valueRow).getByText('Worst')).toBeTruthy()
    expect(within(valueRow).getByText('Unit A')).toBeTruthy()
    expect(within(card).getByTestId('header-value').textContent).toBe('70.0%')
    expect(within(valueRow).getByText('1 of 2 segments Red')).toBeTruthy()
    expect(within(card).getByText('R')).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Oct: 70\.0%/ })).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Oct: 95\.0%/ })).toBeTruthy()
    const health = screen.getByRole('region', { name: 'Health this month' })
    expect(within(health).getByRole('button', { name: /^Red: 1 metric, up 1 since Sep$/ })).toBeTruthy()
  })

  it('pressing Red leaves only Red metric tiles; pressing it again shows them all', async () => {
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
    const red = within(screen.getByRole('region', { name: 'Health this month' })).getByRole('button', { name: /^Red:/ })
    await user.click(red)
    expect(red.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(red)
    expect(screen.getByTestId('health-live').textContent).toBe('Showing 1 Red metric')
    expect(metricTile('On-time delivery')).toBeTruthy()
    expect(screen.queryByRole('article', { name: /Defect rate/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Clear health filter/ })).toBeNull()
    await user.click(red)
    expect(red.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('article', { name: /Defect rate/ })).toBeTruthy()
  })

  it('a Health filter shows where it was pressed: the board filters, empty sections go, and a Showing line clears it', async () => {
    renderOverview(ROUTE, (view) => {
      Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), { value: 60, display: '60.0%', status: 'R', naReason: '' })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(screen.getByRole('heading', { name: 'Quality', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
    const user = userEvent.setup()
    const red = within(screen.getByRole('region', { name: 'Health this month' })).getByRole('button', { name: /^Red:/ })
    await user.click(red)

    const board = screen.getByRole('region', { name: '12-month status · Red only' })
    expect(within(board).getAllByText('On-time delivery').length).toBeGreaterThan(0)
    expect(within(board).queryByText('Defect rate')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Delivery', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Quality', level: 2 })).toBeNull()

    const showAll = screen.getByRole('button', { name: 'Show all' })
    expect(showAll.parentElement!.textContent).toBe('Showing 1 Red metric·Show all')
    await user.click(showAll)
    expect(red.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(red)
    expect(screen.getByRole('region', { name: '12-month status' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Quality', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
  })

  it('Health counts each metric once in the scale’s labels, with a proportion bar and the change since the prior month', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const health = screen.getByRole('region', { name: 'Health this month' })
    expect(within(health).getByText('2 metrics · Oct 2026')).toBeTruthy()
    expect(within(health).getByRole('img', { name: '1 Yellow, 1 Not reported of 2 metrics' })).toBeTruthy()
    expect(within(within(health).getByRole('group', { name: 'Show metrics by status' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Red: 0 metrics, no change since Sep',
      'Yellow: 1 metric, up 1 since Sep',
      'Green: 0 metrics, down 1 since Sep',
      'Not reported: 1 metric, no change since Sep',
    ])
    expect(within(health).getByTestId('health-since').textContent).toBe('Since Sep: 1 more Yellow, 1 fewer Green')
    expect(within(health).queryByText(/On track|Off track|Watch/)).toBeNull()
  })

  it('Not reported is a real filter (?health=none)', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    await userEvent.setup().click(screen.getByRole('button', { name: /^Not reported:/ }))
    expect(queryTile('Defect rate')).toBeTruthy()
    expect(queryTile('On-time delivery')).toBeNull()
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

  it('a money-plan tile reads the value as of plan, with what was spent of what was planned', async () => {
    const spendVersions = versions.map((v) =>
      v.id !== 'ver-1'
        ? v
        : {
            ...v,
            content: {
              ...v.content,
              measures: [...v.content.measures.map((m) => ({ ...m, unit: '$k' }))],
              metrics: v.content.metrics.map((m) => (m.key === 'on_time_pct' ? { ...m, formula: 'closed / total * 100' } : m)),
            },
          },
    )
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: spendVersions })),
      ...viewHandlers({
        respond: (u) => {
          const view = buildView(u.searchParams)
          for (const row of view.rows.filter((r) => r.metricKey === 'on_time_pct')) row.chartKind = 'money_plan'
          Object.assign(cellOf(view, 'on_time_pct', 'root', '2026-M10'), { value: 104, display: '104%', components: { closed: 1150, total: 1000 } })
          return HttpResponse.json(view)
        },
      }),
    )
    renderApp(<App />, { route: ROUTE })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const row = within(metricTile('On-time delivery')).getByTestId('header-value').parentElement!
    expect(within(row).getByText('of plan')).toBeTruthy()
    await waitFor(() => expect(within(row).getByText('$1,150k spent of $1,000k planned')).toBeTruthy())
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

  it('an uptime metric reported for units only charts its scope as a line with a ribbon', async () => {
    renderOverview(ROUTE, (view) => {
      for (const row of view.rows.filter((r) => r.metricKey === 'on_time_pct')) {
        row.chartKind = 'uptime'
      }
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    expect(within(card).queryByTestId('uptime-strip-unit-a')).toBeNull()
    expect(within(card).getByTestId('metric-chart')).toBeTruthy()
    expect(within(card).getByTestId('status-ribbon').children).toHaveLength(12)
  })

  it('a metric with no company total in any month says so, and leads with its worst segment', async () => {
    renderOverview(ROUTE, (view) => {
      const root = view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
      for (const c of root.cells) Object.assign(c, { value: null, display: '', status: '', naReason: '', components: {} })
    })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricTile('On-time delivery')
    expect(within(card).getByText('2 segments · no company total')).toBeTruthy()
    expect(within(card).queryByText(/^Company total not reported/)).toBeNull()
    expect(within(within(card).getByTestId('header-value').parentElement!).getByText('Unit A')).toBeTruthy()
  })

  it('a tile marks a methodology change in its chart, and none when restated', async () => {
    const v1 = versions.find((v) => v.id === 'ver-1')!
    // A marker needs the metric's method to change: here its rule.
    const rule = { type: 'bands' as const, bands: [{ status: 'G', op: '>=', value: 90 }, { status: 'R', op: '', value: 0 }] }
    const content = { ...v1.content, metrics: v1.content.metrics.map((m) => (m.key === 'on_time_pct' ? { ...m, rule } : m)) }
    const withJuly = [...versions, { ...v1, id: 'ver-3', name: 'FY26 v2', effectiveFrom: '2026-M07', content }]
    // Earlier handlers win, so these versions come before viewHandlers' own.
    server.use(http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: withJuly })), ...viewHandlers())
    const { unmount } = renderApp(<App />, { route: ROUTE })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const summary = () => metricTile('On-time delivery').querySelector('.sr-only')?.textContent ?? ''
    await waitFor(() => expect(summary()).toContain('Methodology changed: FY26 v2 from Jul 2026'))
    unmount()
    renderApp(<App />, { route: `${ROUTE}&restate=ver-3` })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(summary()).toMatch(/^On-time delivery:/)
    expect(summary()).not.toContain('Methodology changed')
  })

  it('a needs-attention card: a stretched link to the metric, the reason, value row, trend and why line', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const needs = screen.getByRole('region', { name: 'Needs attention' })
    expect(within(needs).getByText('1 slipping')).toBeTruthy()
    const card = within(needs).getByRole('article', { name: 'On-time delivery' })
    expect(within(card).getByText('Delivery')).toBeTruthy()
    expect(within(card).getByText('Fell from Green')).toBeTruthy()
    expect(within(card).getByText('84.3%')).toBeTruthy()
    expect(within(card).getByText(/\+2\.1 pts vs Sep/)).toBeTruthy()
    expect(card.querySelector('svg')).toBeTruthy()
    expect(within(card).getByTestId('attention-ribbon').children).toHaveLength(12)
    expect(within(card).getByTestId('attention-why').textContent).toBe('Lowest: Unit A 70.0% ◆R · 1 of 2 units Red')
    const link = within(card).getByRole('link', { name: 'On-time delivery' })
    expect(link.getAttribute('href')).toMatch(/[?&]focus=on_time_pct(&|$)/)
    expect(link.getAttribute('href')).toMatch(/[?&]period=2026-M10(&|$)/)
    const user = userEvent.setup()
    await user.click(link)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(link))
  })

  it('Needs attention: 3 of 5 Red, and Show all filters to Red and moves focus to the first tile', async () => {
    renderOverview(ROUTE, (view) => addRed(view, 5))
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const needs = screen.getByRole('region', { name: 'Needs attention' })
    expect(within(needs).getByText('3 of 5 Red')).toBeTruthy()
    expect(within(needs).getAllByRole('article')).toHaveLength(3)
    expect(within(needs).getAllByText('Red all 12 months shown')).toHaveLength(3)
    const user = userEvent.setup()
    await user.click(within(needs).getByRole('button', { name: 'Show all 5 Red' }))
    expect(within(screen.getByRole('region', { name: 'Health this month' })).getByRole('button', { name: /^Red:/ }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(queryTile('On-time delivery')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(metricTile('Red metric 1')).getByRole('button', { name: 'Expand Red metric 1' })))
  })

  it('Needs attention, mixed: Red and slipping, with no Show all', async () => {
    renderOverview(ROUTE, (view) => addRed(view, 1))
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const needs = screen.getByRole('region', { name: 'Needs attention' })
    expect(within(needs).getByText('1 Red · 1 slipping')).toBeTruthy()
    expect(within(needs).queryByRole('button', { name: /^Show all/ })).toBeNull()
    expect(within(needs).getAllByRole('article').map((a) => within(a).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Red metric 1',
      'On-time delivery',
    ])
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

  it('an item-only metric gets the exceptions-first tile: the worst service, the distribution and one row per exception', async () => {
    renderUptime()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const tile = metricTile('Service uptime')
    await waitFor(() => expect(within(tile).getByText('2 services · Green at 99.90% or better')).toBeTruthy())
    const worst = within(tile).getByTestId('item-tile-worst')
    expect(within(worst).getByText('Web service')).toBeTruthy()
    expect(within(worst).getByText('99.20%')).toBeTruthy()
    expect(within(tile).getByTestId('item-tile-distribution').textContent).toBe('1 Green · 1 Red')
    expect(within(tile).getAllByRole('button', { name: /^Open / }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open Web service trend: 99.20%, Red',
    ])
    expect(within(tile).getByTestId('item-tile-rest').textContent).toBe('All other 1 service Green')
    expect(within(tile).queryByTestId('metric-chart')).toBeNull()
    expect(within(tile).queryByText(/^Company total not reported/)).toBeNull()
  })

  it('a service row opens the dialog drilled into that service; Esc returns focus to the row', async () => {
    renderUptime()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const row = await within(metricTile('Service uptime')).findByRole('button', { name: 'Open Web service trend: 99.20%, Red' })
    const user = userEvent.setup()
    await user.click(row)
    const dialog = await screen.findByRole('dialog', { name: /Service uptime/i })
    expect(await within(dialog).findByRole('heading', { level: 3, name: 'Web service' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  it('an item-only metric in Needs attention: the worst service, the distribution and how many are Red', async () => {
    renderUptime()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const needs = screen.getByRole('region', { name: 'Needs attention' })
    const card = within(needs).getByRole('article', { name: 'Service uptime' })
    await waitFor(() => expect(within(card).getByText('1 service Red')).toBeTruthy())
    expect(within(card).getByTestId('attention-value').textContent).toMatch(/^Worst\s*Web service\s*99\.20%/)
    expect(within(card).getByText('1 of 2 Green · ◆ 1 Red')).toBeTruthy()
    expect(within(card).getByTestId('attention-mini-board').querySelectorAll('[data-kind]')).toHaveLength(24)
    expect(within(card).getByTestId('attention-why').textContent).toBe('Web service: Red in 1 of the last 12 months')
  })

  it('the overview with an item tile has no axe violations', async () => {
    const { container } = renderUptime()
    await screen.findByRole('grid', { name: '12-month status' })
    await within(metricTile('Service uptime')).findByText('2 services · Green at 99.90% or better')
    expect((await axe(container)).violations).toEqual([])
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
        http.get(`${API}/v1/item-kinds`, () => HttpResponse.json({ itemKinds: [{ id: 'service', name: 'Services' }] })),
      )
      renderApp(<App />, { route: `${ROUTE}&scope=${scope}` })
    }

    it("an item-only metric shows the worst of the subtree's services, which the request asks for", async () => {
      const seen: URL[] = []
      scoped('unit-a', seen)
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const card = metricCard('Service uptime')
      expect(within(within(card).getByTestId('item-tile-worst')).getByText('Web service')).toBeTruthy()
      expect(within(card).getByRole('button', { name: /^Open Web service trend/ })).toBeTruthy()
      expect(within(card).queryByText('API service')).toBeNull()
      expect(seen).toHaveLength(1)
      expect(seen[0]!.searchParams.getAll('subjects')).toEqual(['unit-a', 'team-a1', 'svc-web'])
    })

    it('an item-only metric is Not reported when the subtree has no services', async () => {
      scoped('unit-b')
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const notReported = await screen.findByRole('region', { name: /^Not reported for Oct 2026/ })
      await waitFor(() => expect(within(notReported).getByRole('rowheader', { name: 'Service uptime' })).toBeTruthy())
      expect(screen.queryByRole('article', { name: /Service uptime/ })).toBeNull()
      expect(within(screen.getByRole('region', { name: 'Health this month' })).getByRole('button', { name: /^Not reported: \d+ metrics?,/ })).toBeTruthy()
    })
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
      expect(within(health).getByRole('button', { name: /^Green: 1 metric,/ })).toBeTruthy()
      expect(within(health).getByRole('button', { name: /^Yellow: 1 metric,/ })).toBeTruthy()
      expect(within(health).getByRole('button', { name: /^Not reported: 1 metric,/ })).toBeTruthy()
      expect(within(health).getByText('3 metrics · Oct 2026')).toBeTruthy()
      const listed = screen.getByRole('region', { name: /^Not reported for Oct 2026/ })
      const defect = within(listed).getByRole('rowheader', { name: 'Defect rate' }).closest('tr')!
      expect(within(defect).getByText('Not applicable: Not measured this month')).toBeTruthy()
      expect(within(defect).getByText('Quality')).toBeTruthy()
      expect(within(listed).queryByRole('rowheader', { name: /Concepts/ })).toBeNull()
      expect(
        screen.getByText('Reported less often and up to date: Concepts delivered expected value (Q3 FY2026; Q4 due by Jan).'),
      ).toBeTruthy()
    })

    it('the tile says which period counts, its months, and when the next one is due', async () => {
      renderQuarterly()
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const tile = metricTile('Concepts delivered expected value')
      expect(within(tile).getByText('Latest: Q3 FY2026 (Jul–Sep) · Q4 due by Jan')).toBeTruthy()
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
      await waitFor(() => expect(metricTile('Service uptime')).toBeTruthy())
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
