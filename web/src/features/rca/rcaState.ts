import type { components } from '../../api/schema'
import { metricDecimals } from '../scorecard/format'

type Cell = components['schemas']['Cell']
type ViewRow = components['schemas']['ViewRow']
type StatusRule = components['schemas']['StatusRule']
type StatusLevel = components['schemas']['StatusLevel']
type Role = components['schemas']['Role']

/** A company-standing cell's exec summary state, as its Why trigger shows it (spec §10.1). */
export type SummaryDisplay =
  | { state: 'missing'; canEdit: boolean }
  | { state: 'written' | 'stale'; excerpt: string; author: string; canEdit: boolean }

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
 * or a YTD cell.
 */
export function summaryDisplay(cell: Cell, role: Role): SummaryDisplay | null {
  const s = cell.summary
  if (cell.ytd || !s) return null
  const canEdit = role === 'admin'
  if (s.state === 'missing') return { state: 'missing', canEdit }
  if (s.state === 'written' || s.state === 'stale') return { state: s.state, excerpt: s.excerpt ?? '', author: s.author ?? '', canEdit }
  return null
}
