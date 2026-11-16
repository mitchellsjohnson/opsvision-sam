import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { App } from '../../App'
import { AuthContext } from '../../auth/context'
import { API, server, state } from '../../test/server'
import { newQueryClient, renderApp, testAuth } from '../../test/utils'
import { AccessTokensPage } from './AccessTokensPage'

type AccessToken = components['schemas']['AccessToken']

const SECRET = 'ovs_pat_Zx9QexampleSecretValue0123456789abcdefghijk'

interface Fake {
  tokens: AccessToken[]
  requests: { method: string; path: string; body?: unknown }[]
  nextId: number
  /** While set, the matching requests wait for it before answering. */
  gates: { list?: Promise<void>; create?: Promise<void>; remove?: Promise<void> }
}

let fake: Fake

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function laptop(): AccessToken {
  return {
    id: 'tok-1',
    name: 'Laptop',
    prefix: 'ovs_pat_Ab3x',
    createdAt: '2026-11-01T12:00:00Z',
    expiresAt: '2027-01-30T12:00:00Z',
    lastUsedAt: '2026-11-14T09:30:00Z',
  }
}

function script(): AccessToken {
  return {
    id: 'tok-2',
    name: 'Nightly script',
    prefix: 'ovs_pat_Qr7t',
    createdAt: '2026-11-10T08:00:00Z',
    expiresAt: '2026-12-10T08:00:00Z',
  }
}

function old(): AccessToken {
  return {
    id: 'tok-3',
    name: 'Old export',
    prefix: 'ovs_pat_Mn2k',
    createdAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-10-30T00:00:00Z',
  }
}

