import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildTrendColumns, coarseColumns, type Column } from '../columns'
import { columnsFor } from '../viewHelpers'
import { coarseGrains, coarseStatus, periodStatus } from './coarse'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

const SCALE = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]

function cell(period: string, over: Partial<Cell> = {}): Cell {
  return {
    metricKey: 'm',
    subjectId: 'root',
    period,
    ytd: false,
    value: 80,
    display: '80%',
    status: 'G',
    naReason: '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'v1',
    ...over,
  }
}

const blank = (period: string, over: Partial<Cell> = {}) => cell(period, { value: null, display: '', status: '', ...over })

function row(cells: Cell[], over: Partial<ViewRow> = {}): ViewRow {
  return {
    metricKey: 'm',
    metricName: 'Concepts delivered expected value',
    categoryId: 'delivery',
    subjectId: 'root',
    subjectName: 'Company',
    subjectKind: 'unit',
    format: 'percent0',
    depth: 0,
    direction: 'higher_better',
    frequency: 'quarterly',
    chartKind: 'discrete',
    cells,
    ...over,
  }
}

const quarters = (period: string) => coarseColumns(period, 'quarter', 4, 1)
const monthColumn = (period: string): Column => buildTrendColumns(period, 1).at(-1)!

function quarterly(period: string, cells: Cell[]) {
  return periodStatus({
    scope: row(cells),
    children: [],
    frequency: 'quarterly',
    selected: monthColumn(period),
    coarse: quarters(period),
    scale: SCALE,
    noun: 'segments',
    fy: 1,
  })
}

function monthly(cells: Cell[], children: ViewRow[] = []) {
  return periodStatus({
    scope: row(cells, { frequency: 'monthly', metricName: 'On-time delivery' }),
    children,
    frequency: 'monthly',
    selected: monthColumn('2026-M10'),
    coarse: [],
    scale: SCALE,
    noun: 'segments',
    fy: 1,
  })
}

const twelveMonths = buildTrendColumns('2026-M10', 1).map((c) => c.period)

describe('coarseGrains', () => {
  it('lists the grains coarser than the selected one that the methodology uses, in order', () => {
    expect(coarseGrains(['annual', 'monthly', 'quarterly'], 'month')).toEqual(['quarter', 'year'])
    expect(coarseGrains(['quarterly', 'biannual'], 'quarter')).toEqual(['half'])
    expect(coarseGrains(['monthly'], 'month')).toEqual([])
    expect(coarseGrains(['annual'], 'year')).toEqual([])
  })
})

describe('columnsFor', () => {
  const trend = buildTrendColumns('2026-M10', 1)
  const q = quarters('2026-M10')

  it('a coarse metric gets its own grain’s columns; others the trend', () => {
    expect(columnsFor('quarterly', 'month', trend, { quarter: q })).toBe(q)
    expect(columnsFor('monthly', 'month', trend, { quarter: q })).toBe(trend)
    expect(columnsFor('quarterly', 'quarter', trend, { quarter: q })).toBe(trend)
    // Not in the response (versions failed to load): the trend.
    expect(columnsFor('quarterly', 'month', trend, {})).toBe(trend)
  })
})

