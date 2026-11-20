import type { components } from '../../../api/schema'
import { lastMonth, parent, parsePeriod } from '../../../lib/period'
import type { Move } from '../charts/chartTheme'
import { buildPoints, headerChange, type ChartPoint } from '../charts/points'
import { coarserGrain, endOrdinal, FREQUENCY_GRAIN, type Column } from '../columns'
import { notDueCaption, periodStatus } from './coarse'
import { worstChildren } from './drivers'
import type { NounForms } from './nouns'
import { cellReported, statusAtScope, type StatusScaleEntry } from './statusAtScope'
import { cellKey } from '../viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type Frequency = components['schemas']['Frequency']

export interface BoardCell {
  /** The column key. */
  key: string
  /**
   * A status (the scope's, or the worst child's), a value with no status, not
   * applicable, no data, or not due (a coarse metric's month that closes no
   * period of its own).
   */
  kind: 'status' | 'unrated' | 'na' | 'missing' | 'notDue'
  status: string
  /** The scope's value; '' when the status comes from children or there is none. */
  display: string
  naReason: string
  /** The change as a phrase, e.g. `-10 pts vs Sep`. */
  change: string | null
  /** `worst of 3 services` when the status comes from children; `Q3 FY2026 reports after Sep` when not due. */
  caption: string
}

export interface BoardRow {
  key: string
  name: string
  category: { id: string; name: string }
  cells: BoardCell[]
  /** The selected period's value (a coarse metric's counted period); '' when the scope has none. */
  current: string
  caption: string
  change: { text: string; move: Move } | null
  /** A coarse metric's counted period, which the Current column and roll-up read instead of the last cell. */
  counted?: BoardCell
  /**
   * With no scope value, the child whose status the row shows: the Current
   * column leads with its value. `of`: how many children share its status,
   * out of all of them, and how many did not report.
   */
  worst?: { name: string; display: string; of?: { same: number; total: number; notReported: number } }
}

/** Inline rows keep at least this much for the metric name; cells grow only once it is comfortable. */
const NAME_MIN = 100
const NAME_COMFORT = 176
/** On a wide board the name column stops here, so cells sit near their names; the gap before Current takes the rest. */
const NAME_MAX = 320
/** Fixed width of the value column in inline rows. */
export const VALUE_WIDTH = 136
/** Below this width rows always stack: the name and value above, the cells below. */
export const VALUE_BREAK = 440
/** Cell column widths, including a 2px gutter each side (4px between cells): 24px is the smallest target WCAG 2.2 allows. */
const CELL_MIN = 28
const CELL_MAX = 40
/** Stacked rows have no name beside the cells, so cells may grow wider to fill the board. */
const CELL_MAX_STACKED = 48
/** Four or fewer columns (halves, years) may grow wider, so `FY2026` fits its header. */
const CELL_MAX_SHORT = 64

export interface BoardLayout {
  /** How many of the latest columns to show. */
  count: number
  /** Each period column's width in px; null before the board is measured. */
  cellWidth: number | null
  /** Inline rows (name, cells, value side by side); false when each metric stacks into two rows. */
  valueColumn: boolean
  /** The name column's width in px on a measured inline board; null otherwise. */
  nameWidth: number | null
  /** The value column's width in px: at least `VALUE_WIDTH` inline, 0 stacked. */
  valueWidth: number
}

function cellWidthFor(room: number, count: number, max: number): number {
  return Math.min(count <= 4 ? CELL_MAX_SHORT : max, Math.max(CELL_MIN, Math.floor(room / count)))
}

/**
 * Fits the board to its width, preferring every column over the value
 * column: inline rows when all columns fit beside the name and value; else
 * stacked rows with all columns across the full width; else the latest half,
 * quarter, and so on. A wider board never shows fewer columns.
 */
