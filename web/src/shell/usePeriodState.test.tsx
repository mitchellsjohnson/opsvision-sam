import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { currentMonth } from '../lib/period'
import { API, server } from '../test/server'
import { renderApp } from '../test/utils'
import { usePeriodState } from './usePeriodState'

function Probe() {
  const [view] = usePeriodState()
  return (
    <p data-testid="probe" data-ready={String(view.ready)}>
      {view.period}
    </p>
  )
}

function scorecardsReply(...cards: { id: string; latestDataMonth: string | null }[]) {
  server.use(
    http.get(`${API}/v1/scorecards`, () =>
      HttpResponse.json({ scorecards: cards.map((c) => ({ ...c, name: `Card ${c.id}` })) }),
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

  it('falls back to the current month when scorecards cannot load', async () => {
    server.use(http.get(`${API}/v1/scorecards`, () => HttpResponse.json({}, { status: 500 })))
    probe('/scorecards/a/overview')
    await waitFor(() => expect(screen.getByTestId('probe').dataset.ready).toBe('true'))
    expect(shown()).toBe(currentMonth(1))
  })
})
