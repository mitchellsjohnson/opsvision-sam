import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildTrendColumns, coarseColumns } from '../columns'
import { boardLayout, buildBoardRow, cellName, fiscalGroups, streakAt, type BoardCell } from './statusBoard'

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

function row(cells: Cell[], over: Partial<ViewRow> = {}): ViewRow {
  return {
    metricKey: 'm',
    metricName: 'On-time delivery',
    categoryId: 'delivery',
    subjectId: 'root',
    subjectName: 'Company',
    subjectKind: 'unit',
    format: 'percent0',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'ratio',
    cells,
    ...over,
  }
}

const status = (s: string): BoardCell => ({ key: s, kind: 'status', status: s, display: '', naReason: '', change: null, caption: '' })
const missing: BoardCell = { key: '-', kind: 'missing', status: '', display: '', naReason: '', change: null, caption: '' }

describe('boardLayout', () => {
  it('shows every column, unsized, before the board is measured', () => {
    expect(boardLayout(0, 12)).toEqual({ count: 12, cellWidth: null, valueColumn: true, nameWidth: null, valueWidth: 136 })
  })

  it('shows all 12 months inline with 40px cells (36px plus gutters) and the value column on a wide board', () => {
    expect(boardLayout(1150, 12)).toMatchObject({ count: 12, cellWidth: 40, valueColumn: true })
  })

  it('caps the name column at 320px on a wide board and gives the rest to the gap before Current', () => {
    expect(boardLayout(1150, 12)).toMatchObject({ nameWidth: 320, valueWidth: 1150 - 320 - 12 * 40 })
    // Narrower than the cap: the name takes what the cells and value leave.
    expect(boardLayout(600, 3)).toMatchObject({ cellWidth: 64, nameWidth: 600 - 136 - 3 * 64, valueWidth: 136 })
  })

  it('lets a short window (halves, years) use wider cells so year labels fit', () => {
    expect(boardLayout(1150, 3).cellWidth).toBe(64)
    expect(boardLayout(1150, 8).cellWidth).toBe(40)
  })

  it('prefers all columns over the value column: a half-width board stacks rather than drops months', () => {
    expect(boardLayout(560, 12)).toEqual({ count: 12, cellWidth: 46, valueColumn: false, nameWidth: null, valueWidth: 0 })
  })

  it('stacks on a phone and shows the latest 6 months, cells growing to fill the width', () => {
    expect(boardLayout(262, 12)).toMatchObject({ count: 6, cellWidth: 43, valueColumn: false })
    expect(boardLayout(400, 8).cellWidth).toBe(48)
  })

  it('halves again when 6 do not fit, never below 24px targets', () => {
    expect(boardLayout(150, 12).count).toBe(3)
    expect(boardLayout(150, 12).cellWidth).toBeGreaterThanOrEqual(28)
    expect(boardLayout(40, 12).count).toBe(1)
  })

  it('keeps all 8 quarters on a phone', () => {
    expect(boardLayout(262, 8)).toMatchObject({ count: 8, cellWidth: 32, valueColumn: false })
  })

  it.each([12, 8, 4, 3])('never shows fewer columns on a wider board (%i columns)', (total) => {
    let prior = 0
    for (let width = 200; width <= 1200; width++) {
      const { count } = boardLayout(width, total)
      expect(count, `width ${width}`).toBeGreaterThanOrEqual(prior)
      prior = count
    }
  })
})

