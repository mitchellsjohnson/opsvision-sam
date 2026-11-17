import type { components } from '../../../api/schema'
import type { Move } from '../charts/chartTheme'
import { headerChange } from '../charts/points'
import type { Column } from '../columns'
import { cellKey } from '../viewHelpers'
import { cellReported, type StatusScaleEntry } from './statusAtScope'
import { buildBoardRow, type BoardCell } from './statusBoard'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']
type Direction = components['schemas']['Direction']

/**
 * The query parameter naming the item drilled into (`?focus=uptime&item=webhooks`).
 * Not `subject`: that one is the view's subject filter (`VIEW_PARAMS`).
 */
export const ITEM_PARAM = 'item'
/** The query parameter holding a non-default item sort (`&sort=reds`). */
export const SORT_PARAM = 'sort'

/** Worst now (default), most worst-status periods, or name. */
export type ItemSort = 'worst' | 'reds' | 'name'

/** The `sort` query value as a sort; anything unknown is Worst now. */
export function parseItemSort(value: string | null | undefined): ItemSort {
  return value === 'reds' || value === 'name' ? value : 'worst'
}

/** One item of an item metric (a service of uptime) over the columns shown. */
export interface ItemRow {
  /** The item id (`subjectId`). */
  id: string
  name: string
  /** The item's org unit name, or `Unassigned`. */
  group: string
  row: ViewRow
  /** One board cell per column, by the board's rule. */
  cells: BoardCell[]
  /** The selected (last) column's board cell. */
  current: BoardCell
  /** The selected column's API cell: its value, change and the item's own rule. */
  cell: Cell | undefined
  /** A value (or a status) in the selected column. */
  reported: boolean
  value: number | null
  display: string
  /** '' when the selected column has no status. */
  status: string
  /** The change vs the prior period, judged by the metric's direction. */
  change: { text: string; move: Move } | null
  /** Columns with the scale's worst status ("Red months"). */
  worstCount: number
  /** For an item not reported in the selected column: its last value in the window, if any. */
  lastReported: {
    /** The column's short label (`Sep`) and full label (`Sep 2026`). */
    label: string
    fullLabel: string
    display: string
    /** The column's index in the window. */
    index: number
  } | null
}

const rankOf = (scale: StatusScaleEntry[], status: string) => scale.find((s) => s.key === status)?.rank ?? -1
const bestKey = (scale: StatusScaleEntry[]) => [...scale].sort((a, b) => a.rank - b.rank)[0]?.key ?? ''
const worstKey = (scale: StatusScaleEntry[]) => [...scale].sort((a, b) => b.rank - a.rank)[0]?.key ?? ''

/**
 * The item rows of one metric's rows (`subjectKind === 'item'`, never the
 * unit rows) over `columns`, the last of which is the selected period.
 */
export function buildItemRows(
  rows: ViewRow[],
  columns: Column[],
  scale: StatusScaleEntry[],
  groupOf: (itemId: string) => string,
  fy: number,
): ItemRow[] {
  const last = columns[columns.length - 1]
  const worst = worstKey(scale)
  return rows
    .filter((r) => r.subjectKind === 'item')
    .map((r): ItemRow => {
      const board = buildBoardRow({
        key: r.subjectId,
        category: { id: r.categoryId, name: '' },
        scope: r,
        head: r,
        children: [],
        noun: 'items',
        columns,
        scale,
        fyStart: fy,
      })
      const cell = last ? r.cells.find((c) => cellKey(c) === last.key) : undefined
      const reported = cellReported(cell)
      let lastReported: ItemRow['lastReported'] = null
      if (!reported) {
        for (let i = columns.length - 2; i >= 0; i--) {
          const c = r.cells.find((x) => cellKey(x) === columns[i]!.key)
          if (c && c.naReason === '' && c.value != null) {
            lastReported = { label: columns[i]!.label, fullLabel: columns[i]!.fullLabel, display: c.display, index: i }
            break
          }
        }
      }
      const current = board.cells[board.cells.length - 1] ?? { key: '', kind: 'missing', status: '', display: '', naReason: '', change: null, caption: '' }
      return {
        id: r.subjectId,
        name: r.subjectName,
        group: groupOf(r.subjectId),
        row: r,
        cells: board.cells,
        current,
        cell,
        reported,
        value: reported && cell?.naReason === '' ? (cell.value ?? null) : null,
        display: reported ? (cell?.display ?? '') : '',
        status: reported ? (cell?.status ?? '') : '',
        change: reported ? headerChange(r, cell, fy) : null,
        worstCount: worst ? board.cells.filter((c) => c.kind === 'status' && c.status === worst).length : 0,
        lastReported,
      }
    })
}

