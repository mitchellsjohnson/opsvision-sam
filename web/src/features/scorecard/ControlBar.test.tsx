import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

function LocationProbe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

const location = () => screen.getByTestId('location').textContent ?? ''

function renderScorecard(route: string) {
  server.use(...viewHandlers())
  renderApp(
    <>
      <App />
      <LocationProbe />
    </>,
    { route },
  )
}

describe('Scorecard routes', () => {
  it('redirects tab=table to the table route and drops tab', async () => {
    renderScorecard('/scorecards/sc-main?tab=table&period=2026-M09')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/table?period=2026-M09'))
    expect(await screen.findByRole('heading', { name: 'Table', level: 1 })).toBeTruthy()
  })
})

describe('ControlBar', () => {
  it('rewrites the period when quarter is chosen', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M09')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    await user.click(within(bar).getByRole('button', { name: /Period:/ }))
    const grain = await screen.findByLabelText('View by')
    await user.selectOptions(grain, 'quarter')
    await waitFor(() => expect(location()).toContain('period=2026-Q3'))
  })

  it('shows a restatement chip when a version is selected', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    await user.click(within(bar).getByRole('button', { name: 'As reported' }))
    const select = await screen.findByLabelText('View under methodology…')
    await user.selectOptions(select, 'ver-2')
    await waitFor(() => expect(location()).toContain('restate=ver-2'))
    expect(await screen.findByText('Restated under FY27 proposal')).toBeTruthy()
  })

  it('keeps Ask SAM disabled in the control bar', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    const sam = within(bar).getByRole('button', { name: 'Ask SAM (coming soon)' })
    expect((sam as HTMLButtonElement).disabled).toBe(true)
  })
})
