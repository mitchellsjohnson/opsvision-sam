/** Dev auth: pick a demo user from the dev server; the token lives in sessionStorage. */

export const DEV_TOKEN_KEY = 'opsvision.devToken'

export interface DevUser {
  userId: string
  email: string
  name: string
  role: string
}

export function readDevToken(): string | null {
  return sessionStorage.getItem(DEV_TOKEN_KEY)
}

export function storeDevToken(token: string): void {
  sessionStorage.setItem(DEV_TOKEN_KEY, token)
}

export function clearDevToken(): void {
  sessionStorage.removeItem(DEV_TOKEN_KEY)
}

export async function fetchDevUsers(apiUrl: string, signal?: AbortSignal): Promise<DevUser[]> {
  const res = await fetch(`${apiUrl}/dev/users`, { signal })
  if (!res.ok) throw new Error(`The dev server answered ${res.status}`)
  return (await res.json()) as DevUser[]
}

export async function devLogin(apiUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${apiUrl}/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
  if (!res.ok) throw new Error(`Sign-in failed (${res.status})`)
  const body = (await res.json()) as { token: string }
  return body.token
}