export function boardLayout(boardWidth: number, total: number): BoardLayout {
  const all = Math.max(total, 1)
  const width = Math.floor(boardWidth)
  if (width <= 0) return { count: all, cellWidth: null, valueColumn: true, nameWidth: null, valueWidth: VALUE_WIDTH }
  if (width >= VALUE_BREAK && all * CELL_MIN <= width - NAME_MIN - VALUE_WIDTH) {
    const cellWidth = cellWidthFor(width - VALUE_WIDTH - NAME_COMFORT, all, CELL_MAX)
    const nameWidth = Math.min(NAME_MAX, width - VALUE_WIDTH - all * cellWidth)
    return { count: all, cellWidth, valueColumn: true, nameWidth, valueWidth: width - nameWidth - all * cellWidth }
  }
  let count = all
  while (count > 1 && count * CELL_MIN > width) count = Math.ceil(count / 2)
  return { count, cellWidth: cellWidthFor(width, count, CELL_MAX_STACKED), valueColumn: false, nameWidth: null, valueWidth: 0 }
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

/** Narrowest room, in px, for `FY2026` and `FY26` in an 11px uppercase header with its 4px inset. */
const FY_FULL = 52
const FY_SHORT = 34

/**
 * A fiscal year header that fits `cellWidth` per column: `FY2026`, `FY26`,
 * then `’26`; in full before measuring. A one-column year is never longer
 * than `FY26`: its padding leaves too little for `FY2026` in any column.
 */
export function fiscalLabel(group: FiscalGroup, cellWidth: number | null): string {
  const room = cellWidth === null ? Infinity : group.span * cellWidth
  if (room >= FY_FULL && group.span > 1) return group.label
  const yy = String(group.fy).slice(-2)
  return room >= FY_SHORT ? `FY${yy}` : `’${yy}`
}

/**
 * The child a metric with no scope value answers with: the worst reported in
 * the column (by `worstChildren`), its name and value; undefined when none
 * reported a value. The board's Current column and the report lead with it.
 */
export function worstChildValue(
  children: ViewRow[],
  columnKey: string,
  scale: StatusScaleEntry[],
  direction: ViewRow['direction'],
): { name: string; display: string } | undefined {
  if (children.length === 0) return undefined
  const { worst } = worstChildren(children, columnKey, scale, direction)
  return worst?.cell.display ? { name: worst.row.subjectName, display: worst.cell.display } : undefined
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

/**
 * One metric's row: each column's status by the shared rule, with what the
 * tooltip and value column show. A coarse metric (`coarse` holds its own
 * grain's columns) puts each period's status in the column of its last month
 * or quarter; the other columns are not due, and the Current column shows
 * the period `periodStatus` counts.
 */
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
  frequency = head.frequency,
  coarse = [],
}: {
  key: string
  category: { id: string; name: string }
  scope: ViewRow | null
  head: ViewRow
  children: ViewRow[]
  noun: NounForms | 'segments' | 'services' | 'items'
  columns: Column[]
  scale: StatusScaleEntry[]
  fyStart: number
  frequency?: Frequency
  coarse?: Column[]
}): BoardRow {
  const row = scope ?? { ...head, cells: [] }
  const cellAt = (col: Column, point: ChartPoint, key = col.key): BoardCell => {
    const at = statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey: col.key, scale, noun })
    const kind = at.status ? 'status' : point.kind === 'na' ? 'na' : point.kind === 'value' && point.display ? 'unrated' : 'missing'
    return {
      key,
      kind,
      status: at.status,
      display: point.kind === 'value' ? point.display : '',
      naReason: point.naReason,
      change: point.kind === 'value' ? point.change : null,
      caption: at.caption,
    }
  }

  // With no scope value, the worst reported child and its value; none when the status is the scope's own.
  const worstAt = (columnKey: string, at: BoardCell | undefined): BoardRow['worst'] => {
    if (!at || at.kind !== 'status' || at.display) return undefined
    const worst = worstChildValue(children, columnKey, scale, head.direction)
    if (!worst) return undefined
    const cells = children.map((ch) => ch.cells.find((c) => cellKey(c) === columnKey))
    const reported = cells.filter((c) => cellReported(c))
    const same = reported.filter((c) => c!.status === at.status).length
    return { ...worst, of: { same, total: children.length, notReported: children.length - reported.length } }
  }

  const last = columns[columns.length - 1]
  const own = FREQUENCY_GRAIN[frequency]
  const selectedGrain = parsePeriod(last?.period)?.grain
  if (last && selectedGrain && own !== 'month' && coarse.length > 0 && coarserGrain(own, selectedGrain)) {
    const coarsePoints = buildPoints(row, coarse, fyStart)
    const byEnd = new Map(coarse.map((c, i) => [endOrdinal(parsePeriod(c.period)!), i]))
    const cells = columns.map((col): BoardCell => {
      const p = parsePeriod(col.period)
      const i = p ? byEnd.get(endOrdinal(p)) : undefined
      if (i !== undefined) return cellAt(coarse[i]!, coarsePoints[i]!, col.key)
      const blank = { key: col.key, status: '', display: '', naReason: '', change: null }
      // A column that closes an older period than those asked for has no data; any other is not due.
      const closes = p !== null && endOrdinal(parent(lastMonth(p), own)) === endOrdinal(p)
      return closes
        ? { ...blank, kind: 'missing', caption: '' }
        : { ...blank, kind: 'notDue', caption: notDueCaption(col, own, fyStart) }
    })
    const ps = periodStatus({ scope, children, frequency, selected: last, coarse, scale, noun, fy: fyStart })
    const i = coarse.findIndex((c) => c.key === ps.counted.key)
    const counted = i >= 0 ? cellAt(ps.counted, coarsePoints[i]!) : undefined
    const countedCell = scope?.cells.find((c) => cellKey(c) === ps.counted.key)
    const worst = ps.status ? worstAt(ps.counted.key, counted) : undefined
    return {
      key,
      name: head.metricName,
      category,
      cells,
      current: ps.status ? (counted?.display ?? '') : '',
      caption: ps.caption,
      change: scope && ps.status && counted?.display ? headerChange(scope, countedCell, fyStart) : null,
      counted: counted && { ...counted, caption: ps.caption },
      ...(worst && { worst }),
    }
  }

  const points = buildPoints(row, columns, fyStart)
  const cells = columns.map((col, i): BoardCell => cellAt(col, points[i]!))
  const currentCell = scope && last ? scope.cells.find((c) => cellKey(c) === last.key) : undefined
  const current = cells[cells.length - 1]
  const worst = last ? worstAt(last.key, current) : undefined
  return {
    key,
    name: head.metricName,
    category,
    cells,
    current: current?.display ?? '',
    caption: current?.caption ?? '',
    change: scope && current?.display ? headerChange(scope, currentCell, fyStart) : null,
    ...(worst && { worst }),
  }
}

