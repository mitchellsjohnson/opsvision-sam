import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import type { Move } from '../charts/chartTheme'
import { buildPoints, headerChange } from '../charts/points'
import type { Column } from '../columns'
import { statusAtScope, type StatusScaleEntry } from './statusAtScope'
import { cellKey } from '../viewHelpers'

type ViewRow = components['schemas']['ViewRow']

export interface BoardCell {
  /** The column key. */
  key: string
  /** A status (the scope's, or the worst child's), a value with no status, not applicable, or no data. */
  kind: 'status' | 'unrated' | 'na' | 'missing'
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

/** Inline rows keep at least this much for the metric name; cells grow only once it is comfortable. */
const NAME_MIN = 100
const NAME_COMFORT = 176
/** Fixed width of the value column in inline rows. */
export const VALUE_WIDTH = 136
/** Below this width rows always stack: the name and value above, the cells below. */
export const VALUE_BREAK = 440
/** Cell column widths, including a 2px gutter each side (4px between cells): 24px is the smallest target WCAG 2.2 allows. */
const CELL_MIN = 28
const CELL_MAX = 40
/** Four or fewer columns (halves, years) may grow wider, so `FY2026` fits its header. */
const CELL_MAX_SHORT = 64

export interface BoardLayout {
  /** How many of the latest columns to show. */
  count: number
  /** Each period column's width in px; null before the board is measured. */
  cellWidth: number | null
  /** Inline rows (name, cells, value side by side); false when each metric stacks into two rows. */
  valueColumn: boolean
}

function cellWidthFor(room: number, count: number): number {
  const max = count <= 4 ? CELL_MAX_SHORT : CELL_MAX
  return Math.min(max, Math.max(CELL_MIN, Math.floor(room / count)))
}

/**
 * Fits the board to its width, preferring every column over the value
 * column: inline rows when all columns fit beside the name and value; else
 * stacked rows with all columns across the full width; else the latest half,
 * quarter, and so on. A wider board never shows fewer columns.
 */
export function boardLayout(width: number, total: number): BoardLayout {
  const all = Math.max(total, 1)
  if (width <= 0) return { count: all, cellWidth: null, valueColumn: true }
  if (width >= VALUE_BREAK && all * CELL_MIN <= width - NAME_MIN - VALUE_WIDTH) {
    return { count: all, cellWidth: cellWidthFor(width - VALUE_WIDTH - NAME_COMFORT, all), valueColumn: true }
  }
  let count = all
  while (count > 1 && count * CELL_MIN > width) count = Math.ceil(count / 2)
  return { count, cellWidth: cellWidthFor(width, count), valueColumn: false }
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
    const kind = at.status ? 'status' : point.kind === 'na' ? 'na' : point.kind === 'value' && point.display ? 'unrated' : 'missing'
    return {
      key: col.key,
      kind,
      status: at.status,
      display: point.kind === 'value' ? point.display : '',
      naReason: point.naReason,
      change: point.kind === 'value' ? point.change : null,
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

/** A change phrase for speech: `-12 pts vs Sep` reads `down 12 pts vs Sep`. */
function spokenChange(text: string): string {
  const m = /^([+-])(.*)$/.exec(text)
  return m ? `${m[1] === '+' ? 'up' : 'down'} ${m[2]}` : text
}

/** The cell's accessible name: `Uptime, Sep 2026: Red, 72%`, with the change when `withChange` (the selected period). */
export function cellName(
  metricName: string,
  column: Column,
  cell: BoardCell,
  statusLabel: (key: string) => string | undefined,
  withChange = false,
): string {
  const where = `${metricName}, ${column.fullLabel}`
  if (cell.kind === 'na') return `${where}: Not applicable${cell.naReason ? `, ${cell.naReason}` : ''}`
  if (cell.kind === 'missing') return `${where}: No data`
  const change = withChange && cell.change ? `, ${spokenChange(cell.change)}` : ''
  if (cell.kind === 'unrated') return `${where}: ${cell.display}, not rated${change}`
  const detail = cell.display || cell.caption
  return `${where}: ${statusLabel(cell.status) ?? cell.status}${detail ? `, ${detail}` : ''}${change}`
}
