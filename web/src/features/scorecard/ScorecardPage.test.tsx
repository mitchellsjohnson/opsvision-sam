import { screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

const location = () => screen.getByTestId('location').textContent ?? ''

function renderAt(route: string) {
  server.use(...viewHandlers())
  renderApp(
    <>
      <App />
      <Probe />
    </>,
    { route },
  )
}

describe('Scorecard redirects', () => {
  it('opens overview by default and preserves the query', async () => {
    renderAt('/scorecards/sc-main?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10'))
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeTruthy()
  })

  it('sends tab=charts to overview and removes tab', async () => {
    renderAt('/scorecards/sc-main?period=2026-M10&tab=charts')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10'))
  })

  it('sends unknown tab values to overview', async () => {
    renderAt('/scorecards/sc-main?tab=nope')
    await waitFor(() => expect(location()).toMatch(/\/scorecards\/sc-main\/overview/))
    expect(location()).not.toContain('tab=')
  })

  it('says so when the scorecard does not exist', async () => {
    renderAt('/scorecards/missing/overview?period=2026-M10')
    expect(await screen.findByRole('heading', { name: 'Scorecard not found' })).toBeTruthy()
  })
})
