import type { components } from '../../../api/schema'
import { lastMonth, monthLabel, parent, parsePeriod, periodLabel, type Grain, type Period } from '../../../lib/period'
import {
  coarserGrain,
  endOrdinal,
  FREQUENCY_GRAIN,
  shortLabel,
  type CoarseGrain,
  type Column,
} from '../columns'
import { cellKey } from '../viewHelpers'
import { cellReported, statusAtScope, type StatusScaleEntry } from './statusAtScope'
import { columnUnit } from './statusText'

type Cell = components['schemas']['Cell']
type ViewRow = components['schemas']['ViewRow']
type Frequency = components['schemas']['Frequency']

const COARSE: CoarseGrain[] = ['quarter', 'half', 'year']

/** The grains coarser than the selected one that some metric reports at, in order: quarter, half, year. */
export function coarseGrains(frequencies: Frequency[], selected: Grain): CoarseGrain[] {
  const present = new Set(frequencies.map((f) => FREQUENCY_GRAIN[f]))
  return COARSE.filter((g) => present.has(g) && coarserGrain(g, selected))
}

function next(p: Period): Period {
  if (p.grain === 'year') return { ...p, fy: p.fy + 1 }
  const perYear = { month: 12, quarter: 4, half: 2 }[p.grain]
  return p.index < perYear ? { ...p, index: p.index + 1 } : { ...p, fy: p.fy + 1, index: 1 }
}

/** The month a period is due by: the month after it closes (one month of grace). */
function dueMonth(p: Period): Period {
  return next(lastMonth(p))
}

function shortMonth(month: Period, fy: number): string {
  return monthLabel(month, fy).split(' ')[0] ?? ''
}

/** Reported, or explicitly not applicable: either way the period is accounted for. */
function accounted(cell: Cell | undefined): boolean {
  return cellReported(cell) || (cell !== undefined && cell.naReason !== '')
}

export interface CoarseStatus {
  state: 'current' | 'due' | 'overdue' | 'none'
  /** The period whose status counts; null when the metric counts as not reported. */
  counted: Column | null
  cell: Cell | undefined
  /** The period due next, or for `overdue` the one overdue. */
  next: { label: string; dueBy: string }
}

/**
 * Where a coarse metric stands in the selected period (§5.3). L is the last
 * of `columns` (the latest coarse period closed by the selected period):
 * reported, it counts; missing within a month of closing, the one before it
 * counts; otherwise the metric is not reported.
 */
export function coarseStatus(row: ViewRow, columns: Column[], selected: string, fy: number): CoarseStatus {
  const cells = new Map(row.cells.filter((c) => !c.ytd).map((c) => [c.period, c]))
  const at = (col: Column | undefined) => (col ? cells.get(col.period) : undefined)
  const dueBy = (col: Column) => {
    const p = parsePeriod(col.period)!
    return { label: col.label, dueBy: shortMonth(dueMonth(p), fy) }
  }
  const last = columns[columns.length - 1]
  const lastP = parsePeriod(last?.period)
  if (!last || !lastP) return { state: 'none', counted: null, cell: undefined, next: { label: '', dueBy: '' } }
  if (accounted(at(last))) {
    const following = next(lastP)
    return {
      state: 'current',
      counted: last,
      cell: at(last),
      next: { label: shortLabel(following, fy), dueBy: shortMonth(dueMonth(following), fy) },
    }
  }
  if (!columns.some((c) => accounted(at(c)))) return { state: 'none', counted: null, cell: undefined, next: dueBy(last) }
  const prior = columns[columns.length - 2]
  const sel = parsePeriod(selected)
  const inGrace = sel !== null && endOrdinal(sel) <= endOrdinal(lastP) + 1
  if (inGrace && prior && accounted(at(prior))) return { state: 'due', counted: prior, cell: at(prior), next: dueBy(last) }
  return { state: 'overdue', counted: null, cell: undefined, next: dueBy(inGrace && prior ? prior : last) }
}

export interface PeriodStatus {
  /** The status Health, Needs attention and the board count; '' when not reported. */
  status: string
  /** `worst of 3 segments`; `Q3 FY2026` or `Q3 due by Oct` for a coarse metric; the not-reported text when there is no status. */
  caption: string
  /** The column whose cell counts (the selected one for a metric at the selected grain). */
  counted: Column
  notReported: { kind: 'window' | 'stopped' | 'overdue' | 'na'; text: string } | null
  /** For the quiet line: `{metric} (Q3 FY2026; Q4 due by Jan)` when a coarse metric is up to date. */
  quiet: string | null
}

const TREND_SPAN: Record<Grain, number> = { month: 12, quarter: 8, half: 4, year: 3 }

function notApplicable(reason: string): string {
  return reason ? `Not applicable: ${reason}` : 'Not applicable'
}

/** No status for the selected column: the latest value in the window, or none. */
function lastReported(scope: ViewRow | null, children: ViewRow[], selected: Column, fy: number): PeriodStatus['notReported'] {
  const sel = parsePeriod(selected.period)
  if (!sel) return { kind: 'window', text: 'No reports' }
  const inWindow = (c: Cell) => {
    const p = parsePeriod(c.period)
    return !c.ytd && p !== null && p.grain === sel.grain && endOrdinal(p) <= endOrdinal(sel)
  }
  const rows = scope ? [scope, ...children] : children
  const shown = new Set(rows.flatMap((r) => r.cells.filter(inWindow).map((c) => c.period)))
  const span = shown.size > 0 ? shown.size : TREND_SPAN[sel.grain]
  const latest = (r: ViewRow) =>
    r.cells.filter((c) => inWindow(c) && cellReported(c)).sort((a, b) => endOrdinal(parsePeriod(b.period)!) - endOrdinal(parsePeriod(a.period)!))[0]
  const own = scope ? latest(scope) : undefined
  const fromChildren = children.map(latest).filter((c): c is Cell => c !== undefined)
  const found = own ?? fromChildren.sort((a, b) => endOrdinal(parsePeriod(b.period)!) - endOrdinal(parsePeriod(a.period)!))[0]
  if (!found) return { kind: 'window', text: `No reports in the last ${span} ${columnUnit(selected, span)}` }
  const label = periodLabel(parsePeriod(found.period)!, fy)
  const value = own && found.display ? ` (${found.display})` : ''
  const unrated = found.period === selected.period ? ', not rated' : ''
  return { kind: 'stopped', text: `Last reported ${label}${value}${unrated}` }
}

