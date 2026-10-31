import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { devUsers, meFor, orgUnits, scorecards } from './fixtures'

export const API = 'http://127.0.0.1:8080'

/** The role the default /v1/me handler answers with; tests set it per case. */
export const state = { role: 'admin' as 'admin' | 'contributor' | 'viewer' }

export const handlers = [
  http.get(`${API}/dev/users`, () => HttpResponse.json(devUsers)),
  http.post(`${API}/dev/login`, async ({ request }) => {
    const body = (await request.json()) as { userId: string }
    return HttpResponse.json({ token: `token-for-${body.userId}` })
  }),
  http.get(`${API}/v1/me`, () => HttpResponse.json(meFor(state.role))),
  http.get(`${API}/v1/scorecards`, () => HttpResponse.json({ scorecards })),
  http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: orgUnits })),
]

export const server = setupServer(...handlers)
