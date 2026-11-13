import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { scorecardViewRequest, viewSubjects } from './viewRequest'

const base = {
  period: '2026-M10',
  ytd: false,
  subjects: [] as string[],
  scope: '',
  restate: '',
  structure: 'as_of' as const,
  fiscalYearStartMonth: 1,
}
const units = [
  { id: 'unit-a', parentId: '' },
  { id: 'team-a1', parentId: 'unit-a' },
  { id: 'unit-b', parentId: '' },
]

describe('scorecardViewRequest', () => {
  it('asks for the 12-month trend and nothing else by default', () => {
    const req = scorecardViewRequest(base, units)
    expect(req.periods).toHaveLength(12)
    expect(req.periods?.at(-1)).toBe('2026-M10')
    expect(req).toEqual({ periods: req.periods })
  })

  it('carries the scope with its descendants, YTD, restate and structure', () => {
    const req = scorecardViewRequest({ ...base, ytd: true, scope: 'unit-a', restate: 'ver-2', structure: 'current' }, units)
    expect(req.subjects).toEqual(['unit-a', 'team-a1'])
    expect(req.ytd).toEqual(['2026-M10'])
    expect(req.restate).toBe('ver-2')
    expect(req.structure).toBe('current')
  })

  it('YTD for a quarter runs through its last month', () => {
    expect(scorecardViewRequest({ ...base, period: '2026-Q2', ytd: true }, units).ytd).toEqual(['2026-M06'])
  })

  it('picked subjects win over the scope', () => {
    expect(viewSubjects({ subjects: ['unit-b'], scope: 'unit-a' }, units)).toEqual(['unit-b'])
  })

  it('24 months for one metric', () => {
    const req = scorecardViewRequest(base, units, { months: 24, metrics: ['on_time_pct'] })
    expect(req.periods).toHaveLength(24)
    expect(req.metrics).toEqual(['on_time_pct'])
  })
})

describe('one view request per URL', () => {
  const QUERY = 'period=2026-M10&ytd=1&scope=unit-a&restate=ver-2&structure=current'

  async function requestsFor(route: string, ready: () => Promise<unknown>): Promise<Set<string>> {
    const seen = new Set<string>()
    server.use(...viewHandlers({ onView: (u) => seen.add(u.search) }))
    renderApp(<App />, { route })
    await ready()
    cleanup()
    return seen
  }

  it('the Overview, its full-screen chart and the Table send the same request', async () => {
    const overview = await requestsFor(`/scorecards/sc-main/overview?${QUERY}&focus=on_time_pct`, () =>
      screen.findByRole('dialog', { name: /On-time delivery/i }),
    )
    const table = await requestsFor(`/scorecards/sc-main/table?${QUERY}`, () =>
      screen.findByRole('grid', { name: /table/i }),
    )
    expect(overview.size).toBe(1)
    expect(table).toEqual(overview)
    const q = new URLSearchParams([...overview][0])
    expect(q.getAll('subjects')).toEqual(['unit-a'])
    expect(q.get('restate')).toBe('ver-2')
    expect(q.get('structure')).toBe('current')
    expect(q.getAll('ytd')).toEqual(['2026-M10'])
  })

  it('a full-screen breakdown button scopes the view to that unit', async () => {
    const seen: URL[] = []
    server.use(...viewHandlers({ onView: (u) => seen.push(u) }))
    renderApp(<App />, { route: '/scorecards/sc-main/overview?period=2026-M10&focus=on_time_pct' })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    const breakdown = await within(dialog).findByRole('region', { name: 'Org breakdown' })
    await userEvent.setup().click(within(breakdown).getByRole('button', { name: /Unit A/ }))
    await waitFor(() => expect(seen.some((u) => u.searchParams.getAll('subjects').includes('unit-a'))).toBe(true))
  })
})
