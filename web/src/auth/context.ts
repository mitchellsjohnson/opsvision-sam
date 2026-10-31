import { createContext, useContext } from 'react'
import type { AuthMode } from '../config'

export interface AuthState {
  mode: AuthMode
  status: 'loading' | 'authenticated' | 'unauthenticated'
  /** The bearer token for API calls; undefined when signed out. */
  getToken: () => Promise<string | undefined>
  signOut: () => void
  /** Whether the user can switch to the given tenant from this session. */
  canSwitchTenant?: (tenantId: string) => boolean
  /** Starts a session in another tenant; absent when switching is unsupported. */
  switchTenant?: (tenantId: string) => void
  /** Remembers which identity-provider organization a tenant belongs to. */
  rememberTenant?: (tenantId: string, organizationId: string) => void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
