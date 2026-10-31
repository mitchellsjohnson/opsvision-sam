import { describe, expect, it } from 'vitest'
import { ConfigError, resolveConfig } from './config'

const AUTH0 = {
  VITE_AUTH0_DOMAIN: 'login.example.test',
  VITE_AUTH0_CLIENT_ID: 'client-123',
  VITE_AUTH0_AUDIENCE: 'https://api.example.test',
}

describe('resolveConfig', () => {
  it('defaults a development build to dev auth and the local API', () => {
    expect(resolveConfig({}, false)).toEqual({
      apiUrl: 'http://127.0.0.1:8080',
      authMode: 'dev',
      auth0Domain: '',
      auth0ClientId: '',
      auth0Audience: '',
    })
  })

  it('defaults a production build to auth0', () => {
    const c = resolveConfig({ ...AUTH0 }, true)
    expect(c.authMode).toBe('auth0')
    expect(c.auth0Domain).toBe('login.example.test')
    expect(c.auth0ClientId).toBe('client-123')
    expect(c.auth0Audience).toBe('https://api.example.test')
  })

  it('uses dev auth in production only when VITE_AUTH_MODE is explicitly dev', () => {
    expect(resolveConfig({ VITE_AUTH_MODE: 'dev' }, true).authMode).toBe('dev')
    for (const mode of [undefined, '', 'DEV', 'development', 'anything']) {
      expect(() => resolveConfig({ VITE_AUTH_MODE: mode }, true)).toThrow(ConfigError)
    }
  })

  it('throws naming every missing Auth0 variable in production', () => {
    let error: unknown
    try {
      resolveConfig({}, true)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).missing).toEqual([
      'VITE_AUTH0_DOMAIN',
      'VITE_AUTH0_CLIENT_ID',
      'VITE_AUTH0_AUDIENCE',
    ])
    expect((error as ConfigError).message).toContain('VITE_AUTH0_CLIENT_ID')
  })

  it('names only the Auth0 variables that are missing or blank', () => {
    expect(() =>
      resolveConfig({ ...AUTH0, VITE_AUTH0_AUDIENCE: '   ', VITE_AUTH_MODE: 'auth0' }, true),
    ).toThrow(/VITE_AUTH0_AUDIENCE\./)
  })

  it('also requires the Auth0 variables when auth0 is chosen in a development build', () => {
    expect(() => resolveConfig({ VITE_AUTH_MODE: 'auth0' }, false)).toThrow(ConfigError)
    expect(resolveConfig({ VITE_AUTH_MODE: 'auth0', ...AUTH0 }, false).authMode).toBe('auth0')
  })

  it('does not require Auth0 variables for dev auth', () => {
    expect(() => resolveConfig({ VITE_AUTH_MODE: 'dev' }, true)).not.toThrow()
  })

  it('trims trailing slashes from the API URL', () => {
    expect(resolveConfig({ VITE_API_URL: 'https://api.example.test//' }, false).apiUrl).toBe(
      'https://api.example.test',
    )
  })
})
