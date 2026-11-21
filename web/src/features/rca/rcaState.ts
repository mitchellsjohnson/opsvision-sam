import type { components } from '../../api/schema'
import { formatPeriod, lastMonth, monthLabel, parsePeriod } from '../../lib/period'
import { metricDecimals } from '../scorecard/format'

type Cell = components['schemas']['Cell']
type MetricSummary = components['schemas']['MetricSummary']
type ViewRow = components['schemas']['ViewRow']
type StatusRule = components['schemas']['StatusRule']
type StatusLevel = components['schemas']['StatusLevel']
type Role = components['schemas']['Role']

/**
 * A company-standing cell's exec summary state, as its Why trigger shows it
 * (spec §10.1). `neededFor` (`Jun 2026`) marks a coarse metric's counted
 * period that another month's publication needs, so the month shown does not.
 */
export type SummaryDisplay =
  | { state: 'missing'; canEdit: boolean; neededFor?: string }
  | { state: 'written' | 'stale'; excerpt: string; author: string; canEdit: boolean }

/**
 * The month whose publication needs the summary of `slot` (`Jun 2026` for
 * `2026-H1`), when `slot` is a quarter, half or year that the month shown
 * does not close; undefined for a month's own slot, the month that closes the
 * period, or when what is shown is not a month.
 */
export function neededFor(slot: string, month: string, fiscalYearStartMonth: number): string | undefined {
  const p = parsePeriod(slot)
  const m = parsePeriod(month)
  if (!p || !m || p.grain === 'month' || m.grain !== 'month') return undefined
  const closes = lastMonth(p)
  return formatPeriod(closes) === month ? undefined : monthLabel(closes, fiscalYearStartMonth)
}

/**
 * For a list row: the month a coarse metric's counted period was required
 * in (`Jun 2026`), when the month listed does not require it but the period
 * falls short of perfect; else undefined.
 */
export function requiredFor(
  s: Pick<MetricSummary, 'period' | 'requirement' | 'standing'>,
  month: string,
  fiscalYearStartMonth: number,
): string | undefined {
  if (s.requirement !== 'optional' || !s.standing.headline) return undefined
  return neededFor(s.period, month, fiscalYearStartMonth)
}

/**
 * The best-ranked status the cell's own rule can produce: band statuses for
 * `bands` and `change` rules, step statuses for `scale` rules. A scale level
 * no rule uses never makes the rule's best "not best". '' when none is known.
 */
export function bestStatus(rule: StatusRule, scale: StatusLevel[]): string {
  const produced = rule.type === 'scale' ? (rule.scale ?? []).map((s) => s.status) : (rule.bands ?? []).map((b) => b.status)
  let best = ''
  let bestRank = 0
  for (const s of produced) {
    const level = scale.find((l) => l.key === s)
    if (level && (best === '' || level.rank < bestRank)) {
      best = s
      bestRank = level.rank
    }
  }
  return best
}

/** Whether the displayed value falls short of the row's ideal, in whole display units (§4.2). */
function belowIdeal(row: ViewRow, cell: Cell): boolean {
  if (row.rcaIdeal === undefined || cell.value === null) return false
  const scaleBy = 10 ** metricDecimals(row.format)
  const ideal = Math.round(row.rcaIdeal * scaleBy)
  const shown = Math.round(cell.value * scaleBy)
  return row.direction === 'lower_better' ? shown > ideal : shown < ideal
}

/**
 * Whether the cell has attribution (spec §4.2): it is not at its best status,
 * or its displayed value is short of `row.rcaIdeal`. Derived here because
 * views never carry it. A cell with no value but readable children (the
 * Uptime company row) is left to its summary state.
 */
export function attributionAvailable(row: ViewRow, cell: Cell, scale: StatusLevel[]): boolean {
  if (cell.ytd || cell.naReason !== '' || cell.status === '' || !cell.rule) return false
  const best = bestStatus(cell.rule, scale)
  if (best === '') return false
  return cell.status !== best || belowIdeal(row, cell)
}

/**
 * The exec summary state of a company-root cell, from `Cell.summary`: the
 * missing tag for everyone, the call to act (`canEdit`) for admins only.
 * Null where there is nothing to draw: no summary state, an optional slot,
 * or a YTD cell. `neededFor` (from `neededFor`) goes on a missing state.
 */
export function summaryDisplay(cell: Cell, role: Role, needed?: string): SummaryDisplay | null {
  const s = cell.summary
  if (cell.ytd || !s) return null
  const canEdit = role === 'admin'
  if (s.state === 'missing') return needed ? { state: 'missing', canEdit, neededFor: needed } : { state: 'missing', canEdit }
  if (s.state === 'written' || s.state === 'stale') return { state: s.state, excerpt: s.excerpt ?? '', author: s.author ?? '', canEdit }
  return null
}