/** A cell standing in for a coarse period the scope did not report: the worst child's status. */
function childCell(base: ViewRow, col: Column, status: string): Cell {
  return {
    metricKey: base.metricKey,
    subjectId: base.subjectId,
    period: col.period,
    ytd: false,
    value: null,
    display: '',
    status,
    naReason: '',
    components: {},
    coverage: [0, 0],
    change: null,
    changeKind: '',
    target: null,
    versionId: '',
  }
}

/**
 * One metric's standing in the selected period: the single source for
 * Health, Needs attention, the board's Current column and Not reported, so
 * each metric is counted exactly once (a status, or not reported). `coarse`
 * is the metric's own grain's columns when it reports less often than the
 * selected grain, else [].
 */
export function periodStatus(input: {
  scope: ViewRow | null
  children: ViewRow[]
  frequency: Frequency
  selected: Column
  coarse: Column[]
  scale: StatusScaleEntry[]
  noun: 'segments' | 'services' | 'items'
  fy: number
}): PeriodStatus {
  const { scope, children, frequency, selected, coarse, scale, noun, fy } = input
  const selectedGrain = parsePeriod(selected.period)?.grain ?? 'month'
  const base = scope ?? children[0]
  if (coarse.length > 0 && base && coarserGrain(FREQUENCY_GRAIN[frequency], selectedGrain)) {
    return coarsePeriodStatus({ scope, children, base, selected, coarse, scale, noun, fy })
  }

  const at = statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey: selected.key, scale, noun })
  if (at.status) return { status: at.status, caption: at.caption, counted: selected, notReported: null, quiet: null }
  const own = scope?.cells.find((c) => cellKey(c) === selected.key)
  const notReported =
    own && !cellReported(own) && own.naReason !== ''
      ? { kind: 'na' as const, text: notApplicable(own.naReason) }
      : lastReported(scope, children, selected, fy)
  return { status: '', caption: '', counted: selected, notReported, quiet: null }
}

function coarsePeriodStatus({
  scope,
  children,
  base,
  selected,
  coarse,
  scale,
  noun,
  fy,
}: {
  scope: ViewRow | null
  children: ViewRow[]
  base: ViewRow
  selected: Column
  coarse: Column[]
  scale: StatusScaleEntry[]
  noun: 'segments' | 'services' | 'items'
  fy: number
}): PeriodStatus {
  const captions = new Map<string, string>()
  const cells: Cell[] = []
  for (const col of coarse) {
    const own = scope?.cells.find((c) => !c.ytd && c.period === col.period)
    if (accounted(own)) {
      cells.push(own!)
      continue
    }
    const at = statusAtScope({ scope: { cells: [] }, children, columnKey: col.key, scale, noun })
    if (at.status) {
      cells.push(childCell(base, col, at.status))
      captions.set(col.key, at.caption)
    }
  }
  const s = coarseStatus({ ...base, cells }, coarse, selected.period, fy)
  const last = coarse[coarse.length - 1]!
  const metric = base.metricName

  if (s.state === 'none') {
    const text = `No reports in the last ${coarse.length} ${columnUnit(last, coarse.length)}`
    return { status: '', caption: text, counted: last, notReported: { kind: 'window', text }, quiet: null }
  }
  if (s.state === 'overdue') {
    const late = [...coarse].reverse().find((c) => c.label === s.next.label) ?? last
    const text = `${late.fullLabel} overdue (due by ${monthLabel(dueMonth(parsePeriod(late.period)!), fy)})`
    return { status: '', caption: text, counted: last, notReported: { kind: 'overdue', text }, quiet: null }
  }

  const counted = s.counted!
  const cell = s.cell
  if (cell && !cellReported(cell)) {
    const text = notApplicable(cell.naReason)
    return { status: '', caption: text, counted, notReported: { kind: 'na', text }, quiet: null }
  }
  const nextDue = `${s.next.label} due by ${s.next.dueBy}`
  if (!cell?.status) {
    const text = `Last reported ${counted.fullLabel}${cell?.display ? ` (${cell.display})` : ''}, not rated`
    return { status: '', caption: text, counted, notReported: { kind: 'stopped', text }, quiet: null }
  }
  const lead = s.state === 'current' ? counted.fullLabel : nextDue
  const childCaption = captions.get(counted.key)
  return {
    status: cell.status,
    caption: childCaption ? `${lead} · ${childCaption}` : lead,
    counted,
    notReported: null,
    quiet: `${metric} (${counted.fullLabel}; ${nextDue})`,
  }
}

/** The tooltip of a column that closes no coarse period: `Q3 FY2026 reports after Sep`. */
export function notDueCaption(column: Column, grain: CoarseGrain, fy: number): string {
  const p = parsePeriod(column.period)
  if (!p) return ''
  const containing = parent(lastMonth(p), grain)
  return `${periodLabel(containing, fy)} reports after ${shortMonth(lastMonth(containing), fy)}`
}
