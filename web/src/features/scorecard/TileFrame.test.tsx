import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { TileFrame } from './TileFrame'

type ViewRow = components['schemas']['ViewRow']

const HEAD: ViewRow = {
  metricKey: 'on_time_pct',
  metricName: 'On-time delivery',
  categoryId: 'delivery',
  subjectId: 'root',
  subjectName: 'All units',
  subjectKind: 'unit',
  format: 'percent1',
  depth: 0,
  direction: 'higher_better',
  frequency: 'monthly',
  chartKind: 'ratio',
  definition: '',
  cells: [],
}

function frame(over: Partial<Parameters<typeof TileFrame>[0]> = {}) {
  const onExpand = vi.fn()
  const view = render(
    <TileFrame
      head={HEAD}
      threshold="Green at 90% or better · Red below 80%"
      value={<span data-testid="value">84.3%</span>}
      onExpand={onExpand}
      state="normal"
      {...over}
    >
      <div data-testid="chart">chart</div>
    </TileFrame>,
  )
  return { onExpand, ...view }
}

describe('TileFrame', () => {
  it('is an article titled by its h3, with the threshold line under the title', () => {
    frame()
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    expect(within(tile).getByRole('heading', { level: 3, name: 'On-time delivery' })).toBeTruthy()
    const threshold = within(tile).getByText('Green at 90% or better · Red below 80%')
    expect(threshold.className).toContain('text-xs')
    expect(threshold.className).toContain('text-ink/70')
    expect(within(tile).getByTestId('value')).toBeTruthy()
    expect(within(tile).getByTestId('chart')).toBeTruthy()
  })

  it('has one Expand icon button that hands itself back as the trigger', async () => {
    const { onExpand } = frame()
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    const expand = within(tile).getByRole('button', { name: 'Expand On-time delivery' })
    expect(expand.textContent).toBe('')
    expect(expand.className).toContain('size-8')
    await userEvent.setup().click(expand)
    expect(onExpand).toHaveBeenCalledWith(expand)
    expect(within(tile).getAllByRole('button')).toHaveLength(1)
  })

  it('shows no Current line and no table link', () => {
    frame()
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    expect(within(tile).queryByText(/Current:/)).toBeNull()
    expect(within(tile).queryByRole('link', { name: 'View as table' })).toBeNull()
  })

  it('a click anywhere on the card expands it, but not a click on a control inside', async () => {
    const onExpand = vi.fn()
    render(
      <TileFrame head={HEAD} threshold="" value="84.3%" onExpand={onExpand} state="normal">
        <button type="button">Point</button>
      </TileFrame>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Point' }))
    expect(onExpand).not.toHaveBeenCalled()
    await user.click(screen.getByText('84.3%'))
    expect(onExpand).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Expand On-time delivery' }))
  })

  it('renders extras, the context sentence and a footer after a rule', () => {
    frame({ extras: 'YTD 85%', context: 'Company total not reported; 2 segments reported', footer: <a href="#x">See all</a> })
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    expect(within(tile).getByText('YTD 85%').className).toContain('text-xs')
    expect(within(tile).getByText('Company total not reported; 2 segments reported').className).toContain('text-ink/70')
    const footer = within(tile).getByRole('link', { name: 'See all' }).closest('[data-tile-footer]')!
    expect(footer.className).toContain('border-t')
  })

  it('stopped: the value reads as history, still with Expand', () => {
    frame({ state: 'stopped', value: <span>77%</span> })
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    expect(within(tile).getByText('77%').closest('[data-tile-value]')!.className).toContain('text-ink/70')
    expect(within(tile).getByRole('button', { name: 'Expand On-time delivery' })).toBeTruthy()
  })

  it('window: no plot and no Expand, only what is missing', () => {
    frame({
      state: 'window',
      value: 'No reports in the last 12 months',
      context: 'Nothing has been entered for Nov 2025 – Oct 2026.',
    })
    const tile = screen.getByRole('article', { name: 'On-time delivery' })
    expect(within(tile).getByText('No reports in the last 12 months')).toBeTruthy()
    expect(within(tile).queryByRole('button', { name: /Expand/ })).toBeNull()
    expect(within(tile).queryByTestId('chart')).toBeNull()
  })

  it('has no axe violations', async () => {
    const { container } = frame({ context: 'Reported quarterly', footer: <a href="#x">Enter data</a> })
    expect((await axe(container)).violations).toEqual([])
  })
})
