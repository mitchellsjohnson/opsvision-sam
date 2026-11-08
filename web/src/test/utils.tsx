import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
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

/** Renders with a signed-in test user, a fresh query cache and a memory data router. */
export function renderApp(
  ui: ReactElement,
  {
    route = '/',
    auth = testAuth(),
  }: { route?: string | { pathname: string; search?: string; state?: unknown }; auth?: AuthState } = {},
) {
  // A data router (as in the app) so useBlocker works; one splat route renders the UI.
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [route] })
  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={newQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}
