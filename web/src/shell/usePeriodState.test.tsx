import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { currentMonth, formatPeriod, monthOf, prev } from '../lib/period'
import { API, server } from '../test/server'
import { renderApp } from '../test/utils'
import { defaultPeriod, usePeriodState, type ScorecardMonths } from './usePeriodState'

function Probe() {
  const [view] = usePeriodState()
  return (
    <p data-testid="probe" data-ready={String(view.ready)}>
      {view.period}
    </p>
  )
}

function scorecardsReply(...cards: (Omit<ScorecardMonths, 'latestPastDataMonth'> & Partial<ScorecardMonths>)[]) {
  server.use(
    http.get(`${API}/v1/scorecards`, () =>
      HttpResponse.json({
        scorecards: cards.map((c) => ({ latestPastDataMonth: c.latestDataMonth, ...c, name: `Card ${c.id}` })),
      }),
    ),
  )
}

function probe(route: string) {
  renderApp(
    <Routes>
      <Route path="/scorecards/:sc/*" element={<Probe />} />
      <Route path="*" element={<Probe />} />
    </Routes>,
    { route },
  )
}

const shown = () => screen.getByTestId('probe').textContent

describe('usePeriodState default period', () => {
  it('opens on the latest month with data for the scorecard in the route', async () => {
    scorecardsReply({ id: 'a', latestDataMonth: '2026-M08' }, { id: 'b', latestDataMonth: '2025-M03' })
    probe('/scorecards/b/overview')
    await waitFor(() => expect(shown()).toBe('2025-M03'))
    expect(screen.getByTestId('probe').dataset.ready).toBe('true')
  })

  it('is not ready until the scorecards have loaded', async () => {
    scorecardsReply({ id: 'a', latestDataMonth: '2026-M08' })
    probe('/scorecards/a/overview')
    expect(screen.getByTestId('probe').dataset.ready).toBe('false')
    await waitFor(() => expect(screen.getByTestId('probe').dataset.ready).toBe('true'))
  })

  it('lets an explicit period win', async () => {
    scorecardsReply({ id: 'a', latestDataMonth: '2026-M08' })
    probe('/scorecards/a/overview?period=2026-Q1')
    expect(shown()).toBe('2026-Q1')
    expect(screen.getByTestId('probe').dataset.ready).toBe('true')
    await new Promise((r) => setTimeout(r, 50))
    expect(shown()).toBe('2026-Q1')
  })

  it('uses the current month when the scorecard has no data', async () => {
    scorecardsReply({ id: 'a', latestDataMonth: null }, { id: 'b', latestDataMonth: '2026-M08' })
    probe('/scorecards/a/overview')
    await waitFor(() => expect(screen.getByTestId('probe').dataset.ready).toBe('true'))
    expect(shown()).toBe(currentMonth(1))
  })

  it('uses the newest month across scorecards outside a scorecard page', async () => {
    scorecardsReply(
      { id: 'a', latestDataMonth: '2025-M11' },
      { id: 'b', latestDataMonth: '2026-M02' },
      { id: 'c', latestDataMonth: null },
    )
    probe('/entry')
    await waitFor(() => expect(shown()).toBe('2026-M02'))
  })

  it('follows the scorecard chosen on the entry page', async () => {
    scorecardsReply({ id: 'a', latestDataMonth: '2025-M11' }, { id: 'b', latestDataMonth: '2026-M02' })
    probe('/entry?scorecard=a')
    await waitFor(() => expect(shown()).toBe('2025-M11'))
  })

  it('skips the month in progress when an earlier month has data', async () => {
    const now = currentMonth(1)
    const before = formatPeriod(prev(monthOf(new Date(), 1)))
    scorecardsReply({ id: 'a', latestDataMonth: now, latestPastDataMonth: before })
    probe('/scorecards/a/overview')
    await waitFor(() => expect(shown()).toBe(before))
  })

  it('falls back to the current month when scorecards cannot load', async () => {
    server.use(http.get(`${API}/v1/scorecards`, () => HttpResponse.json({}, { status: 500 })))
    probe('/scorecards/a/overview')
    await waitFor(() => expect(screen.getByTestId('probe').dataset.ready).toBe('true'))
    expect(shown()).toBe(currentMonth(1))
  })
})

describe('defaultPeriod', () => {
  const nov25 = new Date(2026, 10, 25)
  const card = (id: string, latestDataMonth: string | null, latestPastDataMonth: string | null) => ({
    id,
    latestDataMonth,
    latestPastDataMonth,
  })

  it('skips the month in progress for the latest earlier month with data', () => {
    expect(defaultPeriod([card('a', '2026-M11', '2026-M10')], 'a', 1, nov25)).toBe('2026-M10')
    expect(defaultPeriod([card('a', '2026-M11', '2026-M08')], 'a', 1, nov25)).toBe('2026-M08')
  })

  it('opens on a past month when that is the latest with data', () => {
    expect(defaultPeriod([card('a', '2026-M09', '2026-M09')], 'a', 1, nov25)).toBe('2026-M09')
  })

  it('keeps the month in progress when it is the only one with data', () => {
    expect(defaultPeriod([card('a', '2026-M11', null)], 'a', 1, nov25)).toBe('2026-M11')
  })

  it('uses the current month when there is no data', () => {
    expect(defaultPeriod([card('a', null, null)], 'a', 1, nov25)).toBe('2026-M11')
    expect(defaultPeriod([], undefined, 1, nov25)).toBe('2026-M11')
    expect(defaultPeriod(undefined, 'a', 1, nov25)).toBe('2026-M11')
  })

  it('works in fiscal months when the fiscal year does not start in January', () => {
    // July start: Nov 2026 is the fifth month of FY2027.
    expect(defaultPeriod([card('a', '2027-M05', '2027-M04')], 'a', 7, nov25)).toBe('2027-M04')
    expect(defaultPeriod([card('a', '2027-M05', null)], 'a', 7, nov25)).toBe('2027-M05')
    expect(defaultPeriod([card('a', null, null)], 'a', 7, nov25)).toBe('2027-M05')
    // October start: early October 2026 is the first month of FY2027, so the month before is last fiscal year's.
    expect(defaultPeriod([card('a', '2027-M01', '2026-M12')], 'a', 10, new Date(2026, 9, 3))).toBe('2026-M12')
  })

  it('looks across all scorecards when the page is not about one', () => {
    const cards = [card('a', '2026-M11', null), card('b', '2026-M09', '2026-M09')]
    expect(defaultPeriod(cards, undefined, 1, nov25)).toBe('2026-M09')
    expect(defaultPeriod(cards, 'a', 1, nov25)).toBe('2026-M11')
  })
})
