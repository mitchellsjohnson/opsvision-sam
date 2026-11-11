import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

const OVERVIEW = '/scorecards/sc-main/overview?period=2026-M10'

function renderOverview(route = OVERVIEW) {
  server.use(...viewHandlers())
  renderApp(<App />, { route })
}

function metricCard(name: string): HTMLElement {
  return screen.getByRole('article', { name: new RegExp(name) })
}

describe('FocusDialog', () => {
  it('shows a dialog named with the metric when focus is set', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('closes on Escape and clears focus from the URL', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next metric' })).toBeNull()
  })

  it('Next moves to the following metric in layout order', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Next metric' }))
    expect(await screen.findByRole('dialog', { name: /Defect rate/i })).toBeTruthy()
  })

  it('does not open focus when a chart point is clicked; empty card space sets focus', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: /Oct: 84\.3%/ }))
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    await user.click(card)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })
})