const byName = (a: ItemRow, b: ItemRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

function worstFirst(scale: StatusScaleEntry[], direction: Direction) {
  // Higher is better: the lower value is worse, so it comes first.
  const sign = direction === 'lower_better' ? -1 : 1
  return (a: ItemRow, b: ItemRow) => {
    const rank = rankOf(scale, b.status) - rankOf(scale, a.status)
    if (rank !== 0) return rank
    if (a.value !== null && b.value !== null && a.value !== b.value) return sign * (a.value - b.value)
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1
    return byName(a, b)
  }
}

/** Not applicable in the selected column (`naReason`): neither reported nor missing. */
const notApplicable = (r: ItemRow) => !r.reported && r.current.kind === 'na'

/**
 * The items in display order: those reported in the selected column by
 * `sort`, then those not reported, then those not applicable, both by name.
 */
export function sortItems(
  rows: ItemRow[],
  sort: ItemSort,
  direction: Direction,
  scale: StatusScaleEntry[],
): { reported: ItemRow[]; notReported: ItemRow[]; notApplicable: ItemRow[] } {
  const worst = worstFirst(scale, direction)
  const compare =
    sort === 'name' ? byName : sort === 'reds' ? (a: ItemRow, b: ItemRow) => b.worstCount - a.worstCount || worst(a, b) : worst
  return {
    reported: rows.filter((r) => r.reported).sort(compare),
    notReported: rows.filter((r) => !r.reported && !notApplicable(r)).sort(byName),
    notApplicable: rows.filter(notApplicable).sort(byName),
  }
}

export interface ItemSummary {
  /** Every item, reported or not: the headline's denominator. */
  total: number
  /** Items at the scale's best status (rank minimum). */
  best: number
  /** Reported items by status. */
  counts: Map<string, number>
  /** Items with no value in the selected column; n/a items are not among them. */
  notReported: number
  notApplicable: number
  /** The worst reported item: highest rank, then worse value, then name. */
  worst: ItemRow | null
}

/** The counts behind `18 of 24 services Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported · 1 n/a`. */
export function itemSummary(rows: ItemRow[], scale: StatusScaleEntry[]): ItemSummary {
  const direction = rows[0]?.row.direction ?? 'higher_better'
  const { reported, notReported, notApplicable } = sortItems(rows, 'worst', direction, scale)
  const counts = new Map<string, number>()
  for (const r of reported) if (r.status) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return {
    total: rows.length,
    best: counts.get(bestKey(scale)) ?? 0,
    counts,
    notReported: notReported.length,
    notApplicable: notApplicable.length,
    worst: reported[0] ?? null,
  }
}

/** Items whose name or group contains `query`, case-insensitive; all when the query is blank. */
export function filterItems(rows: ItemRow[], query: string): ItemRow[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.name.toLocaleLowerCase().includes(q) || r.group.toLocaleLowerCase().includes(q))
}

/** No value and no status in any column of `columns`. */
function silentIn(r: ItemRow, columns: Column[]): boolean {
  const keys = new Set(columns.map((c) => c.key))
  return !r.row.cells.some((c) => keys.has(cellKey(c)) && (c.value != null || c.status !== ''))
}

/**
 * The items by where they sit in the grid (§2.5), each in the order given:
 * reported in the selected column; not applicable in it; silent (nothing in
 * any column of the window, `columns`, whatever a layout shows); else not
 * reported. Presentation only: `itemSummary` still counts the silent as not
 * reported.
 */
