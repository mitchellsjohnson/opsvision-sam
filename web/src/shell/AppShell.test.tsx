import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import { renderApp, testAuth } from '../test/utils'
import { state } from '../test/server'
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

const ADMIN_LINKS = ['Org', 'Items', 'Members', 'Methodology', 'Import']

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
