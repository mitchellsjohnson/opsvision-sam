import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { tenant } from '../../test/fixtures'
import { Breakdown } from './Breakdown'
import { buildTrendColumns } from './columns'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

const scale = tenant.statusScale
const columns = buildTrendColumns('2026-M10', 1)
const OCT = '2026-M10'

function cell(subjectId: string, period: string, over: Partial<Cell> = {}): Cell {
  return {
    metricKey: 'on_time_pct',
    subjectId,
    period,
    ytd: false,
    value: 95,
    display: '95.0%',
    status: 'G',
    naReason: '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
    ...over,
  }
}

function row(subjectId: string, name: string, oct: Partial<Cell>, over: Partial<ViewRow> = {}): ViewRow {
  return {
    metricKey: 'on_time_pct',
    metricName: 'On-time delivery',
    categoryId: 'delivery',
    subjectId,
    subjectName: name,
    subjectKind: 'unit',
    format: 'percent1',
    depth: 1,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'ratio',
    cells: columns.map((c) => cell(subjectId, c.period, c.period === OCT ? oct : {})),
    ...over,
  }
}

const head = row('root', 'All units', { value: 84.3, display: '84.3%', status: 'Y', target: 90 }, { depth: 0 })
const children = [
  row('unit-b', 'Unit B', { value: 95, display: '95.0%', status: 'G', change: 1, changeKind: 'delta' }),
  row('unit-a', 'Unit A', { value: 70, display: '70.0%', status: 'R', change: -5, changeKind: 'delta' }),
  row('unit-c', 'Unit C', { value: 85, display: '85.0%', status: 'Y', change: 0.5, changeKind: 'delta' }),
]
const noun = { one: 'segment', many: 'segments' }

function renderBreakdown(over: Partial<Parameters<typeof Breakdown>[0]> = {}) {
  const props = {
    head,
    children,
    columns,
    columnKey: OCT,
    scale,
    direction: 'higher_better' as const,
    noun,
    onScope: vi.fn(),
    ...over,
  }
  render(<Breakdown {...props} />)
  return props
}

const names = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)

