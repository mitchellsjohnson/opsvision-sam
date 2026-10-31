import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API, server } from '../test/server'
import { createApiClient } from './client'
import { ApiError } from './errors'

function client(token: string | null = 'abc') {
  return createApiClient({ apiUrl: API, getToken: async () => token ?? undefined })
}

describe('createApiClient', () => {
  it('adds the bearer token to requests', async () => {
    let auth: string | null = null
    server.use(
      http.get(`${API}/v1/scorecards`, ({ request }) => {
        auth = request.headers.get('Authorization')
        return HttpResponse.json({ scorecards: [] })
      }),
    )
    const { data } = await client('tok-1').GET('/scorecards')
    expect(data).toEqual({ scorecards: [] })
    expect(auth).toBe('Bearer tok-1')
  })

  it('sends no Authorization header without a token', async () => {
    let auth: string | null = 'unset'
    server.use(
      http.get(`${API}/v1/scorecards`, ({ request }) => {
        auth = request.headers.get('Authorization')
        return HttpResponse.json({ scorecards: [] })
      }),
    )
    await client(null).GET('/scorecards')
    expect(auth).toBeNull()
  })

  it('maps an error envelope to a typed ApiError', async () => {
    server.use(
      http.get(`${API}/v1/scorecards`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid',
              message: 'bad request',
              details: [{ path: 'periods', message: 'too many' }],
            },
          },
          { status: 400 },
        ),
      ),
    )
    const err = await client()
      .GET('/scorecards')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(400)
    expect(apiErr.code).toBe('invalid')
    expect(apiErr.message).toBe('bad request')
    expect(apiErr.details).toEqual([{ path: 'periods', message: 'too many' }])
  })

  it('maps a response without an envelope using the status', async () => {
    server.use(
      http.get(`${API}/v1/scorecards`, () => new HttpResponse('boom', { status: 404 })),
    )
    const err = (await client()
      .GET('/scorecards')
      .catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
    expect(err.details).toEqual([])
  })

  it('keeps the body of a conflict that is not an envelope', async () => {
    const body = { conflicts: [{ write: { measureKey: 'm' } }] }
    server.use(
      http.post(`${API}/v1/scorecards/sc/data:batch`, () =>
        HttpResponse.json(body, { status: 409 }),
      ),
    )
    const err = (await client()
      .POST('/scorecards/{sc}/data:batch', {
        params: { path: { sc: 'sc' } },
        body: { writes: [] },
      })
      .catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(409)
    expect(err.code).toBe('conflict')
    expect(err.body).toEqual(body)
  })

  it('calls onUnauthorized for a 401', async () => {
    let called = 0
    server.use(
      http.get(`${API}/v1/me`, () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      ),
    )
    const c = createApiClient({
      apiUrl: API,
      getToken: async () => 'x',
      onUnauthorized: () => {
        called++
      },
    })
    await c.GET('/me').catch(() => {})
    expect(called).toBe(1)
  })
})
