import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import type { Move } from '../charts/chartTheme'
import { buildPoints, headerChange } from '../charts/MetricChart'
import type { Column } from '../columns'
import { statusAtScope, type StatusScaleEntry } from './statusAtScope'
import { cellKey } from '../viewHelpers'

type ViewRow = components['schemas']['ViewRow']

export interface BoardCell {
  /** The column key. */
  key: string
  /** A status (the scope's, or the worst child's), not applicable, or no data. */
  kind: 'status' | 'na' | 'missing'
  status: string
  /** The scope's value; '' when the status comes from children or there is none. */
  display: string
  naReason: string
  /** The change as a phrase, e.g. `-10 pts vs Sep`. */
  change: string | null
  /** `worst of 3 services` when the status comes from children. */
  caption: string
}

export interface BoardRow {
  key: string
  name: string
  category: { id: string; name: string }
  cells: BoardCell[]
  /** The selected period's value; '' when the scope has none. */
  current: string
  caption: string
  change: { text: string; move: Move } | null
}

/** The metric-name column never narrows below this, nor grows cells before reaching the comfortable width. */
const NAME_MIN = 100
const NAME_COMFORT = 176
/** Fixed width of the value column; below `VALUE_BREAK` the value moves under the name. */
export const VALUE_WIDTH = 136
const VALUE_BREAK = 440
/** Cell column widths, including the 1px gutter each side: 24px is the smallest target WCAG 2.2 allows. */
const CELL_MIN = 26
const CELL_MAX = 50
/** Four or fewer columns (halves, years) may grow wider, so `FY2026` fits its header. */
const CELL_MAX_SHORT = 72

export interface BoardLayout {
  /** How many of the latest columns to show. */
  count: number
  /** Each period column's width in px; null before the board is measured. */
  cellWidth: number | null
  valueColumn: boolean
}

/**
 * Fits the board to its width: every column when they fit at the minimum
 * size, else the latest half, quarter, and so on. Cells grow to a cap once
 * the name column is comfortable; the name column takes what is left.
 */
export function boardLayout(width: number, total: number): BoardLayout {
  if (width <= 0) return { count: total, cellWidth: null, valueColumn: true }
  const valueColumn = width >= VALUE_BREAK
  const value = valueColumn ? VALUE_WIDTH : 0
  const room = width - NAME_MIN - value
  let count = Math.max(total, 1)
  while (count > 1 && count * CELL_MIN > room) count = Math.ceil(count / 2)
  const grown = Math.floor((width - value - NAME_COMFORT) / count)
  const max = count <= 4 ? CELL_MAX_SHORT : CELL_MAX
  return { count, cellWidth: Math.min(max, Math.max(CELL_MIN, grown)), valueColumn }
}

export interface FiscalGroup {
  fy: number
  label: string
  start: number
  span: number
}

/** Runs of columns in the same fiscal year; none for the year grain, whose labels are years already. */
export function fiscalGroups(columns: Column[]): FiscalGroup[] {
  const groups: FiscalGroup[] = []
  columns.forEach((col, i) => {
    const p = parsePeriod(col.period)
    if (!p || p.grain === 'year') return
    const last = groups[groups.length - 1]
    if (last && last.fy === p.fy) last.span++
    else groups.push({ fy: p.fy, label: `FY${p.fy}`, start: i, span: 1 })
  })
  return groups
}

/** How many columns in a row, ending at `index`, share its status; 0 when it has none. */
export function streakAt(cells: BoardCell[], index: number): number {
  const at = cells[index]
  if (!at || at.kind !== 'status') return 0
  let n = 0
  for (let i = index; i >= 0; i--) {
    const c = cells[i]!
    if (c.kind !== 'status' || c.status !== at.status) break
    n++
  }
  return n
}

/** One metric's row: each column's status by the shared rule, with what the tooltip and value column show. */
export function buildBoardRow({
  key,
  category,
  scope,
  head,
  children,
  noun,
  columns,
  scale,
  fyStart,
}: {
  key: string
  category: { id: string; name: string }
  scope: ViewRow | null
  head: ViewRow
  children: ViewRow[]
  noun: 'segments' | 'services' | 'items'
  columns: Column[]
  scale: StatusScaleEntry[]
  fyStart: number
}): BoardRow {
  const points = buildPoints(scope ?? { ...head, cells: [] }, columns, fyStart)
  const cells = columns.map((col, i): BoardCell => {
    const point = points[i]!
    const at = statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey: col.key, scale, noun })
    const kind = at.status ? 'status' : point.kind === 'na' ? 'na' : 'missing'
    return {
      key: col.key,
      kind,
      status: at.status,
      display: point.kind === 'value' ? point.display : '',
      naReason: point.naReason,
      change: point.change,
      caption: at.caption,
    }
  })
  const last = columns[columns.length - 1]
  const currentCell = scope && last ? scope.cells.find((c) => cellKey(c) === last.key) : undefined
  const current = cells[cells.length - 1]
  return {
    key,
    name: head.metricName,
    category,
    cells,
    current: current?.display ?? '',
    caption: current?.caption ?? '',
    change: scope && current?.display ? headerChange(scope, currentCell, fyStart) : null,
  }
}

/** The cell's accessible name: `Uptime, Sep 2026: Red, 72%`. */
export function cellName(
  metricName: string,
  column: Column,
  cell: BoardCell,
  statusLabel: (key: string) => string | undefined,
): string {
  const where = `${metricName}, ${column.fullLabel}`
  if (cell.kind === 'na') return `${where}: Not applicable${cell.naReason ? `, ${cell.naReason}` : ''}`
  if (cell.kind === 'missing') return `${where}: No data`
  const detail = cell.display || cell.caption
  return `${where}: ${statusLabel(cell.status) ?? cell.status}${detail ? `, ${detail}` : ''}`
}