describe('Breakdown', () => {
  it('is a table headed by the level noun, worst first', async () => {
    renderBreakdown()
    const section = screen.getByRole('region', { name: 'By segment' })
    expect(within(section).getByRole('heading', { level: 3, name: 'By segment' })).toBeTruthy()
    expect(within(section).getByText('Worst first · choose a segment to scope the dashboard to it')).toBeTruthy()
    expect(names()).toEqual(['Unit A', 'Unit C', 'Unit B'])
    const headers = within(section).getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toEqual(['Segment', 'Last 12 months', 'Oct', 'vs Sep', 'vs goal 90.0%'])
    expect((await axe(section)).violations).toEqual([])
  })

  it('shows each row’s value, chip, change and a decorative 12-month ribbon', () => {
    renderBreakdown()
    const unitA = screen.getByRole('rowheader', { name: 'Unit A' }).closest('tr')!
    expect(within(unitA).getByText('70.0%')).toBeTruthy()
    expect(within(unitA).getByRole('img', { name: 'Red' })).toBeTruthy()
    const change = within(unitA).getByText('-5.0 pts')
    expect(change.closest('[data-tone]')!.getAttribute('data-tone')).toBe('bad')
    const ribbon = unitA.querySelector('[data-ribbon]')!
    expect(ribbon.getAttribute('aria-hidden')).toBe('true')
    expect(ribbon.children).toHaveLength(12)
  })

  it('worst first by default claims no aria-sort; header clicks sort and set it', async () => {
    renderBreakdown()
    const user = userEvent.setup()
    const valueHeader = screen.getByRole('columnheader', { name: 'Oct' })
    const nameHeader = screen.getByRole('columnheader', { name: 'Segment' })
    const changeHeader = screen.getByRole('columnheader', { name: 'vs Sep' })
    // Worst first orders by status, then value: not a sort on any one column.
    for (const th of [valueHeader, nameHeader, changeHeader]) expect(th.getAttribute('aria-sort')).toBe('none')
    await user.click(within(valueHeader).getByRole('button'))
    expect(valueHeader.getAttribute('aria-sort')).toBe('ascending')
    expect(names()).toEqual(['Unit A', 'Unit C', 'Unit B'])
    await user.click(within(valueHeader).getByRole('button'))
    expect(valueHeader.getAttribute('aria-sort')).toBe('descending')
    expect(names()).toEqual(['Unit B', 'Unit C', 'Unit A'])
    // A third click goes back to worst first.
    await user.click(within(valueHeader).getByRole('button'))
    expect(valueHeader.getAttribute('aria-sort')).toBe('none')
    expect(names()).toEqual(['Unit A', 'Unit C', 'Unit B'])
    await user.click(within(nameHeader).getByRole('button'))
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending')
    expect(valueHeader.getAttribute('aria-sort')).toBe('none')
    expect(names()).toEqual(['Unit A', 'Unit B', 'Unit C'])
    await user.click(within(nameHeader).getByRole('button'))
    expect(nameHeader.getAttribute('aria-sort')).toBe('descending')
    expect(names()).toEqual(['Unit C', 'Unit B', 'Unit A'])
    await user.click(within(changeHeader).getByRole('button'))
    expect(changeHeader.getAttribute('aria-sort')).toBe('ascending')
    expect(names()).toEqual(['Unit A', 'Unit C', 'Unit B'])
  })

  it('worst first ranks status before value: a Red row with a higher value still leads', () => {
    const odd = [
      row('unit-x', 'Unit X', { value: 96, display: '96.0%', status: 'R' }),
      row('unit-y', 'Unit Y', { value: 60, display: '60.0%', status: 'G' }),
    ]
    renderBreakdown({ children: odd })
    expect(names()).toEqual(['Unit X', 'Unit Y'])
    expect(screen.getByRole('columnheader', { name: 'Oct' }).getAttribute('aria-sort')).toBe('none')
  })

  it('the change header names the prior period in the tenant’s fiscal calendar', () => {
    // With a July fiscal start, fiscal 2027-M04 is Oct 2026 and its prior month is Sep.
    const oct = buildTrendColumns('2027-M04', 7).slice(-1)
    const kids = children.map((c) => ({ ...c, cells: [cell(c.subjectId, '2027-M04', { change: 1, changeKind: 'delta' })] }))
    renderBreakdown({ columns: oct, columnKey: '2027-M04', children: kids, fyStart: 7, head: { ...head, cells: [cell('root', '2027-M04', { target: 90 })] } })
    expect(screen.getByRole('columnheader', { name: 'vs Sep' })).toBeTruthy()
  })

  it('an org row is a button that scopes the dashboard to it', async () => {
    const props = renderBreakdown()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unit A' }))
    expect(props.onScope).toHaveBeenCalledWith('unit-a')
  })

  it('a number-format metric has no vs goal column', () => {
    const numberHead: ViewRow = { ...head, format: 'number1', cells: head.cells.map((c) => ({ ...c, target: 5 })) }
    renderBreakdown({ head: numberHead, children: children.map((c): ViewRow => ({ ...c, format: 'number1' })) })
    expect(screen.queryByRole('columnheader', { name: /vs goal/ })).toBeNull()
  })

  it('rows with their own goals: the header says vs goal and each tick names its goal', () => {
    const own = children.map((c, i) => ({
      ...c,
      cells: c.cells.map((x) => (x.period === OCT ? { ...x, target: [95, 90, 85][i]! } : x)),
    }))
    renderBreakdown({ children: own })
    expect(screen.getByRole('columnheader', { name: 'vs goal' })).toBeTruthy()
    const tick = (name: string) => screen.getByRole('rowheader', { name }).closest('tr')!.querySelector('[data-goal-tick]')!
    expect(tick('Unit B').getAttribute('title')).toBe('Goal 95.0%')
    expect(tick('Unit A').getAttribute('title')).toBe('Goal 90.0%')
    expect(tick('Unit C').getAttribute('title')).toBe('Goal 85.0%')
  })

  it('one goal for all rows: the header names it', () => {
    renderBreakdown()
    const tick = screen.getByRole('rowheader', { name: 'Unit A' }).closest('tr')!.querySelector('[data-goal-tick]')!
    expect(tick.getAttribute('title')).toBe('Goal 90.0%')
    expect(screen.getByRole('columnheader', { name: 'vs goal 90.0%' })).toBeTruthy()
  })

  it('a percent metric with no target has no vs goal column', () => {
    renderBreakdown({ head: { ...head, cells: head.cells.map((c) => ({ ...c, target: null })) } })
    expect(screen.queryByRole('columnheader', { name: /vs goal/ })).toBeNull()
  })

  it('item rows open the item when a handler is given, and are plain names otherwise', async () => {
    const items = children.map((c) => ({ ...c, subjectKind: 'item' as const }))
    const onOpenItem = vi.fn()
    renderBreakdown({ children: items, noun: { one: 'service', many: 'services' }, onOpenItem })
    expect(screen.getByRole('heading', { name: 'By service' })).toBeTruthy()
    expect(screen.getByText('Worst first · choose a service to see its trend')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unit A' }))
    expect(onOpenItem).toHaveBeenCalledWith('unit-a')
  })

  it('item rows without a handler are not buttons', () => {
    const items = children.map((c) => ({ ...c, subjectKind: 'item' as const }))
    renderBreakdown({ children: items, noun: { one: 'service', many: 'services' } })
    expect(screen.queryByRole('button', { name: 'Unit A' })).toBeNull()
    expect(screen.getByText('Worst first')).toBeTruthy()
  })

  it('rows with nothing reported in the column come last, by name', () => {
    const quiet = row('unit-z', 'Aardvark unit', { value: null, display: '', status: '' })
    renderBreakdown({ children: [...children, quiet] })
    expect(names()).toEqual(['Unit A', 'Unit C', 'Unit B', 'Aardvark unit'])
    const tr = screen.getByRole('rowheader', { name: 'Aardvark unit' }).closest('tr')!
    expect(within(tr).getByText('Not reported')).toBeTruthy()
  })
})
