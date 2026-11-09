import { describe, expect, it, vi } from 'vitest'
import { ConfigError } from './config'
import { loadRuntimeConfig, RUNTIME_CONFIG_PATH } from './runtimeConfig'

const ORIGIN = 'https://ops.example.test'

const ENV = {
  VITE_AUTH0_DOMAIN: 'build.example.test',
  VITE_AUTH0_CLIENT_ID: 'build-client',
  VITE_AUTH0_AUDIENCE: 'https://build.example.test/api',
}

const SERVED = {
  authMode: 'auth0',
  auth0Domain: 'example.us.auth0.com',
  auth0ClientId: 'example-client-id',
  auth0Audience: 'https://ops.example.test/api',
  apiUrl: '',
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function fetchReturning(res: Response | Error) {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
    if (res instanceof Error) throw res
    return res
  })
}

describe('loadRuntimeConfig', () => {
  it('uses /config.json in a production build, with the API on the same origin', async () => {
    const fetchFn = fetchReturning(json(SERVED))
    const config = await loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0]?.[0]).toBe(RUNTIME_CONFIG_PATH)
    expect(RUNTIME_CONFIG_PATH).toBe('/config.json')
    expect(config).toEqual({
      apiUrl: ORIGIN,
      authMode: 'auth0',
      auth0Domain: 'example.us.auth0.com',
      auth0ClientId: 'example-client-id',
      auth0Audience: 'https://ops.example.test/api',
      fromRuntimeConfig: true,
    })
    expect(config.organization).toBeUndefined()
  })

  it('takes the organization from /config.json when one is configured', async () => {
    const fetchFn = fetchReturning(json({ ...SERVED, organization: 'org_example' }))
    const config = await loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn })
    expect(config.organization).toBe('org_example')
  })

  it('falls back to the build env when /config.json is 404', async () => {
    const fetchFn = fetchReturning(new Response('not found', { status: 404 }))
    const config = await loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn })
    expect(config.auth0Domain).toBe('build.example.test')
    expect(config.auth0ClientId).toBe('build-client')
    expect(config.apiUrl).toBe('http://127.0.0.1:8080')
    expect(config.fromRuntimeConfig).toBeUndefined()
  })

  it('falls back to the build env on a network error', async () => {
    const fetchFn = fetchReturning(new TypeError('Failed to fetch'))
    const config = await loadRuntimeConfig({
      env: { ...ENV, VITE_API_URL: 'https://api.example.test' },
      isProduction: true,
      origin: ORIGIN,
      fetchFn,
    })
    expect(config.auth0Domain).toBe('build.example.test')
    expect(config.apiUrl).toBe('https://api.example.test')
    expect(config.fromRuntimeConfig).toBeUndefined()
  })

  it('treats an HTML page answered for /config.json (a static host fallback) as absent', async () => {
    const fetchFn = fetchReturning(
      new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const config = await loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn })
    expect(config.auth0Domain).toBe('build.example.test')
    expect(config.fromRuntimeConfig).toBeUndefined()
  })

  it('still reports a build env that is incomplete after falling back', async () => {
    const fetchFn = fetchReturning(new Response('', { status: 404 }))
    await expect(
      loadRuntimeConfig({ env: {}, isProduction: true, origin: ORIGIN, fetchFn }),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('fails on a server error rather than guessing', async () => {
    const fetchFn = fetchReturning(new Response('oops', { status: 500 }))
    await expect(
      loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn }),
    ).rejects.toThrow(/config\.json.*500/)
  })

  it('names the settings missing from /config.json', async () => {
    const fetchFn = fetchReturning(json({ ...SERVED, auth0ClientId: '  ', auth0Audience: undefined }))
    let error: unknown
    try {
      await loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).missing).toEqual(['auth0ClientId', 'auth0Audience'])
    expect((error as ConfigError).message).toContain('/config.json')
  })

  it('never accepts dev sign-in from /config.json', async () => {
    const fetchFn = fetchReturning(json({ ...SERVED, authMode: 'dev' }))
    await expect(
      loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn }),
    ).rejects.toThrow(/authMode/)
  })

  it('rejects a /config.json that is not a JSON object', async () => {
    const fetchFn = fetchReturning(
      new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    await expect(
      loadRuntimeConfig({ env: ENV, isProduction: true, origin: ORIGIN, fetchFn }),
    ).rejects.toThrow(/config\.json/)
  })

  it('leaves a development build unchanged: no fetch, the build env as before', async () => {
    const fetchFn = fetchReturning(json(SERVED))
    const config = await loadRuntimeConfig({ env: {}, isProduction: false, origin: ORIGIN, fetchFn })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(config).toEqual({
      apiUrl: 'http://127.0.0.1:8080',
      authMode: 'dev',
      auth0Domain: '',
      auth0ClientId: '',
      auth0Audience: '',
    })
  })
})