export function partitionItems(
  rows: ItemRow[],
  columns: Column[],
): { reported: ItemRow[]; notReported: ItemRow[]; silent: ItemRow[]; notApplicable: ItemRow[] } {
  const out = { reported: [] as ItemRow[], notReported: [] as ItemRow[], silent: [] as ItemRow[], notApplicable: [] as ItemRow[] }
  for (const r of rows) {
    if (r.reported) out.reported.push(r)
    else if (notApplicable(r)) out.notApplicable.push(r)
    else if (silentIn(r, columns)) out.silent.push(r)
    else out.notReported.push(r)
  }
  return out
}

/** The grid's groups in display order: `sortItems` with the silent taken out of the not reported. */
export function groupItems(
  rows: ItemRow[],
  columns: Column[],
  sort: ItemSort,
  direction: Direction,
  scale: StatusScaleEntry[],
): { reported: ItemRow[]; notReported: ItemRow[]; notApplicable: ItemRow[]; silent: ItemRow[] } {
  const sorted = sortItems(rows, sort, direction, scale)
  const silent = new Set(partitionItems(sorted.notReported, columns).silent)
  return {
    reported: sorted.reported,
    notReported: sorted.notReported.filter((r) => !silent.has(r)),
    notApplicable: sorted.notApplicable,
    silent: sorted.notReported.filter((r) => silent.has(r)),
  }
}

/**
 * The item ids in the grid's visible order: filtered and sorted, the silent
 * last and only while their group is open, or when the filter has text (a
 * filter shows the silent that match).
 */
export function visibleItemOrder(
  rows: ItemRow[],
  o: { columns: Column[]; filter: string; sort: ItemSort; direction: Direction; scale: StatusScaleEntry[]; silentOpen: boolean },
): string[] {
  const g = groupItems(filterItems(rows, o.filter), o.columns, o.sort, o.direction, o.scale)
  const silentShown = o.silentOpen || o.filter.trim() !== ''
  return [...g.reported, ...g.notReported, ...g.notApplicable, ...(silentShown ? g.silent : [])].map((r) => r.id)
}

/**
 * The uptime tile's rows (§3.1): reported items not at the best status
 * (worst first), then items that stopped reporting with their last report
 * inside the shown columns (from `offset` on; most recent first), at most
 * `max`. The rest are counted: `restBest` at the best status, `hiddenWorse`
 * and `hiddenStopped` cut by the limit, `stoppedBefore` last reported before
 * the first shown column (`stoppedBeforeLabel`), `silent` with no reports in
 * the window. n/a items are none of these.
 */
export function tileExceptions(
  rows: ItemRow[],
  o: { columns: Column[]; offset: number; scale: StatusScaleEntry[]; direction: Direction; max?: number },
): {
  shown: ItemRow[]
  restBest: number
  hiddenWorse: number
  hiddenStopped: number
  stoppedBefore: number
  stoppedBeforeLabel: string
  silent: number
} {
  const max = Math.max(o.max ?? 5, 0)
  const g = groupItems(rows, o.columns, 'worst', o.direction, o.scale)
  const best = bestKey(o.scale)
  const worse = g.reported.filter((r) => r.status !== best)
  const inView = (r: ItemRow) => (r.lastReported?.index ?? -1) >= o.offset
  const stopped = g.notReported
    .filter(inView)
    .sort((a, b) => b.lastReported!.index - a.lastReported!.index || byName(a, b))
  const shown = [...worse, ...stopped].slice(0, max)
  const shownWorse = Math.min(worse.length, max)
  return {
    shown,
    restBest: g.reported.length - worse.length,
    hiddenWorse: worse.length - shownWorse,
    hiddenStopped: stopped.length - (shown.length - shownWorse),
    stoppedBefore: g.notReported.length - stopped.length,
    stoppedBeforeLabel: o.columns[o.offset]?.label ?? '',
    silent: g.silent.length,
  }
}