describe('fiscalGroups', () => {
  it('splits a 12-month window at the fiscal year boundary', () => {
    const columns = buildTrendColumns('2026-M10', 1)
    expect(fiscalGroups(columns)).toEqual([
      { fy: 2025, label: 'FY2025', start: 0, span: 2 },
      { fy: 2026, label: 'FY2026', start: 2, span: 10 },
    ])
  })

  it('splits 8 quarters into two fiscal years of four', () => {
    const columns = buildTrendColumns('2026-Q4', 7)
    expect(columns.map((c) => c.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'])
    expect(fiscalGroups(columns).map((g) => [g.label, g.span])).toEqual([
      ['FY2025', 4],
      ['FY2026', 4],
    ])
  })

  it('has no groups for the year grain, whose columns already name the year', () => {
    expect(fiscalGroups(buildTrendColumns('2026-FY', 1))).toEqual([])
  })
})

describe('streakAt', () => {
  it('counts the run of the same status ending at a column', () => {
    const cells = [status('G'), status('R'), status('R'), status('R')]
    expect(streakAt(cells, 3)).toBe(3)
    expect(streakAt(cells, 1)).toBe(1)
    expect(streakAt(cells, 0)).toBe(1)
  })

  it('is zero for a cell with no status, and a gap breaks a run', () => {
    expect(streakAt([status('R'), missing, status('R')], 1)).toBe(0)
    expect(streakAt([status('R'), missing, status('R')], 2)).toBe(1)
  })
})

describe('buildBoardRow', () => {
  const columns = buildTrendColumns('2026-M10', 1).slice(-3)

  it('reads each column as a status, not applicable, or no data', () => {
    const scope = row([
      cell('2026-M08', { value: null, display: '', status: '', naReason: 'No ideas this month' }),
      cell('2026-M10', { value: 72, display: '72%', status: 'R', change: -10, changeKind: 'delta' }),
    ])
    const board = buildBoardRow({
      key: 'm',
      category: { id: 'delivery', name: 'Delivery' },
      scope,
      head: scope,
      children: [],
      noun: 'items',
      columns,
      scale: SCALE,
      fyStart: 1,
    })
    expect(board.cells.map((c) => c.kind)).toEqual(['na', 'missing', 'status'])
    expect(board.cells[0]!.naReason).toBe('No ideas this month')
    expect(board.cells[2]).toMatchObject({ status: 'R', display: '72%', change: '-10 pts vs Sep' })
    expect(board.current).toBe('72%')
    expect(board.change?.move.tone).toBe('bad')
  })

  it('takes the worst child when the scope is not reported, with the caption', () => {
    const scope = row([], { subjectId: 'root' })
    const a = row([cell('2026-M10', { status: 'G', display: '99.9%' })], { subjectId: 'a', depth: 1 })
    const b = row([cell('2026-M10', { status: 'R', display: '98.0%' })], { subjectId: 'b', depth: 1 })
    const board = buildBoardRow({
      key: 'm',
      category: { id: 'eng', name: 'Engineering' },
      scope,
      head: scope,
      children: [a, b],
      noun: 'services',
      columns,
      scale: SCALE,
      fyStart: 1,
    })
    expect(board.cells[2]).toMatchObject({ kind: 'status', status: 'R', display: '', caption: 'worst of 2 services', change: null })
    expect(board.caption).toBe('worst of 2 services')
  })
})

describe('buildBoardRow coarse', () => {
  const months = buildTrendColumns('2026-M10', 1)
  const quarters = coarseColumns('2026-M10', 'quarter', 4, 1)
  const board = (cells: Cell[], columns = months, coarse = quarters) => {
    const scope = row(cells, { frequency: 'quarterly', chartKind: 'discrete', metricName: 'Concepts delivered expected value' })
    return buildBoardRow({
      key: 'm',
      category: { id: 'delivery', name: 'Delivery' },
      scope,
      head: scope,
      children: [],
      noun: 'segments',
      columns,
      scale: SCALE,
      fyStart: 1,
      frequency: 'quarterly',
      coarse,
    })
  }

  it('a quarter’s status sits in its last month; the other months are not due', () => {
    const b = board([cell('2026-Q2', { status: 'Y', display: '70%' }), cell('2026-Q3', { status: 'G', display: '90%' })])
    const at = (label: string) => b.cells[months.findIndex((c) => c.label === label)]!
    expect(at('Sep')).toMatchObject({ key: '2026-M09', kind: 'status', status: 'G', display: '90%' })
    expect(at('Jun')).toMatchObject({ kind: 'status', status: 'Y', display: '70%' })
    expect(at('Jul').kind).toBe('notDue')
    expect(at('Aug')).toMatchObject({ kind: 'notDue', caption: 'Q3 FY2026 reports after Sep' })
    expect(at('Oct')).toMatchObject({ kind: 'notDue', caption: 'Q4 FY2026 reports after Dec' })
    expect(b.cells.filter((c) => c.kind !== 'notDue').map((c) => c.key)).toEqual(['2025-M12', '2026-M03', '2026-M06', '2026-M09'])
  })

  it('the Current column shows the counted quarter, captioned', () => {
    const b = board([cell('2026-Q3', { status: 'G', display: '90%' })])
    expect(b).toMatchObject({ current: '90%', caption: 'Q3 FY2026' })
    expect(b.counted).toMatchObject({ kind: 'status', status: 'G', display: '90%' })
  })

  it('while Q3 is due, the Current column shows Q2', () => {
    const b = board([cell('2026-Q2', { status: 'Y', display: '70%' })])
    expect(b).toMatchObject({ current: '70%', caption: 'Q3 due by Oct' })
    expect(b.counted?.status).toBe('Y')
  })

  it('overdue: no current value, the caption says what is overdue', () => {
    const nov = buildTrendColumns('2026-M11', 1)
    const b = board([cell('2026-Q2', { status: 'Y' })], nov, coarseColumns('2026-M11', 'quarter', 4, 1))
    expect(b.current).toBe('')
    expect(b.caption).toBe('Q3 FY2026 overdue (due by Oct 2026)')
    expect(b.counted?.kind).toBe('missing')
  })

  it('in a quarter view, a half sits in its last quarter', () => {
    const q = buildTrendColumns('2026-Q3', 1)
    const halves = coarseColumns('2026-Q3', 'half', 2, 1)
    const scope = row([cell('2026-H1', { status: 'R', display: '40%' })], { frequency: 'biannual' })
    const b = buildBoardRow({
      key: 'm',
      category: { id: 'delivery', name: 'Delivery' },
      scope,
      head: scope,
      children: [],
      noun: 'segments',
      columns: q,
      scale: SCALE,
      fyStart: 1,
      frequency: 'biannual',
      coarse: halves,
    })
    // 2024-Q4 … 2026-Q3. H2 FY2024 and H1 FY2025 close in 2024-Q4 and 2025-Q2 but are older than the halves asked for: no data, not "not due".
    expect(b.cells.map((c) => [c.key, c.kind])).toEqual([
      ['2024-Q4', 'missing'],
      ['2025-Q1', 'notDue'],
      ['2025-Q2', 'missing'],
      ['2025-Q3', 'notDue'],
      ['2025-Q4', 'missing'],
      ['2026-Q1', 'notDue'],
      ['2026-Q2', 'status'],
      ['2026-Q3', 'notDue'],
    ])
    expect(b.cells.find((c) => c.key === '2026-Q2')).toMatchObject({ status: 'R', display: '40%' })
  })

  it('a monthly row ignores coarse columns', () => {
    const scope = row([cell('2026-M10', { status: 'R', display: '72%' })])
    const b = buildBoardRow({
      key: 'm',
      category: { id: 'delivery', name: 'Delivery' },
      scope,
      head: scope,
      children: [],
      noun: 'items',
      columns: months,
      scale: SCALE,
      fyStart: 1,
      frequency: 'monthly',
      coarse: quarters,
    })
    expect(b.cells.some((c) => c.kind === 'notDue')).toBe(false)
    expect(b.counted).toBeUndefined()
    expect(b.current).toBe('72%')
  })
})

describe('buildBoardRow unrated', () => {
  it('a value with no status is unrated, not no data', () => {
    const columns = buildTrendColumns('2026-M10', 1).slice(-1)
    const scope = row([cell('2026-M10', { value: 12, display: '12', status: '' })])
    const board = buildBoardRow({
      key: 'm',
      category: { id: 'delivery', name: 'Delivery' },
      scope,
      head: scope,
      children: [],
      noun: 'items',
      columns,
      scale: SCALE,
      fyStart: 1,
    })
    expect(board.cells[0]).toMatchObject({ kind: 'unrated', display: '12' })
  })
})

describe('cellName', () => {
  const column = buildTrendColumns('2026-M09', 1).at(-1)!
  const label = (k: string) => ({ G: 'Green', Y: 'Yellow', R: 'Red' })[k]

  it('names the metric, period, status and value', () => {
    expect(cellName('% of epics delivered on time', column, { ...status('R'), display: '72%' }, label)).toBe(
      '% of epics delivered on time, Sep 2026: Red, 72%',
    )
  })

  it('adds the change, in words, for the selected period', () => {
    const cell = { ...status('R'), display: '79%', change: '-12 pts vs Aug' }
    expect(cellName('Epics', column, cell, label, true)).toBe('Epics, Sep 2026: Red, 79%, down 12 pts vs Aug')
    expect(cellName('Epics', column, { ...cell, change: '+2 pts vs Aug' }, label, true)).toBe('Epics, Sep 2026: Red, 79%, up 2 pts vs Aug')
    expect(cellName('Epics', column, { ...cell, change: '26% worse vs Aug' }, label, true)).toBe('Epics, Sep 2026: Red, 79%, 26% worse vs Aug')
    expect(cellName('Epics', column, cell, label)).toBe('Epics, Sep 2026: Red, 79%')
  })

  it('names an unrated value', () => {
    expect(cellName('Epics', column, { ...missing, kind: 'unrated', display: '12' }, label)).toBe('Epics, Sep 2026: 12, not rated')
  })

  it('names a not-due cell', () => {
    const aug = buildTrendColumns('2026-M08', 1).at(-1)!
    const notDue: BoardCell = { ...missing, kind: 'notDue', caption: 'Q3 FY2026 reports after Sep' }
    expect(cellName('Concepts delivered expected value', aug, notDue, label)).toBe('Concepts delivered expected value, Aug 2026: Not due')
  })

  it('says why there is no status', () => {
    expect(cellName('Uptime', column, missing, label)).toBe('Uptime, Sep 2026: No data')
    expect(cellName('Uptime', column, { ...missing, kind: 'na', naReason: 'No ideas' }, label)).toBe(
      'Uptime, Sep 2026: Not applicable, No ideas',
    )
    expect(cellName('Uptime', column, { ...status('R'), caption: 'worst of 9 services' }, label)).toBe(
      'Uptime, Sep 2026: Red, worst of 9 services',
    )
  })
})