/**
 * The accessible name of a row that answers with its worst child:
 * `Deployment uptime, Oct 2026: 99.63%, Red; worst Notification Relay - Multi-Region Active; 1 of 21 Red; 12 not reported`.
 * Undefined for a row with its own value.
 */
export function rowName(row: BoardRow, column: Column, statusLabel: (key: string) => string | undefined): string | undefined {
  const at = row.counted ?? row.cells[row.cells.length - 1]
  if (row.current || !row.worst?.of || at?.kind !== 'status') return undefined
  const label = statusLabel(at.status) ?? at.status
  const { same, total, notReported } = row.worst.of
  return [
    `${row.name}, ${column.fullLabel}: ${row.worst.display}, ${label}`,
    `worst ${row.worst.name}`,
    `${same} of ${total} ${label}`,
    ...(notReported > 0 ? [`${notReported} not reported`] : []),
  ].join('; ')
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
  if (cell.kind === 'notDue') return `${where}: Not due`
  if (cell.kind === 'missing') return `${where}: No data`
  const change = withChange && cell.change ? `, ${spokenChange(cell.change)}` : ''
  if (cell.kind === 'unrated') return `${where}: ${cell.display}, not rated${change}`
  const detail = cell.display || cell.caption
  return `${where}: ${statusLabel(cell.status) ?? cell.status}${detail ? `, ${detail}` : ''}${change}`
}
