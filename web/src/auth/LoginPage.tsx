import { useEffect, useState, type ReactNode } from 'react'
import { fetchDevUsers, devLogin, type DevUser } from './devAuth'

function Card({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-lg border border-ink/15 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-accent-deep">Sign in</h1>
        <p className="mt-1 text-sm text-ink/80">OpsVision</p>
        {children}
      </div>
    </main>
  )
}

type Users =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; users: DevUser[] }

/** Dev auth: choose one of the dev server's demo users. */
export function DevLoginPage({
  apiUrl,
  onLogin,
}: {
  apiUrl: string
  onLogin: (token: string) => void
}) {
  const [users, setUsers] = useState<Users>({ status: 'loading' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchDevUsers(apiUrl, controller.signal).then(
      (list) => setUsers({ status: 'ready', users: list }),
      (err: unknown) => {
        if (controller.signal.aborted) return
        const reason = err instanceof Error ? err.message : 'unknown error'
        setUsers({ status: 'error', message: `Cannot reach the dev server at ${apiUrl}: ${reason}` })
      },
    )
    return () => controller.abort()
  }, [apiUrl])

  async function choose(user: DevUser) {
    setError(null)
    try {
      onLogin(await devLogin(apiUrl, user.userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    }
  }

  return (
    <Card>
      <p className="mt-4 text-sm">
        Development sign-in. Choose a demo user.
      </p>
      {users.status === 'loading' && <p className="mt-4 text-sm">Loading users…</p>}
      {users.status === 'error' && (
        <p role="alert" className="mt-4 text-sm font-medium text-status-r">
          {users.message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-status-r">
          {error}
        </p>
      )}
      {users.status === 'ready' && (
        <ul className="mt-4 space-y-2">
          {users.users.map((u) => (
            <li key={u.userId}>
              <button
                type="button"
                onClick={() => void choose(u)}
                className="flex w-full items-center justify-between rounded-md border border-ink/20 px-3 py-2 text-left hover:bg-cream"
              >
                <span>
                  <span className="block font-medium">{u.name}</span>
                  <span className="block text-sm text-ink/80">{u.email}</span>
                </span>
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">
                  {u.role}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** Auth0 mode: a single button that starts the hosted login. */
export function Auth0LoginPage({
  organization,
  error,
  onLogin,
}: {
  organization?: string
  error?: string
  onLogin: () => void
}) {
  return (
    <Card>
      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-status-r">
          {error}
        </p>
      )}
      <p className="mt-4 text-sm">
        {organization ? `Sign in to organization ${organization}.` : 'Sign in to continue.'}
      </p>
      <button
        type="button"
        onClick={onLogin}
        className="mt-4 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-deep"
      >
        Sign in
      </button>
    </Card>
  )
}
