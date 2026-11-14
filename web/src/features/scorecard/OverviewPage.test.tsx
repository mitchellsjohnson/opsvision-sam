import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { monthLabel, parsePeriod } from '../../lib/period'
import { orgUnits } from '../../test/fixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addServiceUptime, buildView, UPTIME_ITEMS, versions, viewHandlers } from '../../test/viewFixtures'

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
  renderApp(<App />, { route })
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
    expect(within(defect).getByText('n/a')).toBeTruthy()
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
    expect(within(metricCard('On-time delivery')).getByTestId('current-point-label').textContent).toMatch(/84\.3%/)
    expect(within(metricCard('On-time delivery')).getByTestId('current-point-label').textContent).toContain('Y')
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
    const badges = within(ribbon).getAllByRole('img')
    expect(badges).toHaveLength(12)
    expect(badges.at(-1)!.textContent).toBe('R')
    expect(badges.at(-1)!.getAttribute('aria-label')).toMatch(/Oct 2026/)
    expect(badges.at(-2)!.textContent).toBe('G')
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
      await waitFor(() => expect(screen.getByText(/^Not reported:/).textContent).toMatch(/Service uptime/))
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

  it('shows the period header sentence', async () => {
    renderOverview()
    const fy = 1
    const parsed = parsePeriod('2026-M10')!
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(screen.getByText(new RegExp(`${monthLabel(parsed, fy)}.*All of Example Co`))).toBeTruthy()
  })
})
