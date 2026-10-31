import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { AuthContext, type AuthState } from '../auth/context'

export function testAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    mode: 'dev',
    status: 'authenticated',
    getToken: async () => 'test-token',
    signOut: () => {},
    switchTenant: undefined,
    ...overrides,
  }
}

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

/** Renders with a signed-in test user, a fresh query cache and a memory router. */
export function renderApp(
  ui: ReactElement,
  { route = '/', auth = testAuth() }: { route?: string; auth?: AuthState } = {},
) {
  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={newQueryClient()}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}
