import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { adminHandlers, newAdminFake, type AdminFake } from '../../test/adminFixtures'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { RequireAdmin } from '../../pages/RequireAdmin'
import { MembersPage } from './MembersPage'

let fake: AdminFake

beforeEach(() => {
  fake = newAdminFake()
  server.use(...adminHandlers(fake))
})

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<MembersPage />)
  await screen.findByRole('table', { name: 'Members' })
  return { user, ...view }
}

function row(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) })
}

function patches(path: string) {
  return fake.requests.filter((r) => r.method === 'PATCH' && r.path === path)
}

function describedText(el: HTMLElement) {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

describe('MembersPage', () => {
  it('lists members with role and scope, and marks pending invitations as Invited', async () => {
    fake.members[1] = {
      ...fake.members[1]!,
      scope: { orgUnitIds: ['seg-a', 'prod-1'], metricKeys: ['on_time_pct'] },
    }
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Members' })).toBeTruthy()
    const admin = row('Test Admin')
    expect(within(admin).getByText('admin@example.test')).toBeTruthy()
    expect((within(admin).getByLabelText('Role for Test Admin') as HTMLSelectElement).value).toBe('admin')
    expect(within(admin).getByText('All org units · All metrics')).toBeTruthy()
    expect(within(admin).queryByText('Invited')).toBeNull()

    const viewer = row('Test Viewer')
    await waitFor(() =>
      expect(within(viewer).getByText(/2 org units: Segment A, Product One · 1 metric: On-time delivery/)).toBeTruthy(),
    )

    const pending = row('new@example.test')
    expect(within(pending).getByText('Invited')).toBeTruthy()
    expect((within(pending).getByLabelText('Role for new@example.test') as HTMLSelectElement).value).toBe('contributor')
  })

  it('shows a load error', async () => {
    server.use(
      http.get(`${API}/v1/members`, () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'admins only' } }, { status: 403 }),
      ),
    )
    renderApp(<MembersPage />)
    expect((await screen.findByText(/Could not load members: admins only/)).getAttribute('role')).toBe('alert')
  })

  it('is for admins only', async () => {
    state.role = 'viewer'
    renderApp(
      <Routes>
        <Route element={<RequireAdmin />}>
          <Route path="*" element={<MembersPage />} />
        </Route>
      </Routes>,
    )
    expect(await screen.findByText('Only admins can open this page.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  describe('role', () => {
    it('changes a role with a PATCH of just the role', async () => {
      const { user } = await setup()
      await user.selectOptions(screen.getByLabelText('Role for Test Viewer'), 'contributor')
      await waitFor(() => expect(patches('/members/dev|viewer')).toHaveLength(1))
      expect(patches('/members/dev|viewer')[0]?.body).toEqual({ role: 'contributor' })
      await waitFor(() =>
        expect((screen.getByLabelText('Role for Test Viewer') as HTMLSelectElement).value).toBe('contributor'),
      )
    })

    it('changes the role of a pending invitation by its pending user ID', async () => {
      const { user } = await setup()
      await user.selectOptions(screen.getByLabelText('Role for new@example.test'), 'viewer')
      await waitFor(() => expect(patches('/members/pending:new@example.test')).toHaveLength(1))
      expect(patches('/members/pending:new@example.test')[0]?.body).toEqual({ role: 'viewer' })
    })

    it('shows the last-admin message inline, keeps the old role, and links it to the select', async () => {
      fake.failNext.set('PATCH /members/dev|admin', {
        status: 400,
        code: 'invalid',
        message: 'tenant must keep at least one admin',
      })
      const { user } = await setup()
      const select = screen.getByLabelText('Role for Test Admin') as HTMLSelectElement
      await user.selectOptions(select, 'viewer')
      await waitFor(() => expect(select.getAttribute('aria-invalid')).toBe('true'))
      expect(describedText(select)).toContain('tenant must keep at least one admin')
      expect(select.value).toBe('admin')
      // The next successful change clears it.
      await user.selectOptions(screen.getByLabelText('Role for Test Viewer'), 'contributor')
      await waitFor(() => expect(patches('/members/dev|viewer')).toHaveLength(1))
      await waitFor(() => expect(screen.queryByText('tenant must keep at least one admin')).toBeNull())
    })
  })

  describe('scope', () => {
    it('offers units and the metrics of the published version, filters by search, and PATCHes the selection', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit scope for Test Viewer' }))
      const dialog = await screen.findByRole('dialog', { name: 'Scope for Test Viewer' })
      // Metrics come from the published version only (the draft has none).
      await within(dialog).findByRole('checkbox', { name: 'On-time delivery' })
      expect(within(dialog).getByRole('checkbox', { name: 'Defect rate' })).toBeTruthy()

      await user.type(within(dialog).getByLabelText('Search org units'), 'prod')
      expect(within(dialog).queryByRole('checkbox', { name: 'Segment A' })).toBeNull()
      await user.click(within(dialog).getByRole('checkbox', { name: 'Product One' }))
      await user.clear(within(dialog).getByLabelText('Search org units'))
      await user.click(within(dialog).getByRole('checkbox', { name: 'Segment A' }))
      await user.click(within(dialog).getByRole('checkbox', { name: 'On-time delivery' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save scope' }))

      await waitFor(() => expect(patches('/members/dev|viewer')).toHaveLength(1))
      expect(patches('/members/dev|viewer')[0]?.body).toEqual({
        scope: { orgUnitIds: ['seg-a', 'prod-1'], metricKeys: ['on_time_pct'] },
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() =>
        expect(within(row('Test Viewer')).getByText(/2 org units: Segment A, Product One · 1 metric: On-time delivery/)).toBeTruthy(),
      )
    })

    it('starts from the current scope and can clear it back to everything', async () => {
      fake.members[1] = {
        ...fake.members[1]!,
        scope: { orgUnitIds: ['seg-a'], metricKeys: ['on_time_pct'] },
      }
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit scope for Test Viewer' }))
      const dialog = await screen.findByRole('dialog', { name: 'Scope for Test Viewer' })
      const seg = await within(dialog).findByRole('checkbox', { name: 'Segment A' })
      expect((seg as HTMLInputElement).checked).toBe(true)
      await user.click(seg)
      await user.click(within(dialog).getByRole('checkbox', { name: 'On-time delivery' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save scope' }))
      await waitFor(() => expect(patches('/members/dev|viewer')).toHaveLength(1))
      expect(patches('/members/dev|viewer')[0]?.body).toEqual({ scope: { orgUnitIds: [], metricKeys: [] } })
    })

    it('shows an API error about the scope in the dialog', async () => {
      fake.failNext.set('PATCH /members/dev|viewer', {
        status: 400,
        code: 'invalid',
        message: 'request validation failed',
        details: [{ path: 'scope.orgUnitIds[0]', message: 'org unit "seg-a" does not exist' }],
      })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit scope for Test Viewer' }))
      const dialog = await screen.findByRole('dialog', { name: 'Scope for Test Viewer' })
      await user.click(await within(dialog).findByRole('checkbox', { name: 'Segment A' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save scope' }))
      const group = within(dialog).getByRole('group', { name: 'Org units' })
      await waitFor(() => expect(describedText(group)).toContain('does not exist'))
      expect(document.activeElement).toBe(group)
      expect(describedText(group)).toContain('org unit "seg-a" does not exist')
    })
  })

  describe('invite', () => {
    async function openInvite(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'Invite member' }))
      return screen.findByRole('dialog', { name: 'Invite member' })
    }

    it('invites by email with a role and scope, and lists the pending member', async () => {
      const { user } = await setup()
      const dialog = await openInvite(user)
      await user.type(within(dialog).getByLabelText('Email'), 'Jane.Doe@example.test')
      await user.selectOptions(within(dialog).getByLabelText('Role'), 'contributor')
      await user.click(await within(dialog).findByRole('checkbox', { name: 'Segment A' }))
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
      await waitFor(() => expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/members')).toHaveLength(1))
      expect(fake.requests.find((r) => r.method === 'POST' && r.path === '/members')?.body).toEqual({
        email: 'Jane.Doe@example.test',
        role: 'contributor',
        scope: { orgUnitIds: ['seg-a'], metricKeys: [] },
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const pending = await screen.findByRole('row', { name: /Jane\.Doe@example\.test/ })
      expect(within(pending).getByText('Invited')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toContain('Invited Jane.Doe@example.test')
    })

    it('shows a 409 for an address that is already invited or a member, at the email field', async () => {
      fake.failNext.set('POST /members', {
        status: 409,
        code: 'conflict',
        message: 'an invitation for new@example.test already exists',
      })
      const { user } = await setup()
      const dialog = await openInvite(user)
      const email = within(dialog).getByLabelText('Email')
      await user.type(email, 'new@example.test')
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
      await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))
      expect(describedText(email)).toContain('an invitation for new@example.test already exists')
      expect(document.activeElement).toBe(email)
      // The dialog stays open with what was typed.
      expect((email as HTMLInputElement).value).toBe('new@example.test')
    })

    it('checks the email before sending and focuses it', async () => {
      const { user } = await setup()
      const dialog = await openInvite(user)
      await user.type(within(dialog).getByLabelText('Email'), 'not-an-email')
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
      const email = within(dialog).getByLabelText('Email')
      expect(email.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(email)
      expect(fake.requests.filter((r) => r.path === '/members')).toHaveLength(0)
    })

    it('maps an API validation detail onto the email field', async () => {
      fake.failNext.set('POST /members', {
        status: 400,
        code: 'invalid',
        message: 'request validation failed',
        details: [{ path: 'email', message: 'must be a valid email address' }],
      })
      const { user } = await setup()
      const dialog = await openInvite(user)
      await user.type(within(dialog).getByLabelText('Email'), 'a@b.c')
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
      const email = within(dialog).getByLabelText('Email')
      await waitFor(() => expect(describedText(email)).toContain('must be a valid email address'))
    })
  })

  describe('accessibility', () => {
    it('has no axe violations on the page, with an error showing, and in the dialogs', async () => {
      fake.failNext.set('PATCH /members/dev|admin', {
        status: 400,
        code: 'invalid',
        message: 'tenant must keep at least one admin',
      })
      const { user, container } = await setup()
      expect((await axe(container)).violations).toEqual([])

      await user.selectOptions(screen.getByLabelText('Role for Test Admin'), 'viewer')
      await screen.findByText('tenant must keep at least one admin')
      expect((await axe(container)).violations).toEqual([])

      for (const [open, title] of [
        ['Invite member', 'Invite member'],
        ['Edit scope for Test Viewer', 'Scope for Test Viewer'],
      ] as const) {
        const trigger = screen.getByRole('button', { name: open })
        await user.click(trigger)
        const dialog = await screen.findByRole('dialog', { name: title })
        await within(dialog).findByRole('checkbox', { name: 'On-time delivery' })
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect((await axe(dialog)).violations).toEqual([])
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(document.activeElement).toBe(trigger)
      }
    })
  })
})