describe('coarseStatus (Oct 2026, quarterly)', () => {
  it('Q3 reported: current, counts Q3, Q4 due by Jan', () => {
    const r = row([cell('2026-Q2', { status: 'Y' }), cell('2026-Q3', { status: 'R', display: '55%' })])
    const s = coarseStatus(r, quarters('2026-M10'), '2026-M10', 1)
    expect(s.state).toBe('current')
    expect(s.counted?.period).toBe('2026-Q3')
    expect(s.cell?.status).toBe('R')
    expect(s.next).toEqual({ label: 'Q4', dueBy: 'Jan' })
  })

  it('Q3 missing in Oct with Q2 reported: due, counts Q2', () => {
    const s = coarseStatus(row([cell('2026-Q2', { status: 'Y' }), blank('2026-Q3')]), quarters('2026-M10'), '2026-M10', 1)
    expect(s.state).toBe('due')
    expect(s.counted?.period).toBe('2026-Q2')
    expect(s.cell?.status).toBe('Y')
    expect(s.next).toEqual({ label: 'Q3', dueBy: 'Oct' })
  })

  it('Q3 missing in Sep, the month it closes, is due too', () => {
    expect(coarseStatus(row([cell('2026-Q2')]), quarters('2026-M09'), '2026-M09', 1).state).toBe('due')
  })

  it('Q3 missing in Nov: overdue, counts nothing', () => {
    const s = coarseStatus(row([cell('2026-Q2'), blank('2026-Q3')]), quarters('2026-M11'), '2026-M11', 1)
    expect(s.state).toBe('overdue')
    expect(s.counted).toBeNull()
    expect(s.cell).toBeUndefined()
    expect(s.overdue?.period).toBe('2026-Q3')
  })

  it('Q3 and Q2 both missing in Oct: the overdue column is Q2', () => {
    const s = coarseStatus(row([cell('2026-Q1')]), quarters('2026-M10'), '2026-M10', 1)
    expect(s.state).toBe('overdue')
    expect(s.overdue?.period).toBe('2026-Q2')
  })

  it('only an overdue status names an overdue column', () => {
    expect(coarseStatus(row([cell('2026-Q3')]), quarters('2026-M10'), '2026-M10', 1).overdue).toBeNull()
    expect(coarseStatus(row([cell('2026-Q2'), blank('2026-Q3')]), quarters('2026-M10'), '2026-M10', 1).overdue).toBeNull()
  })

  it('the overdue column is the column itself, even when two share a label', () => {
    // Halves: H1 FY2025 and H1 FY2026 are both labelled H1.
    const halves = coarseColumns('2026-M11', 'half', 4, 1)
    const s = coarseStatus(row([cell('2025-H1', { metricKey: 'm' }), cell('2025-H2')]), halves, '2026-M11', 1)
    expect(s.state).toBe('overdue')
    expect(s.overdue?.period).toBe('2026-H1')
  })

  it('nothing reported in the window: none', () => {
    expect(coarseStatus(row(quarters('2026-M10').map((c) => blank(c.period))), quarters('2026-M10'), '2026-M10', 1).state).toBe('none')
  })
})

