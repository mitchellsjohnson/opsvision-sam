import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import { renderApp, testAuth } from '../test/utils'
import { meFor, tenant } from '../test/fixtures'
import { API, server, state } from '../test/server'
import { AppShell } from './AppShell'
import { useShellDock } from './ShellDock'
import { useEffect } from 'react'

function DockOpener() {
  const { setOpen } = useShellDock()
  useEffect(() => {
    setOpen(true)
    return () => setOpen(false)
  }, [setOpen])
  return <p>Drawer open</p>
}

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
    expect(sam.querySelector('img[data-sam="mark"]')).toBeTruthy()
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

  it('shows the period picker on entry only, not on scorecard placeholder pages', async () => {
    shell()
    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull()
    shell('/entry?period=2026-M10')
    expect(screen.getByRole('group', { name: 'Period' })).toBeTruthy()
  })

  it('shows icons and keeps the link labels visible when the nav is expanded', async () => {
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(nav.classList.contains('w-60')).toBe(true)
    for (const name of ['Main scorecard', 'Enter data', 'Org']) {
      const link = await within(nav).findByRole('link', { name })
      expect(link.querySelector('svg')).toBeTruthy()
      expect(link.textContent).toBe(name)
      expect(link.getAttribute('aria-label')).toBeNull()
    }
  })

  it("remembers the active tenant's organization", async () => {
    const rememberTenant = vi.fn()
    shell(undefined, testAuth({ rememberTenant }))
    await screen.findByRole('button', { name: /Test admin/ })
    expect(rememberTenant).toHaveBeenCalledWith(tenant.id, tenant.auth0OrgId)
  })

  it('does not remember a tenant without an organization', async () => {
    // A single-organization deployment's tenant has no auth0OrgId.
    server.use(
      http.get(`${API}/v1/me`, () =>
        HttpResponse.json({ ...meFor('admin'), tenant: { ...tenant, auth0OrgId: '' } }),
      ),
    )
    const rememberTenant = vi.fn()
    shell(undefined, testAuth({ rememberTenant }))
    await screen.findByRole('button', { name: /Test admin/ })
    expect(rememberTenant).not.toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    const { container } = shell()
    await screen.findByRole('link', { name: 'Org' })
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('AppShell collapsible navigation', () => {
  const KEY = 'opsvision.nav.collapsed'
  const toggleOf = (nav: HTMLElement) => within(nav).getByRole('button', { name: /navigation$/ })

  it('starts expanded with a toggle that names its action and controls the links', async () => {
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const toggle = within(nav).getByRole('button', { name: 'Collapse navigation' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(controlled).toBeTruthy()
    expect(nav.contains(controlled)).toBe(true)
    expect(within(controlled as HTMLElement).getByRole('link', { name: 'Enter data' })).toBeTruthy()
    // The toggle is the first thing in the nav.
    expect(nav.querySelector('button, a')).toBe(toggle)
  })

  it('collapses to a 64px rail, keeps link names, and persists the choice', async () => {
    shell()
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await within(nav).findByRole('link', { name: 'Org' })
    await user.click(toggleOf(nav))

    const toggle = within(nav).getByRole('button', { name: 'Expand navigation' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(nav.classList.contains('w-16')).toBe(true)
    expect(nav.classList.contains('w-60')).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('true')
    for (const name of ['Main scorecard', 'Enter data', ...ADMIN_LINKS]) {
      const link = within(nav).getByRole('link', { name })
      expect(link.getAttribute('aria-label')).toBe(name)
      expect(link.querySelector('svg')).toBeTruthy()
      expect(link.textContent).toBe('')
    }

    await user.click(toggle)
    expect(within(nav).getByRole('button', { name: 'Collapse navigation' })).toBeTruthy()
    expect(nav.classList.contains('w-60')).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('false')
  })

  it('keeps keyboard focus on the toggle when it is pressed', async () => {
    shell()
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const toggle = toggleOf(nav)
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'Expand navigation' }))
    expect(document.activeElement).toBe(toggle)
  })

  it('restores a collapsed nav from storage', async () => {
    localStorage.setItem(KEY, 'true')
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('button', { name: 'Expand navigation' }).getAttribute('aria-expanded')).toBe('false')
    expect(nav.classList.contains('w-16')).toBe(true)
  })

  it('opens collapsed on a narrow screen when nothing is stored, and an explicit choice wins', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query })) as typeof window.matchMedia
    try {
      shell()
      const nav = await screen.findByRole('navigation', { name: 'Main' })
      expect(nav.classList.contains('w-16')).toBe(true)
      expect(localStorage.getItem(KEY)).toBeNull()
    } finally {
      window.matchMedia = original
    }
  })

  it('ignores an unreadable stored value', async () => {
    localStorage.setItem(KEY, 'not-a-boolean')
    shell()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(nav.classList.contains('w-60')).toBe(true)
  })

  it('reaches every rail link and the toggle by Tab, each with a name', async () => {
    localStorage.setItem(KEY, 'true')
    shell()
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await within(nav).findByRole('link', { name: 'Templates' })
    const expected = ['Expand navigation', 'Main scorecard', 'Enter data', ...ADMIN_LINKS]
    // Start from the skip link, the first stop on the page.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to main content' }))
    const reached: string[] = []
    for (let i = 0; i < 20 && reached.length < expected.length; i++) {
      await user.tab()
      const el = document.activeElement as HTMLElement
      if (nav.contains(el)) reached.push(el.getAttribute('aria-label') ?? el.textContent ?? '')
    }
    expect(reached).toEqual(expected)
  })

  it('shows a tooltip with the link name on keyboard focus of a rail link', async () => {
    localStorage.setItem(KEY, 'true')
    shell()
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const link = await within(nav).findByRole('link', { name: 'Enter data' })
    await user.tab() // skip link
    for (let i = 0; i < 6 && document.activeElement !== link; i++) await user.tab()
    expect(document.activeElement).toBe(link)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe('Enter data')
  })

  it('has no accessibility violations when collapsed', async () => {
    localStorage.setItem(KEY, 'true')
    const { container } = shell()
    await screen.findByRole('link', { name: 'Org' })
    expect((await axe(container)).violations).toEqual([])
  })

  it('has no accessibility violations when expanded', async () => {
    const { container } = shell()
    await screen.findByRole('link', { name: 'Org' })
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
  it('links to another scorecard drop restate and the health filter; the current one keeps restate', async () => {
    server.use(
      http.get(`${API}/v1/scorecards`, () =>
        HttpResponse.json({
          scorecards: [
            { id: 'sc-main', name: 'Main scorecard', latestDataMonth: null },
            { id: 'sc-ops', name: 'Ops scorecard', latestDataMonth: null },
          ],
        }),
      ),
    )
    shell('/scorecards/sc-main/overview?period=2026-M10&scope=unit-a&restate=ver-2&health=R')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const ops = new URL((await within(nav).findByRole('link', { name: 'Ops scorecard' })).getAttribute('href')!, 'http://x')
    expect(ops.searchParams.get('period')).toBe('2026-M10')
    expect(ops.searchParams.get('scope')).toBe('unit-a')
    expect(ops.searchParams.has('restate')).toBe(false)
    expect(ops.searchParams.has('health')).toBe(false)
    const main = new URL(within(nav).getByRole('link', { name: 'Main scorecard' }).getAttribute('href')!, 'http://x')
    expect(main.searchParams.get('restate')).toBe('ver-2')
  })

  it('collapses the nav to the rail while the dock is open', async () => {
    renderApp(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<DockOpener />} />
        </Route>
      </Routes>,
      { route: '/scorecards/sc-main/table?period=2026-M10' },
    )
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await screen.findByText('Drawer open')
    expect(nav.classList.contains('w-16')).toBe(true)
    expect(within(nav).getByRole('button', { name: 'Expand navigation' }).getAttribute('aria-expanded')).toBe('false')
  })
})
