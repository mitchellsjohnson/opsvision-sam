import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../../api/schema'
import { windowColumns, type Column } from '../columns'
import { defaultStatusScale } from './chartTheme'
import { PeriodCards } from './PeriodCards'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

function halfRow(values: Record<string, [number, string]>): ViewRow {
  const cells: Cell[] = Object.entries(values).map(([period, [value, status]]) => ({
    metricKey: 'accessibility_compliance',
    subjectId: 'root',
    period,
    ytd: false,
    value,
    display: `${value}%`,
    status,
    naReason: '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'v',
  }))
  return {
    metricKey: 'accessibility_compliance',
    metricName: 'Accessibility compliance',
    categoryId: 'design',
    subjectId: 'root',
    subjectName: 'All units',
    subjectKind: 'unit',
    format: 'percent0',
    depth: 0,
    direction: 'higher_better',
    frequency: 'biannual',
    chartKind: 'ratio',
    definition: '',
    cells,
  }
}

function show(row: ViewRow, columns: Column[], selectedPeriod?: string) {
  return render(<PeriodCards row={row} columns={columns} selectedPeriod={selectedPeriod} scale={defaultStatusScale()} format="percent0" fy={1} />)
}

const cards = () => screen.getAllByTestId('period-card')

afterEach(() => vi.restoreAllMocks())

describe('PeriodCards', () => {
  const both = { '2025-H2': [80, 'G'], '2026-H1': [82, 'G'] } as Record<string, [number, string]>

  it('the last two periods with their months, value and status, then the next one due', () => {
    show(halfRow(both), windowColumns('2026-M10', 'half', 2, 1), '2026-M10')
    expect(cards()).toHaveLength(3)
    expect(cards().map((c) => c.firstElementChild!.textContent)).toEqual(['H2 FY25 · Jul–Dec', 'H1 FY26 · Jan–Jun', 'H2 FY26 · Jul–Dec'])
    expect(within(cards()[1]!).getByText('Green', { selector: '.sr-only' })).toBeTruthy()
    expect(cards()[2]!.textContent).toContain('Due by Jan 2027')
  })

  it('a half still in its grace month is the due card; the one before it is reported', () => {
    show(halfRow({ '2026-H1': [82, 'G'] }), windowColumns('2027-M01', 'half', 2, 1), '2027-M01')
    expect(cards().map((c) => c.textContent)).toEqual(['H1 FY26 · Jan–Jun82%●GGreen', 'H2 FY26 · Jul–DecDue by Jan 2027'])
  })

  it('past the grace month it is overdue, in Red', () => {
    show(halfRow({ '2026-H1': [82, 'G'] }), windowColumns('2027-M03', 'half', 2, 1), '2027-M03')
    const late = within(cards().at(-1)!).getByText('Overdue since Jan 2027')
    expect(late.className).toContain('text-status-r')
  })

  it('a period with no value says so', () => {
    show(halfRow({ '2026-H1': [82, 'G'] }), windowColumns('2026-M10', 'half', 2, 1), '2026-M10')
    expect(within(cards()[0]!).getByText('Not reported')).toBeTruthy()
  })

  it('three across from 360px; stacked below', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect)
    show(halfRow(both), windowColumns('2026-M10', 'half', 2, 1), '2026-M10')
    expect(screen.getByTestId('period-cards').className).toContain('grid-cols-1')
  })

  it('has no axe violations', async () => {
    show(halfRow(both), windowColumns('2026-M10', 'half', 2, 1), '2026-M10')
    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations).toEqual([])
  })
})
