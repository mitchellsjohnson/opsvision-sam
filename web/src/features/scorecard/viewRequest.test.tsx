import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { orgUnits } from '../../test/fixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { UPTIME_ITEMS, viewHandlers } from '../../test/viewFixtures'
import { MAX_VIEW_SUBJECTS, scorecardViewRequest, viewSubjects } from './viewRequest'

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
const items = [
  { id: 'svc-web', orgUnitId: 'team-a1' },
  { id: 'svc-pay', orgUnitId: 'unit-a' },
  { id: 'svc-ops', orgUnitId: 'unit-b' },
  { id: 'svc-api', orgUnitId: '' },
]

describe('scorecardViewRequest', () => {
  it('asks for the 12-month trend and nothing else by default', () => {
    const req = scorecardViewRequest(base, { units, items })
    expect(req.periods).toHaveLength(12)
    expect(req.periods?.at(-1)).toBe('2026-M10')
    expect(req).toEqual({ periods: req.periods })
  })

  it('carries the scope with its descendants, YTD, restate and structure', () => {
    const req = scorecardViewRequest({ ...base, ytd: true, scope: 'unit-a', restate: 'ver-2', structure: 'current' }, { units })
    expect(req.subjects).toEqual(['unit-a', 'team-a1'])
    expect(req.ytd).toEqual(['2026-M10'])
    expect(req.restate).toBe('ver-2')
    expect(req.structure).toBe('current')
  })

  it('a scope keeps the tracked items attached anywhere below it, and no others', () => {
    expect(scorecardViewRequest({ ...base, scope: 'unit-a' }, { units, items }).subjects).toEqual([
      'unit-a',
      'team-a1',
      'svc-web',
      'svc-pay',
    ])
    expect(viewSubjects({ subjects: ['team-a1'], scope: '' }, { units, items })).toEqual(['team-a1', 'svc-web'])
    expect(viewSubjects({ subjects: [], scope: 'unit-b' }, { units, items })).toEqual(['unit-b', 'svc-ops'])
  })

  it('caps units and items together at the API limit, units first', () => {
    const many = Array.from({ length: MAX_VIEW_SUBJECTS - 2 }, (_, i) => ({ id: `team-${i}`, parentId: 'unit-a' }))
    const subjects = viewSubjects({ subjects: [], scope: 'unit-a' }, { units: [...units, ...many], items })
    expect(subjects).toHaveLength(MAX_VIEW_SUBJECTS)
    expect(subjects.slice(0, 2)).toEqual(['unit-a', 'team-a1'])
    expect(subjects.at(-1)).toBe('team-197')
  })

  it('YTD for a quarter runs through its last month', () => {
    expect(scorecardViewRequest({ ...base, period: '2026-Q2', ytd: true }, { units }).ytd).toEqual(['2026-M06'])
  })

  it('picked subjects win over the scope', () => {
    expect(viewSubjects({ subjects: ['unit-b'], scope: 'unit-a' }, { units })).toEqual(['unit-b'])
  })

  it('24 months for one metric', () => {
    const req = scorecardViewRequest(base, { units }, { months: 24, metrics: ['on_time_pct'] })
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

  it('with tracked items under the scope, all three still share one request, which names the items', async () => {
    const tree = () =>
      server.use(
        http.get(`${API}/v1/org/units`, () =>
          HttpResponse.json({
            units: [...orgUnits, { id: 'team-a1', name: 'Team A1', levelId: 'l2', parentId: 'unit-a', sourceKeys: [] }],
          }),
        ),
        http.get(`${API}/v1/items`, () => HttpResponse.json({ items: UPTIME_ITEMS })),
      )
    tree()
    const overview = await requestsFor(`/scorecards/sc-main/overview?${QUERY}&focus=on_time_pct`, () =>
      screen.findByRole('dialog', { name: /On-time delivery/i }),
    )
    tree()
    const table = await requestsFor(`/scorecards/sc-main/table?${QUERY}`, () => screen.findByRole('grid', { name: /table/i }))
    expect(overview.size).toBe(1)
    expect(table).toEqual(overview)
    expect(new URLSearchParams([...overview][0]).getAll('subjects')).toEqual(['unit-a', 'team-a1', 'svc-web'])
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
