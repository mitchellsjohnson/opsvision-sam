import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
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

  it('the view options button names the restated version', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10&restate=ver-2')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    expect(await within(bar).findByRole('button', { name: 'Under FY27 proposal' })).toBeTruthy()
    expect(within(bar).queryByRole('button', { name: 'As reported' })).toBeNull()
  })

  it('shows Report as coming soon, not as a link to a placeholder', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const views = screen.getByRole('navigation', { name: 'Scorecard views' })
    expect(within(views).queryByRole('link', { name: /Report/ })).toBeNull()
    expect(within(views).getByText('Report').closest('[aria-disabled="true"]')?.textContent).toMatch(/Coming soon/)
  })

  it('an old report link opens the overview', async () => {
    renderScorecard('/scorecards/sc-main/report?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10'))
  })

  it('sets the sticky offset from the measured bar height', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.getAttribute('aria-label') === 'Scorecard controls' ? 112 : 0 } as DOMRect
    })
    try {
      renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
      await screen.findByRole('heading', { name: 'Overview', level: 1 })
      const bar = screen.getByRole('region', { name: 'Scorecard controls' })
      await waitFor(() =>
        expect(bar.parentElement!.style.getPropertyValue('--scorecard-control-bar-height')).toBe('112px'),
      )
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('keeps Ask SAM disabled in the control bar', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    const sam = within(bar).getByRole('button', { name: 'Ask SAM (coming soon)' })
    expect((sam as HTMLButtonElement).disabled).toBe(true)
  })
})
