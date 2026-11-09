import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getConfig, type AuthMode } from '../config'
import { AuthContext, type AuthState } from './context'
import { clearDevToken, readDevToken, storeDevToken } from './devAuth'
import { Auth0LoginPage, DevLoginPage } from './LoginPage'
import {
  auth0AuthorizationParams,
  LAST_ORG_KEY,
  organizationForTenant,
  rememberOrganization,
  rememberTenantOrganization,
  resolveOrganization,
} from './organization'

interface Props {
  children: ReactNode
  mode?: AuthMode
  apiUrl?: string
}

/**
 * Signs the user in and renders `children` only once authenticated. Dev mode
 * shows a user picker backed by the dev server; auth0 mode uses Auth0.
 */
export function AuthProvider({
  children,
  mode = getConfig().authMode,
  apiUrl = getConfig().apiUrl,
}: Props) {
  return mode === 'auth0' ? (
    <Auth0Auth>{children}</Auth0Auth>
  ) : (
    <DevAuth apiUrl={apiUrl}>{children}</DevAuth>
  )
}

function DevAuth({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const [token, setToken] = useState<string | null>(readDevToken)

  const getToken = useCallback(async () => readDevToken() ?? undefined, [])
  const signOut = useCallback(() => {
    clearDevToken()
    setToken(null)
  }, [])
  const value = useMemo<AuthState>(
    () => ({
      mode: 'dev',
      status: token ? 'authenticated' : 'unauthenticated',
      getToken,
      signOut,
    }),
    [token, getToken, signOut],
  )

  if (!token) {
    return (
      <DevLoginPage
        apiUrl={apiUrl}
        onLogin={(t) => {
          storeDevToken(t)
          setToken(t)
        }}
      />
    )
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function Auth0Auth({ children }: { children: ReactNode }) {
  const config = getConfig()
  // A deployment that publishes /config.json decides the organization alone.
  const onlyConfigured = config.fromRuntimeConfig === true
  const organization = useMemo(
    () =>
      resolveOrganization(window.location.search, localStorage, config.organization, onlyConfigured),
    [config.organization, onlyConfigured],
  )
  // Remember an organization named in the URL for next time (not during render).
  useEffect(() => {
    if (organization && !onlyConfigured) rememberOrganization(organization, localStorage)
  }, [organization, onlyConfigured])
  return (
    <Auth0Provider
      domain={config.auth0Domain}
      clientId={config.auth0ClientId}
      // Tokens stay in memory only, never in localStorage.
      cacheLocation="memory"
      authorizationParams={auth0AuthorizationParams({
        audience: config.auth0Audience,
        organization,
        redirectUri: window.location.origin,
      })}
      onRedirectCallback={(appState) => {
        window.history.replaceState({}, document.title, appState?.returnTo ?? '/')
      }}
    >
      <Auth0Gate organization={organization} canSwitch={!onlyConfigured}>
        {children}
      </Auth0Gate>
    </Auth0Provider>
  )
}

function Auth0Gate({
  organization,
  canSwitch,
  children,
}: {
  organization?: string
  /** Whether the user may switch to an organization remembered from another session. */
  canSwitch: boolean
  children: ReactNode
}) {
  const { isLoading, isAuthenticated, error, user, getAccessTokenSilently, loginWithRedirect, logout } =
    useAuth0()

  const getToken = useCallback(() => getAccessTokenSilently(), [getAccessTokenSilently])
  const signOut = useCallback(
    () => void logout({ logoutParams: { returnTo: window.location.origin } }),
    [logout],
  )
  const switchTenant = useCallback(
    (tenantId: string) => {
      const org = organizationForTenant(tenantId, localStorage)
      if (!org) return
      void loginWithRedirect({ authorizationParams: { organization: org } })
    },
    [loginWithRedirect],
  )
  const canSwitchTenant = useCallback(
    (tenantId: string) => organizationForTenant(tenantId, localStorage) !== undefined,
    [],
  )
  const rememberTenant = useCallback((tenantId: string, orgId: string) => {
    rememberTenantOrganization(tenantId, orgId, localStorage)
    localStorage.setItem(LAST_ORG_KEY, orgId)
  }, [])

  const orgClaim = typeof user?.org_id === 'string' ? user.org_id : undefined
  useEffect(() => {
    if (orgClaim) localStorage.setItem(LAST_ORG_KEY, orgClaim)
  }, [orgClaim])

  const value = useMemo<AuthState>(
    () => ({
      mode: 'auth0',
      status: isLoading ? 'loading' : isAuthenticated ? 'authenticated' : 'unauthenticated',
      getToken,
      signOut,
      ...(canSwitch ? { switchTenant, canSwitchTenant } : {}),
      rememberTenant,
    }),
    [isLoading, isAuthenticated, getToken, signOut, canSwitch, switchTenant, canSwitchTenant, rememberTenant],
  )

  if (isLoading) return <p className="p-6">Loading…</p>
  if (!isAuthenticated) {
    return (
      <Auth0LoginPage
        organization={organization}
        error={error?.message}
        onLogin={() =>
          void loginWithRedirect({
            appState: { returnTo: window.location.pathname + window.location.search },
          })
        }
      />
    )
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
