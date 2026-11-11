import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { monthLabel, parsePeriod } from '../../lib/period'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { buildView, viewHandlers } from '../../test/viewFixtures'

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
    expect(screen.getByText('worst of 2 segments')).toBeTruthy()
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

  it('draws tinted status band areas on ratio charts', async () => {
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
    expect(Number(chart.getAttribute('data-band-areas'))).toBeGreaterThan(0)
    expect(within(metricCard('On-time delivery')).getByTestId('current-point-label').textContent).toMatch(/84\.3%/)
    expect(within(metricCard('On-time delivery')).getByTestId('current-point-label').textContent).toContain('Y')
  })

  it('omits YTD on the card when the scope row has no YTD value', async () => {
    renderOverview(`${ROUTE}&ytd=1`, (view) => {
      if (view.periods.length > 0) return
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

  it('shows the period header sentence', async () => {
    renderOverview()
    const fy = 1
    const parsed = parsePeriod('2026-M10')!
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(screen.getByText(new RegExp(`${monthLabel(parsed, fy)}.*All of Example Co`))).toBeTruthy()
  })
})
