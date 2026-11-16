import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { filterHandlers } from '../../test/filterFixtures'
import { server } from '../../test/server'
import { reportHandlers } from '../../test/reportFixtures'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

function LocationProbe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

const location = () => screen.getByTestId('location').textContent ?? ''

function renderScorecard(route: string) {
  server.use(...viewHandlers())
  return renderApp(
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

  it('Report is a view link like Overview and Table, keeping the query', async () => {
    server.use(...reportHandlers())
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const views = screen.getByRole('navigation', { name: 'Scorecard views' })
    expect(within(views).queryByText(/Coming soon/)).toBeNull()
    await userEvent.setup().click(within(views).getByRole('link', { name: 'Report' }))
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/report?period=2026-M10'))
    expect(await screen.findByRole('heading', { name: 'Report', level: 1 })).toBeTruthy()
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

  it('offers Ask SAM in the control bar', async () => {
    renderScorecard('/scorecards/sc-main/overview?period=2026-M10')
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    const sam = within(bar).getByRole('button', { name: 'Ask SAM' })
    expect((sam as HTMLButtonElement).disabled).toBe(false)
    expect(sam.getAttribute('aria-haspopup')).toBe('dialog')
    expect(sam.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('Global filters', () => {
  function renderFilters(route: string, options: { defaultScope?: string } = {}) {
    const fixtures = filterHandlers(options)
    server.use(...fixtures.handlers)
    const view = renderScorecard(route)
    return { ...fixtures, ...view }
  }

  async function filters() {
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const group = screen.getByRole('group', { name: 'Global filters' })
    await within(group).findByRole('option', { name: 'Unit A' })
    return group
  }

  const optionNames = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)
  const selected = (select: HTMLElement) => (select as HTMLSelectElement).selectedOptions[0]?.textContent

  it('comes first in the bar with a labeled select per level below the company', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10')
    const group = await filters()
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    expect(bar.firstElementChild).toBe(group)
    const segment = within(group).getByLabelText('Segment')
    const product = within(group).getByLabelText('Product')
    expect(optionNames(segment)).toEqual(['All Segments', 'Unit A', 'Unit B'])
    expect(optionNames(product)).toEqual(['All Products', 'Unit A1', 'Unit A2', 'Unit B1'])
    expect(selected(segment)).toBe('All Segments')
    expect(selected(product)).toBe('All Products')
    expect(within(group).queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('choosing a segment scopes the URL and narrows the products', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10')
    const group = await filters()
    const user = userEvent.setup()
    await user.selectOptions(within(group).getByLabelText('Segment'), 'Unit A')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10&scope=seg-a'))
    expect(optionNames(within(group).getByLabelText('Product'))).toEqual(['All Products', 'Unit A1', 'Unit A2'])
  })

  it('choosing a product directly also sets its segment', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10')
    const group = await filters()
    const user = userEvent.setup()
    await user.selectOptions(within(group).getByLabelText('Product'), 'Unit B1')
    await waitFor(() => expect(location()).toContain('scope=prod-b1'))
    expect(selected(within(group).getByLabelText('Segment'))).toBe('Unit B')
    expect(selected(within(group).getByLabelText('Product'))).toBe('Unit B1')
  })

  it('choosing All Products keeps the segment; All Segments returns to the company', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=prod-a1')
    const group = await filters()
    const user = userEvent.setup()
    await user.selectOptions(within(group).getByLabelText('Product'), 'All Products')
    await waitFor(() => expect(location()).toContain('scope=seg-a'))
    await user.selectOptions(within(group).getByLabelText('Segment'), 'All Segments')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10'))
  })

  it('hides units retired at or before the selected period', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M07&scope=seg-b')
    let group = await filters()
    expect(optionNames(within(group).getByLabelText('Product'))).toEqual(['All Products', 'Unit B1', 'Unit B9'])
    cleanup()
    renderFilters('/scorecards/sc-main/overview?period=2026-M08&scope=seg-b')
    group = await filters()
    expect(optionNames(within(group).getByLabelText('Product'))).toEqual(['All Products', 'Unit B1'])
  })

  it('Clear returns to the company and moves focus to the first filter', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=prod-a2')
    const group = await filters()
    const user = userEvent.setup()
    await user.click(within(group).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/overview?period=2026-M10'))
    expect(within(group).queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(document.activeElement).toBe(within(group).getByLabelText('Segment'))
  })

  it('saves the current scope as my default and confirms it', async () => {
    const { puts } = renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=seg-a')
    const group = await filters()
    const user = userEvent.setup()
    await user.click(await within(group).findByRole('button', { name: 'Set as my default' }))
    await waitFor(() => expect(puts).toEqual([{ defaultScope: 'seg-a' }]))
    expect(await within(group).findByText('Default saved')).toBeTruthy()
    expect(within(group).getByRole('status').textContent).toContain('Default saved')
    expect(within(group).queryByRole('button', { name: 'Set as my default' })).toBeNull()
    expect(within(group).getByText('My default')).toBeTruthy()
    expect(document.activeElement).toBe(within(group).getByText('My default'))
  })

  it('shows My default when the scope is the saved default', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=prod-b1', { defaultScope: 'prod-b1' })
    const group = await filters()
    expect(await within(group).findByText('My default')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: 'Set as my default' })).toBeNull()
    expect(within(group).queryByRole('button', { name: 'Reset to my default' })).toBeNull()
  })

  it('offers Reset to my default when the scope differs from a saved default', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10', { defaultScope: 'seg-b' })
    const group = await filters()
    const user = userEvent.setup()
    expect(await within(group).findByRole('button', { name: 'Set as my default' })).toBeTruthy()
    await user.click(within(group).getByRole('button', { name: 'Reset to my default' }))
    await waitFor(() => expect(location()).toContain('scope=seg-b'))
    expect(await within(group).findByText('My default')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: 'Reset to my default' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(group).getByText('My default')))
  })

  it.each([
    ['retired for the period', 'prod-b9'],
    ['no longer exists', 'unit-gone'],
  ])('treats a saved default that is %s as the company', async (_case, defaultScope) => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10', { defaultScope })
    const group = await filters()
    expect(await within(group).findByText('My default')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: 'Reset to my default' })).toBeNull()
    expect(within(group).queryByRole('button', { name: 'Set as my default' })).toBeNull()
  })

  it('does not offer a reset when the saved default is the company', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=seg-a')
    const group = await filters()
    expect(await within(group).findByRole('button', { name: 'Set as my default' })).toBeTruthy()
    expect(within(group).queryByRole('button', { name: 'Reset to my default' })).toBeNull()
  })

  it('has no accessibility violations', async () => {
    renderFilters('/scorecards/sc-main/overview?period=2026-M10&scope=prod-a1', { defaultScope: 'seg-b' })
    const group = await filters()
    await within(group).findByRole('button', { name: 'Reset to my default' })
    const bar = screen.getByRole('region', { name: 'Scorecard controls' })
    expect((await axe(bar)).violations).toEqual([])
  })
})
