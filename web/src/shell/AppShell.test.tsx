import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import { renderApp, testAuth } from '../test/utils'
import { meFor, tenant } from '../test/fixtures'
import { API, server, state } from '../test/server'
import { AppShell } from './AppShell'

function shell(route = '/scorecards/sc-main?period=2026-M10', auth = testAuth()) {
  return renderApp(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<p>Page content</p>} />
      </Route>
    </Routes>,
    { route, auth },
  )
}

const ADMIN_LINKS = ['Org', 'Items', 'Members', 'Methodology', 'Import', 'Record types', 'Templates']

describe('AppShell', () => {
  it('shows the admin navigation to admins', async () => {
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    for (const name of ADMIN_LINKS) {
      expect(await within(nav).findByRole('link', { name })).toBeTruthy()
    }
    expect(within(nav).getByRole('link', { name: 'Main scorecard' })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: 'Enter data' })).toBeTruthy()
  })

  it('hides the admin navigation from viewers', async () => {
    state.role = 'viewer'
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    // Wait until the identity has loaded, then check the admin links never appear.
    await screen.findByRole('button', { name: /Test viewer/ })
    for (const name of ADMIN_LINKS) {
      expect(within(nav).queryByRole('link', { name })).toBeNull()
    }
    expect(within(nav).getByRole('link', { name: 'Enter data' })).toBeTruthy()
  })

  it('has landmarks, a skip link and the disabled SAM button', async () => {
    shell()
    expect(screen.getByRole('banner')).toBeTruthy()
    const main = screen.getByRole('main')
    expect(main.textContent).toContain('Page content')
    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skip.getAttribute('href')).toBe('#main')
    expect(main.id).toBe('main')
    const sam = screen.getByRole('button', { name: 'Ask SAM (coming soon)' })
    expect((sam as HTMLButtonElement).disabled).toBe(true)
    expect(sam.textContent).toBe('S')
    expect(screen.getByText('OpsVision')).toBeTruthy()
    await screen.findByRole('button', { name: /Test admin/ })
  })

  it('signs out from the user menu', async () => {
    const signOut = vi.fn()
    shell(undefined, testAuth({ signOut }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Test admin/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('shows the period picker and subject filter on scorecard pages', async () => {
    shell()
    expect(screen.getByRole('group', { name: 'Period' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Subjects/ })).toBeTruthy())
  })

  it('has no accessibility violations', async () => {
    const { container } = shell()
    await screen.findByRole('link', { name: 'Org' })
    await screen.findByRole('button', { name: /Subjects/ })
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('AppShell focus indicators', () => {
  // axe cannot check color contrast in jsdom, so assert the classes that
  // carry the high-contrast focus styles (colors are checked in contrast.test.ts).
  const ON_DARK = ['focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-white']
  const HIGHLIGHT = ['data-[highlighted]:bg-accent', 'data-[highlighted]:text-white']

  function twoTenants() {
    server.use(
      http.get(`${API}/v1/me`, () =>
        HttpResponse.json({
          ...meFor('admin'),
          tenants: [
            { id: tenant.id, name: tenant.name },
            { id: 'tenant-2', name: 'Other Co' },
          ],
        }),
      ),
    )
  }

  it('gives every header control a white focus ring on the dark header', async () => {
    twoTenants()
    shell()
    const header = screen.getByRole('banner')
    const userMenu = await within(header).findByRole('button', { name: /Test admin/ })
    const tenantMenu = await within(header).findByRole('button', { name: /Tenant:\s*Example Co/ })
    const sam = within(header).getByRole('button', { name: 'Ask SAM (coming soon)' })
    for (const control of [userMenu, tenantMenu, sam]) {
      for (const cls of ON_DARK) expect(control.classList.contains(cls), `${cls} on ${control.textContent}`).toBe(true)
    }
  })

  it('shows a skip link ring that is visible on the header', () => {
    shell()
    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skip.classList.contains('focus:outline-amber')).toBe(true)
  })

  it('highlights user menu items with a high-contrast background', async () => {
    shell()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Test admin/ }))
    const item = await screen.findByRole('menuitem', { name: 'Sign out' })
    for (const cls of HIGHLIGHT) expect(item.classList.contains(cls), cls).toBe(true)
    expect(item.classList.contains('data-[highlighted]:bg-cream')).toBe(false)
  })

  it('highlights tenant menu items with a high-contrast background', async () => {
    twoTenants()
    shell()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Tenant:\s*Example Co/ }))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items).toHaveLength(2)
    for (const item of items) {
      for (const cls of HIGHLIGHT) expect(item.classList.contains(cls), cls).toBe(true)
    }
  })
})