beforeEach(() => {
  // Only Date is faked, so the Expired label is stable; timers stay real for user-event.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
  fake = { tokens: [laptop(), script(), old()], requests: [], nextId: 10, gates: {} }
  server.use(
    http.get(`${API}/v1/me/tokens`, async () => {
      const tokens = [...fake.tokens]
      await fake.gates.list
      return HttpResponse.json({ tokens })
    }),
    http.post(`${API}/v1/me/tokens`, async ({ request }) => {
      const body = (await request.json()) as { name: string; expiresInDays: number }
      fake.requests.push({ method: 'POST', path: '/me/tokens', body })
      await fake.gates.create
      const listed: AccessToken = {
        id: `tok-${fake.nextId++}`,
        name: body.name.trim(),
        prefix: SECRET.slice(0, 12),
        createdAt: '2026-11-15T12:00:00Z',
        expiresAt: '2026-12-15T12:00:00Z',
      }
      fake.tokens.push(listed)
      return HttpResponse.json({ ...listed, token: SECRET }, { status: 201 })
    }),
    http.delete(`${API}/v1/me/tokens/:id`, async ({ params }) => {
      fake.requests.push({ method: 'DELETE', path: `/me/tokens/${String(params.id)}` })
      await fake.gates.remove
      fake.tokens = fake.tokens.filter((t) => t.id !== params.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<AccessTokensPage />)
  await screen.findByRole('table', { name: 'Access tokens' })
  return { user, ...view }
}

function row(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) })
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Create token' }))
  return screen.findByRole('dialog', { name: 'Create token' })
}

async function createToken(user: ReturnType<typeof userEvent.setup>, name = 'Desktop client') {
  const dialog = await openCreate(user)
  await user.type(within(dialog).getByLabelText('Name'), name)
  await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
  return screen.findByRole('dialog', { name: 'Copy your token' })
}

describe('AccessTokensPage', () => {
  it('lists tokens with name, prefix, created, expires and last used', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Access tokens' })).toBeTruthy()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers.slice(0, 5)).toEqual(['Name', 'Prefix', 'Created', 'Expires', 'Last used'])

    const used = row('Laptop')
    expect(within(used).getByText('ovs_pat_Ab3x…')).toBeTruthy()
    expect(within(used).getByText('2026-11-01')).toBeTruthy()
    expect(within(used).getByText('2027-01-30')).toBeTruthy()
    expect(within(used).getByText('2026-11-14 09:30 UTC')).toBeTruthy()

    expect(within(row('Nightly script')).getByText('Never')).toBeTruthy()
    // Expiry is said in words, not color alone.
    expect(within(row('Old export')).getByText('Expired')).toBeTruthy()
    expect(within(row('Laptop')).queryByText('Expired')).toBeNull()
  })

  it('says when there are no tokens yet', async () => {
    fake.tokens = []
    renderApp(<AccessTokensPage />)
    expect(await screen.findByText('You have no access tokens yet.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a load error', async () => {
    server.use(
      http.get(`${API}/v1/me/tokens`, () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'not a member of this organization' } }, { status: 403 }),
      ),
    )
    renderApp(<AccessTokensPage />)
    const alert = await screen.findByText(/Could not load access tokens: not a member of this organization/)
    expect(alert.getAttribute('role')).toBe('alert')
  })

  describe('create', () => {
    it('creates a token with a name and lifetime, and shows it once with a copy button and MCP config', async () => {
      const { user } = await setup()
      const dialog = await openCreate(user)
      expect((within(dialog).getByLabelText('Expires in') as HTMLSelectElement).value).toBe('90')
      await user.type(within(dialog).getByLabelText('Name'), '  Desktop client ')
      await user.selectOptions(within(dialog).getByLabelText('Expires in'), '30')
      await user.click(within(dialog).getByRole('button', { name: 'Create token' }))

      const reveal = await screen.findByRole('dialog', { name: 'Copy your token' })
      expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([
        { method: 'POST', path: '/me/tokens', body: { name: 'Desktop client', expiresInDays: 30 } },
      ])
      expect(within(reveal).getByText(/You won’t be able to see it again/)).toBeTruthy()
      const tokenField = within(reveal).getByLabelText('Token') as HTMLInputElement
      expect(tokenField.value).toBe(SECRET)
      const copy = within(reveal).getByRole('button', { name: 'Copy token' })
      expect(document.activeElement).toBe(copy)
      await user.click(copy)
      expect(await navigator.clipboard.readText()).toBe(SECRET)
      expect(within(reveal).getByRole('status').textContent).toBe('Token copied.')

      const configField = within(reveal).getByLabelText('MCP client configuration') as HTMLTextAreaElement
      // Browsers must not spell-check, autofill or remember the secret.
      for (const field of [tokenField, configField]) {
        expect(field.getAttribute('spellcheck')).toBe('false')
        expect(field.getAttribute('autocomplete')).toBe('off')
      }
      // The snippet is a remote-server entry; Claude Desktop needs a bridge, described in the docs.
      expect(within(reveal).getByText(/such as Cursor/)).toBeTruthy()
      const docs = within(reveal).getByRole('link', { name: /Claude Desktop/ })
      expect(docs.getAttribute('href')).toMatch(/docs\/mcp\.md#claude-desktop$/)
      const snippet = configField.value
      expect(snippet).toContain(`"url": "${API}/v1/mcp"`)
      expect(snippet).toContain(`"Authorization": "Bearer ${SECRET}"`)
      expect(() => JSON.parse(snippet) as unknown).not.toThrow()
      await user.click(within(reveal).getByRole('button', { name: 'Copy configuration' }))
      expect(await navigator.clipboard.readText()).toBe(snippet)

      // The new token is listed (without its secret) behind the dialog.
      await waitFor(() => expect(screen.getAllByText('Desktop client').length).toBeGreaterThan(0))
    })

    it('removes the secret from the page once the dialog closes', async () => {
      const { user } = await setup()
      let reveal = await createToken(user)
      await user.click(within(reveal).getByRole('button', { name: 'Done' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.body.innerHTML).not.toContain(SECRET)
      expect(row('Desktop client')).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create token' }))

      reveal = await createToken(user, 'Second')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.body.innerHTML).not.toContain(SECRET)

      // Opening the dialog again starts a fresh form, not the last secret.
      const dialog = await openCreate(user)
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('')
      expect(document.body.innerHTML).not.toContain(SECRET)
    })

    it('cannot be closed while the token is being created, and reopening never shows an earlier secret', async () => {
      const gate = deferred()
      fake.gates.create = gate.promise
      const { user } = await setup()
      const dialog = await openCreate(user)
      await user.type(within(dialog).getByLabelText('Name'), 'Desktop client')
      await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
      await within(dialog).findByRole('button', { name: 'Creating…' })

      // Escape, a click outside, Cancel and × all leave the dialog open mid-request.
      await user.keyboard('{Escape}')
      fireEvent.pointerDown(document.body)
      expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
      expect(within(dialog).getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('dialog', { name: 'Create token' })).toBe(dialog)

      gate.resolve()
      const reveal = await screen.findByRole('dialog', { name: 'Copy your token' })
      expect((within(reveal).getByLabelText('Token') as HTMLInputElement).value).toBe(SECRET)
      await user.click(within(reveal).getByRole('button', { name: 'Done' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      const again = await openCreate(user)
      expect((within(again).getByLabelText('Name') as HTMLInputElement).value).toBe('')
      expect(document.body.innerHTML).not.toContain(SECRET)
    })

    it('shows the token without waiting for the list to refresh', async () => {
      const { user } = await setup()
      const gate = deferred()
      fake.gates.list = gate.promise
      const reveal = await createToken(user)
      expect((within(reveal).getByLabelText('Token') as HTMLInputElement).value).toBe(SECRET)
      gate.resolve()
      await waitFor(() => expect(screen.getAllByText('Desktop client').length).toBeGreaterThan(0))
    })

    it('says so in a warning color when the clipboard is unavailable', async () => {
      const { user } = await setup()
      const reveal = await createToken(user)
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
      await user.click(within(reveal).getByRole('button', { name: 'Copy token' }))
      const status = within(reveal).getByRole('status')
      await waitFor(() => expect(status.textContent).toBe('Couldn’t copy. Select the token and copy it.'))
      expect(status.className).not.toContain('text-status-g')
      expect(status.className).toContain('text-status-y')
    })

    it('leaves no secret in the query client once the dialog closes', async () => {
      const user = userEvent.setup()
      const client = newQueryClient()
      const router = createMemoryRouter([{ path: '*', element: <AccessTokensPage /> }])
      render(
        <AuthContext.Provider value={testAuth()}>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </AuthContext.Provider>,
      )
      await screen.findByRole('table', { name: 'Access tokens' })
      const reveal = await createToken(user)
      const cached = () =>
        JSON.stringify([
          client.getMutationCache().getAll().map((m) => m.state),
          client.getQueryCache().getAll().map((q) => q.state),
        ])
      expect(cached()).toContain(SECRET)
      await user.click(within(reveal).getByRole('button', { name: 'Done' }))
      await waitFor(() => expect(cached()).not.toContain(SECRET))
    })

    it('asks for a name before sending', async () => {
      const { user } = await setup()
      const dialog = await openCreate(user)
      await user.type(within(dialog).getByLabelText('Name'), '   ')
      await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
      const name = within(dialog).getByLabelText('Name')
      expect(name.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(name)
      expect(fake.requests).toHaveLength(0)
    })

    it('explains the limit when the API answers 409', async () => {
      server.use(
        http.post(`${API}/v1/me/tokens`, () =>
          HttpResponse.json(
            { error: { code: 'conflict', message: 'at most 10 active access tokens per user' } },
            { status: 409 },
          ),
        ),
      )
      const { user } = await setup()
      const dialog = await openCreate(user)
      await user.type(within(dialog).getByLabelText('Name'), 'Eleventh')
      await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
      const alert = await within(dialog).findByRole('alert')
      expect(alert.textContent).toContain('You have 10 active tokens. Revoke one to create another.')
      expect(screen.queryByRole('dialog', { name: 'Copy your token' })).toBeNull()
    })
  })

  describe('revoke', () => {
    it('asks for confirmation, then deletes the token and removes it from the list', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }))
      let confirm = await screen.findByRole('alertdialog', { name: 'Revoke Laptop?' })
      expect(within(confirm).getByText(/stops working right away/)).toBeTruthy()
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(fake.requests).toHaveLength(0)

      await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }))
      confirm = await screen.findByRole('alertdialog', { name: 'Revoke Laptop?' })
      await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(fake.requests).toEqual([{ method: 'DELETE', path: '/me/tokens/tok-1' }])
      expect(screen.queryByRole('row', { name: /Laptop/ })).toBeNull()
      expect(screen.getByText('Revoked Laptop.')).toBeTruthy()
      // The row and its button are gone, so focus lands on a control that is still there.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create token' }))
    })

    it('cannot be dismissed while the revoke is in flight', async () => {
      const gate = deferred()
      fake.gates.remove = gate.promise
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }))
      const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Laptop?' })
      await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }))
      await within(confirm).findByRole('button', { name: 'Revoking…' })

      await user.keyboard('{Escape}')
      fireEvent.pointerDown(document.body)
      expect(within(confirm).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('alertdialog', { name: 'Revoke Laptop?' })).toBe(confirm)

      gate.resolve()
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(screen.getByText('Revoked Laptop.')).toBeTruthy()
    })

    it('shows a failed revoke in the confirmation', async () => {
      server.use(
        http.delete(`${API}/v1/me/tokens/:id`, () =>
          HttpResponse.json({ error: { code: 'not_found', message: 'access token not found' } }, { status: 404 }),
        ),
      )
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }))
      const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Laptop?' })
      await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }))
      expect((await within(confirm).findByRole('alert')).textContent).toContain('access token not found')
    })
  })

  describe('routing', () => {
    it('opens from /settings for a viewer, with no admin gate', async () => {
      state.role = 'viewer'
      renderApp(<App />, { route: '/settings' })
      expect(await screen.findByRole('heading', { level: 1, name: 'Access tokens' })).toBeTruthy()
      expect(await screen.findByRole('table', { name: 'Access tokens' })).toBeTruthy()
      expect(screen.queryByText('Only admins can open this page.')).toBeNull()
    })

    it('opens at /settings/tokens for a contributor', async () => {
      state.role = 'contributor'
      renderApp(<App />, { route: '/settings/tokens' })
      expect(await screen.findByRole('table', { name: 'Access tokens' })).toBeTruthy()
    })
  })

  describe('accessibility', () => {
    it('has no axe violations on the page and in each dialog', async () => {
      const { user, container } = await setup()
      expect((await axe(container)).violations).toEqual([])

      const dialog = await openCreate(user)
      expect((await axe(dialog)).violations).toEqual([])
      await user.type(within(dialog).getByLabelText('Name'), 'Desktop client')
      await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
      const reveal = await screen.findByRole('dialog', { name: 'Copy your token' })
      expect((await axe(reveal)).violations).toEqual([])
      await user.click(within(reveal).getByRole('button', { name: 'Done' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      const trigger = screen.getByRole('button', { name: 'Revoke Laptop' })
      await user.click(trigger)
      const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Laptop?' })
      expect(confirm.contains(document.activeElement)).toBe(true)
      expect((await axe(confirm)).violations).toEqual([])
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(document.activeElement).toBe(trigger)
    })
  })
})
