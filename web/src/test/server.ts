import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { components } from '../api/schema'
import { devUsers, meFor, orgUnits, scorecards } from './fixtures'
import { rcaByCell, rcaDraftDone, rcaDraftPending, rcaList } from './rcaFixtures'

export const API = 'http://127.0.0.1:8080'

/** The role the default /v1/me handler answers with; tests set it per case. */
export const state = { role: 'admin' as 'admin' | 'contributor' | 'viewer' }

/** The six RCA operations over `rcaFixtures`; tests override them per case. */
export const rcaHandlers = [
  http.get(`${API}/v1/scorecards/:sc/rca`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const found = rcaByCell[`${q.get('metric')}|${q.get('subject')}|${q.get('period')}`]
    if (!found) return HttpResponse.json({ error: { code: 'not_found', message: 'No such cell.' } }, { status: 404 })
    return HttpResponse.json(found)
  }),
  http.put(`${API}/v1/scorecards/:sc/rca`, async ({ request }) => {
    const body = (await request.json()) as components['schemas']['PutCellRcaRequest']
    const note: components['schemas']['RcaNote'] = {
      text: body.text,
      links: body.links,
      authorId: `test|${state.role}`,
      authorName: `Test ${state.role}`,
      channel: 'web',
      updatedAt: '2026-11-20T12:00:00Z',
      revision: body.expectedRevision + 1,
    }
    return HttpResponse.json(note)
  }),
  http.delete(`${API}/v1/scorecards/:sc/rca`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/v1/scorecards/:sc/rcas`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const period = q.get('period') ?? rcaList.period
    return HttpResponse.json({ ...rcaList, period, items: q.get('countsOnly') === 'true' ? [] : rcaList.items })
  }),
  http.post(`${API}/v1/scorecards/:sc/rca/draft`, () => HttpResponse.json(rcaDraftPending, { status: 202 })),
  http.get(`${API}/v1/scorecards/:sc/rca/draft/:id`, () => HttpResponse.json(rcaDraftDone)),
  // The Why card asks whether SAM is on before offering `Draft with SAM`.
  http.get(`${API}/v1/assistant/settings`, () => HttpResponse.json({ enabled: true, model: 'test-model' })),
]

export const handlers = [
  http.get(`${API}/dev/users`, () => HttpResponse.json(devUsers)),
  http.post(`${API}/dev/login`, async ({ request }) => {
    const body = (await request.json()) as { userId: string }
    return HttpResponse.json({ token: `token-for-${body.userId}` })
  }),
  http.get(`${API}/v1/me`, () => HttpResponse.json(meFor(state.role))),
  http.get(`${API}/v1/scorecards`, () => HttpResponse.json({ scorecards })),
  http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: orgUnits })),
  http.get(`${API}/v1/items`, () => HttpResponse.json({ items: [] })),
  http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ levels: [] })),
  http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: '' })),
  http.get(`${API}/v1/me/layouts/:sc`, () =>
    HttpResponse.json({ items: [], revision: 0, source: 'empty', defaultRevision: 0 }),
  ),
  http.put(`${API}/v1/me/layouts/:sc`, async ({ request }) => {
    const body = (await request.json()) as { items: unknown[]; expectedRevision: number }
    return HttpResponse.json({
      items: body.items,
      revision: body.expectedRevision + 1,
      source: 'user',
      defaultRevision: 0,
    })
  }),
  ...rcaHandlers,
]

export const server = setupServer(...handlers)
