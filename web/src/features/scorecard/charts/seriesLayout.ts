import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import type { BoardCell } from '../logic/statusBoard'
import { cellKey } from '../viewHelpers'
import type { ChartPoint } from './points'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']

/** Small multiples replace overlaid lines in focus from this many series (§7.6). */
export const MULTIPLES_FROM = 4
/** The least room between two end labels' centres. */
export const END_LABEL_GAP = 16

/** A row's current state, for ordering: its last column's status rank (unknown last) and value. */
function currentOf(row: ViewRow, columnKey: string, scale: StatusLevel[]) {
  const cell = row.cells.find((c) => cellKey(c) === columnKey && c.naReason === '')
  const rank = scale.find((s) => s.key === cell?.status)?.rank ?? -Infinity
  return { cell, rank, value: cell?.value ?? null }
}

/** Worst first: the highest status rank, then the worse value for the direction, then the name. */
export function worstFirst<T extends { row: ViewRow }>(series: T[], columnKey: string, scale: StatusLevel[]): T[] {
  return [...series].sort((a, b) => {
    const x = currentOf(a.row, columnKey, scale)
    const y = currentOf(b.row, columnKey, scale)
    if (x.rank !== y.rank) return y.rank - x.rank
    if (x.value !== null && y.value !== null && x.value !== y.value) {
      return a.row.direction === 'lower_better' ? y.value - x.value : x.value - y.value
    }
    if ((x.value === null) !== (y.value === null)) return x.value === null ? 1 : -1
    return a.row.subjectName.localeCompare(b.row.subjectName)
  })
}

/**
 * End-label centres for lines ending at `ys` (any order): each at its line's
 * end, pushed apart to `gap`, and kept inside `[top, bottom]`.
 */
export function spreadLabels(ys: number[], top: number, bottom: number, gap = END_LABEL_GAP): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  for (let k = 1; k < order.length; k++) order[k]!.y = Math.max(order[k]!.y, order[k - 1]!.y + gap)
  const overflow = (order.at(-1)?.y ?? bottom) - bottom
  if (overflow > 0) for (const o of order) o.y -= overflow
  for (let k = 0; k < order.length; k++) order[k]!.y = Math.max(order[k]!.y, top + k * gap)
  const out: number[] = []
  for (const o of order) out[o.i] = o.y
  return out
}

/** The last point with a value, or null. */
export function lastValued(points: ChartPoint[]): { point: ChartPoint; index: number } | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i]!.kind === 'value') return { point: points[i]!, index: i }
  return null
}

/** Points as board cells, for `sinceText`. */
export function pointCells(points: ChartPoint[]): BoardCell[] {
  return points.map((p) => ({
    key: p.key,
    kind: p.kind === 'na' ? 'na' : p.kind === 'missing' ? 'missing' : p.status ? 'status' : 'unrated',
    status: p.status,
    display: p.display,
    naReason: p.naReason,
    change: p.change,
    caption: '',
  }))
}

export interface MultiSeriesHeader {
  /** The worst series now; null when none reported. */
  worst: { name: string; display: string; status: string } | null
  /** `1 of 4 segments Red`: series at the worst series' status, of all shown. */
  count: string
}

/** The value row of a metric charted as several series with no total (§7.6): `Worst Data 74% ◆R · 1 of 4 segments Red`. */
export function multiSeriesHeader(
  rows: ViewRow[],
  columnKey: string,
  scale: StatusLevel[],
  statusLabel: (key: string) => string,
  noun: string,
): MultiSeriesHeader {
  const [first] = worstFirst(
    rows.map((row) => ({ row })),
    columnKey,
    scale,
  )
  const cell = first ? currentOf(first.row, columnKey, scale).cell : undefined
  if (!first || !cell?.display) return { worst: null, count: '' }
  const same = rows.filter((r) => currentOf(r, columnKey, scale).cell?.status === cell.status).length
  return {
    worst: { name: first.row.subjectName, display: cell.display, status: cell.status },
    count: cell.status ? `${same} of ${rows.length} ${noun} ${statusLabel(cell.status)}` : '',
  }
}

/**
 * The context line of a metric with no company total: `4 segments · each
 * segment runs its own survey, so there is no company total` when its
 * definition says why, else `4 segments · no company total`.
 */
export function noTotalNote(count: number, noun: string, definition: string): string {
  const why = definition
    .split(/(?<=\.)\s+/)
    .find((s) => /no (company )?total/i.test(s))
    ?.replace(/\.$/, '')
  const reason = why ? why.charAt(0).toLowerCase() + why.slice(1) : 'no company total'
  return `${count} ${noun} · ${reason}`
}

/** A small multiple at least this wide labels its months `Nov`; narrower, `N`. */
export const PANEL_SHORT_LABELS_FROM = 360

/** The month labels under a panel's ribbon: short labels from 360px (or before it is measured), initials below. */
export function panelMonthLabels(columns: Column[], width: number): string[] {
  const initials = width > 0 && width < PANEL_SHORT_LABELS_FROM
  return columns.map((c) => (initials ? c.label.charAt(0) : c.label))
}

/**
 * The series drawn in front (§8): the one the pointer is on, else the worst
 * now (the header's `Worst {segment}`); null with no series.
 */
export function frontSeries(rows: ViewRow[], columnKey: string, scale: StatusLevel[], hovered: string | null): string | null {
  if (hovered && rows.some((r) => r.subjectId === hovered)) return hovered
  const [first] = worstFirst(
    rows.map((row) => ({ row })),
    columnKey,
    scale,
  )
  return first?.row.subjectId ?? null
}

/** `ids` with `front` moved last, so it paints over the others. */
export function drawOrder(ids: string[], front: string | null): string[] {
  return front === null || !ids.includes(front) ? ids : [...ids.filter((id) => id !== front), front]
}

/** `60–100%`: a domain as one range, the unit once. */
export function rangeText(lo: string, hi: string): string {
  const unit = /%$/.test(lo) && /%$/.test(hi) ? '%' : ''
  return unit ? `${lo.slice(0, -1)}–${hi}` : `${lo}–${hi}`
}