describe('periodStatus', () => {
  it('coarse current: Q3’s status, captioned Q3 FY2026, listed only in the quiet line', () => {
    expect(quarterly('2026-M10', [cell('2026-Q3', { status: 'G', display: '90%' })])).toEqual({
      status: 'G',
      caption: 'Q3 FY2026',
      counted: expect.objectContaining({ period: '2026-Q3' }),
      notReported: null,
      quiet: 'Concepts delivered expected value (Q3 FY2026; Q4 due by Jan)',
    })
  })

  it('coarse due: Q2’s status, captioned Q3 due by Oct', () => {
    const s = quarterly('2026-M10', [cell('2026-Q2', { status: 'Y' })])
    expect(s).toMatchObject({ status: 'Y', caption: 'Q3 due by Oct', notReported: null })
    expect(s.counted.period).toBe('2026-Q2')
    expect(s.quiet).toBe('Concepts delivered expected value (Q2 FY2026; Q3 due by Oct)')
  })

  it('coarse overdue: not reported, with when it was due', () => {
    const s = quarterly('2026-M11', [cell('2026-Q2', { status: 'Y' })])
    expect(s.status).toBe('')
    expect(s.quiet).toBeNull()
    expect(s.notReported).toEqual({ kind: 'overdue', text: 'Q3 FY2026 overdue (due by Oct 2026)' })
  })

  it('coarse, Q3 and Q2 both missing in Oct: Q2 is the one overdue', () => {
    expect(quarterly('2026-M10', [cell('2026-Q1')]).notReported).toEqual({
      kind: 'overdue',
      text: 'Q2 FY2026 overdue (due by Jul 2026)',
    })
  })

  it('coarse none: no reports in the last 4 quarters', () => {
    expect(quarterly('2026-M10', []).notReported).toEqual({ kind: 'window', text: 'No reports in the last 4 quarters' })
  })

  it('coarse n/a scope: not applicable with the reason', () => {
    expect(quarterly('2026-M10', [blank('2026-Q3', { naReason: 'No concepts closed' })]).notReported).toEqual({
      kind: 'na',
      text: 'Not applicable: No concepts closed',
    })
  })

  it('coarse with no scope value: the worst child in the counted period', () => {
    const child = (id: string, status: string) =>
      row([cell('2026-Q3', { subjectId: id, status })], { subjectId: id, subjectName: id, depth: 1 })
    const s = periodStatus({
      scope: row([]),
      children: [child('a', 'G'), child('b', 'R')],
      frequency: 'quarterly',
      selected: monthColumn('2026-M10'),
      coarse: quarters('2026-M10'),
      scale: SCALE,
      noun: 'segments',
      fy: 1,
    })
    expect(s).toMatchObject({ status: 'R', caption: 'Q3 FY2026 · worst of 2 segments', notReported: null })
  })

  it('monthly reported: the shared rule’s status and caption', () => {
    expect(monthly([cell('2026-M10', { status: 'Y' })])).toMatchObject({
      status: 'Y',
      caption: '',
      counted: expect.objectContaining({ period: '2026-M10' }),
      notReported: null,
      quiet: null,
    })
  })

  it('monthly scope n/a: not applicable with the reason', () => {
    expect(monthly([blank('2026-M10', { naReason: 'Not measured this month' })]).notReported).toEqual({
      kind: 'na',
      text: 'Not applicable: Not measured this month',
    })
  })

  it('monthly, no value in 12 months: no reports in the window', () => {
    expect(monthly(twelveMonths.map((p) => blank(p))).notReported).toEqual({ kind: 'window', text: 'No reports in the last 12 months' })
  })

  it('monthly, values until Jul: stopped, with the last value', () => {
    const cells = twelveMonths.map((p) => (p <= '2026-M07' ? cell(p, { display: p === '2026-M07' ? '77%' : '80%' }) : blank(p)))
    expect(monthly(cells).notReported).toEqual({ kind: 'stopped', text: 'Last reported Jul 2026 (77%)' })
  })

  it('monthly value with no status this period: reported, not rated', () => {
    expect(monthly([cell('2026-M10', { status: '', display: '12' })]).notReported).toEqual({
      kind: 'stopped',
      text: 'Reported Oct 2026, not rated',
    })
  })

  it('coarse value with no status in the latest quarter: reported, not rated', () => {
    expect(quarterly('2026-M10', [cell('2026-Q3', { status: '', display: '12' })]).notReported).toEqual({
      kind: 'stopped',
      text: 'Reported Q3 FY2026, not rated',
    })
  })

  it('coarse value with no status in the prior quarter while the latest is due: last reported', () => {
    expect(quarterly('2026-M10', [cell('2026-Q2', { status: '', display: '12' })]).notReported).toEqual({
      kind: 'stopped',
      text: 'Last reported Q2 FY2026 (12), not rated',
    })
  })

  it('counts each metric exactly once: statuses plus not reported equal the metric count', () => {
    const results = [
      quarterly('2026-M10', [cell('2026-Q3', { status: 'G' })]),
      quarterly('2026-M10', [cell('2026-Q2', { status: 'Y' })]),
      quarterly('2026-M11', [cell('2026-Q2', { status: 'Y' })]),
      quarterly('2026-M10', []),
      quarterly('2026-M10', [blank('2026-Q3', { naReason: 'None' })]),
      quarterly('2026-M10', [cell('2026-Q3', { status: '', display: '12' })]),
      monthly([cell('2026-M10', { status: 'R' })]),
      monthly([blank('2026-M10', { naReason: 'None' })]),
      monthly(twelveMonths.map((p) => blank(p))),
      monthly([cell('2026-M07')]),
      monthly([cell('2026-M10', { status: '', display: '12' })]),
      monthly([], [row([cell('2026-M10', { status: 'R' })], { depth: 1, frequency: 'monthly' })]),
    ]
    const counted = results.filter((r) => r.status !== '').length
    const notReported = results.filter((r) => r.notReported !== null).length
    expect(counted + notReported).toBe(results.length)
    for (const r of results) expect(r.status !== '' && r.notReported !== null).toBe(false)
  })
})
