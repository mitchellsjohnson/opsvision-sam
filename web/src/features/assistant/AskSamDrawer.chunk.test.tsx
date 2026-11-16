import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { assistantHandlers } from '../../test/assistantFixtures'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

// A stale tab after a deploy: the drawer's chunk is gone and its import rejects.
vi.mock('./AskSamDrawerBody', () => {
  throw new TypeError('Failed to fetch dynamically imported module')
})

describe('Ask SAM drawer when its code cannot load', () => {
  it('says so inside the drawer, offers a reload, and leaves the page alone', async () => {
    server.use(...viewHandlers(), ...assistantHandlers({ last4: 'x9Q2' }))
    renderApp(<App />, { route: '/scorecards/sc-main/overview?period=2026-M10&scope=unit-a' })
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    await user.click(within(bar).getByRole('button', { name: 'Ask SAM' }))
    const drawer = await screen.findByRole('dialog', { name: 'Ask SAM' })
    expect(
      (await within(drawer).findByRole('alert')).textContent,
    ).toBe('Couldn’t load Ask SAM. Reload the page to get the latest version.')
    expect(within(drawer).getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Overview', level: 1 })).toBeTruthy()
    await user.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Overview', level: 1 })).toBeTruthy()
  })
})
