import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { useMe } from '../api/queries'
import { API, server } from '../test/server'
import { newQueryClient } from '../test/utils'
import { AuthProvider } from './AuthProvider'
import { DEV_TOKEN_KEY } from './devAuth'
import { useAuth } from './context'

function Probe() {
  const me = useMe()
  const { signOut } = useAuth()
  return (
    <div>
      <p>{me.data ? `Hello ${me.data.name}` : 'loading'}</p>
      <button onClick={signOut}>Sign out</button>
    </div>
  )
}

function app() {
  return render(
    <MemoryRouter>
      <AuthProvider mode="dev" apiUrl={API}>
        <QueryClientProvider client={newQueryClient()}>
          <Probe />
        </QueryClientProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('dev AuthProvider', () => {
  it('lists the dev users, stores the token on login, and calls /v1/me with it', async () => {
    let bearer: string | null = null
    server.use(
      http.get(`${API}/v1/me`, ({ request }) => {
        bearer = request.headers.get('Authorization')
        return HttpResponse.json({
          userId: 'dev|admin',
          name: 'Test Admin',
          email: 'admin@example.test',
          isOperator: false,
          tenants: [],
        })
      }),
    )
    app()
    const user = userEvent.setup()
    expect(sessionStorage.getItem(DEV_TOKEN_KEY)).toBeNull()
    await user.click(await screen.findByRole('button', { name: /Test Admin/ }))

    expect(await screen.findByText('Hello Test Admin')).toBeTruthy()
    expect(sessionStorage.getItem(DEV_TOKEN_KEY)).toBe('token-for-dev|admin')
    expect(bearer).toBe('Bearer token-for-dev|admin')
  })

  it('stays signed in across a reload and clears the token on sign out', async () => {
    sessionStorage.setItem(DEV_TOKEN_KEY, 'existing-token')
    app()
    const user = userEvent.setup()
    expect(await screen.findByText('Hello Test admin')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(sessionStorage.getItem(DEV_TOKEN_KEY)).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })

  it('shows an error when the dev server cannot be reached', async () => {
    server.use(http.get(`${API}/dev/users`, () => HttpResponse.error()))
    app()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})
