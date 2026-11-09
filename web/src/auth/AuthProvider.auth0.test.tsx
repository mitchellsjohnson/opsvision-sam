import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setConfig, type AppConfig } from '../config'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './context'
import { LAST_ORG_KEY, TENANT_ORGS_KEY } from './organization'

const auth0 = vi.hoisted(() => ({
  authorizationParams: undefined as Record<string, unknown> | undefined,
  authenticated: false,
}))

vi.mock('@auth0/auth0-react', () => ({
  Auth0Provider: (props: { children: ReactNode; authorizationParams?: Record<string, unknown> }) => {
    auth0.authorizationParams = props.authorizationParams
    return <>{props.children}</>
  },
  useAuth0: () => ({
    isLoading: false,
    isAuthenticated: auth0.authenticated,
    error: undefined,
    user: undefined,
    getAccessTokenSilently: async () => 'token',
    loginWithRedirect: async () => {},
    logout: async () => {},
  }),
}))

const BUILD: AppConfig = {
  apiUrl: 'https://ops.example.test',
  authMode: 'auth0',
  auth0Domain: 'example.us.auth0.com',
  auth0ClientId: 'example-client-id',
  auth0Audience: 'https://ops.example.test/api',
}
const RUNTIME: AppConfig = { ...BUILD, fromRuntimeConfig: true }

function SwitchProbe() {
  const { canSwitchTenant, switchTenant } = useAuth()
  return (
    <p>
      {canSwitchTenant?.('t2') ? 'can switch' : 'cannot switch'}
      {switchTenant ? ' with switcher' : ' without switcher'}
    </p>
  )
}

function signIn(config: AppConfig, { url = '/?organization=org_url', authenticated = false } = {}) {
  setConfig(config)
  auth0.authenticated = authenticated
  localStorage.setItem(LAST_ORG_KEY, 'org_last')
  localStorage.setItem(TENANT_ORGS_KEY, JSON.stringify({ t2: 'org_t2' }))
  window.history.replaceState({}, '', url)
  render(
    <AuthProvider mode="auth0">
      <SwitchProbe />
    </AuthProvider>,
  )
}

afterEach(() => {
  auth0.authorizationParams = undefined
  window.history.replaceState({}, '', '/')
})

describe('auth0 AuthProvider with /config.json', () => {
  it('ignores ?organization= and the last used one when the deployment configures none', () => {
    signIn(RUNTIME)
    expect(auth0.authorizationParams).toEqual({
      audience: 'https://ops.example.test/api',
      redirect_uri: window.location.origin,
    })
    expect(screen.getByText('Sign in to continue.')).toBeTruthy()
    expect(localStorage.getItem(LAST_ORG_KEY)).toBe('org_last')
  })

  it('passes only the configured organization', () => {
    signIn({ ...RUNTIME, organization: 'org_configured' })
    expect(auth0.authorizationParams?.organization).toBe('org_configured')
  })

  it('offers no switch to an organization remembered from another session', () => {
    signIn(RUNTIME, { authenticated: true })
    expect(screen.getByText('cannot switch without switcher')).toBeTruthy()
  })
})

describe('auth0 AuthProvider with the build env', () => {
  it('keeps using ?organization=, then the last used one', () => {
    signIn(BUILD)
    expect(auth0.authorizationParams?.organization).toBe('org_url')
    expect(localStorage.getItem(LAST_ORG_KEY)).toBe('org_url')
  })

  it('falls back to the last used organization', () => {
    signIn(BUILD, { url: '/' })
    expect(auth0.authorizationParams?.organization).toBe('org_last')
  })

  it('still switches to a remembered organization', () => {
    signIn(BUILD, { authenticated: true })
    expect(screen.getByText('can switch with switcher')).toBeTruthy()
  })
})
