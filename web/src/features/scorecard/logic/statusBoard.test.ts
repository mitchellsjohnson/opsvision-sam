import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildTrendColumns } from '../columns'
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
    expect(boardLayout(0, 12)).toEqual({ count: 12, cellWidth: null, valueColumn: true })
  })

  it('shows all 12 months with capped cells and the value column on a wide board', () => {
    const layout = boardLayout(1150, 12)
    expect(layout.count).toBe(12)
    expect(layout.valueColumn).toBe(true)
    expect(layout.cellWidth).toBe(50)
  })

  it('lets a short window (halves, years) use wider cells so year labels fit', () => {
    expect(boardLayout(1150, 3).cellWidth).toBe(72)
    expect(boardLayout(1150, 8).cellWidth).toBe(50)
  })

  it('keeps all 12 months on a half-width board at minimum cell size', () => {
    expect(boardLayout(560, 12)).toEqual({ count: 12, cellWidth: 26, valueColumn: true })
  })

  it('shows the latest 6 months on a phone, with the value under the name', () => {
    expect(boardLayout(262, 12)).toEqual({ count: 6, cellWidth: 26, valueColumn: false })
  })

  it('halves again when 6 do not fit', () => {
    expect(boardLayout(200, 12).count).toBe(3)
  })

  it('halves quarters and keeps short windows whole', () => {
    expect(boardLayout(262, 8).count).toBe(4)
    expect(boardLayout(262, 4).count).toBe(4)
    expect(boardLayout(262, 3).count).toBe(3)
  })

  it('never shows fewer than one column', () => {
    expect(boardLayout(40, 12).count).toBe(1)
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
    expect(board.cells[2]).toMatchObject({ kind: 'status', status: 'R', display: '', caption: 'worst of 2 services' })
    expect(board.caption).toBe('worst of 2 services')
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
