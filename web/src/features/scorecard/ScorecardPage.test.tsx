import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { ScorecardPage } from './ScorecardPage'

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

function renderPage(route: string) {
  server.use(...viewHandlers())
  renderApp(
    <>
      <Routes>
        <Route path="/scorecards/:sc" element={<ScorecardPage />} />
      </Routes>
      <Probe />
    </>,
    { route },
  )
}

const location = () => screen.getByTestId('location').textContent ?? ''

describe('ScorecardPage', () => {
  it('shows the scorecard name and the Charts and Table tabs', async () => {
    renderPage('/scorecards/sc-main?period=2026-M10')
    expect(await screen.findByRole('heading', { name: 'Main scorecard', level: 1 })).toBeTruthy()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Charts', 'Table'])
  })

  it('defaults to the Table tab', async () => {
    renderPage('/scorecards/sc-main?period=2026-M10')
    expect((await screen.findByRole('tab', { name: 'Table' })).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('shows the Charts tab and reflects the tab in the URL and localStorage', async () => {
    renderPage('/scorecards/sc-main?period=2026-M10')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Charts' }))
    expect(await screen.findByRole('heading', { name: 'Delivery', level: 2 })).toBeTruthy()
    await waitFor(() => expect(location()).toContain('tab=charts'))
    expect(location()).toContain('period=2026-M10')
    expect(localStorage.getItem('opsvision.scorecardTab')).toBe('charts')
  })

  it('opens the remembered tab when the URL names none', async () => {
    localStorage.setItem('opsvision.scorecardTab', 'charts')
    renderPage('/scorecards/sc-main?period=2026-M10')
    expect(await screen.findByRole('heading', { name: 'Delivery', level: 2 })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Charts' }).getAttribute('aria-selected')).toBe('true')
  })

  it('lets the URL tab win over the remembered tab', async () => {
    localStorage.setItem('opsvision.scorecardTab', 'charts')
    renderPage('/scorecards/sc-main?period=2026-M10&tab=table')
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('ignores an unknown remembered tab', async () => {
    localStorage.setItem('opsvision.scorecardTab', 'nope')
    renderPage('/scorecards/sc-main?period=2026-M10')
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('says so when the scorecard does not exist', async () => {
    renderPage('/scorecards/missing?period=2026-M10')
    expect(await screen.findByRole('heading', { name: 'Scorecard not found' })).toBeTruthy()
  })
})
