import type { components } from '../../api/schema'
import { metricDecimals } from '../scorecard/format'

type Cell = components['schemas']['Cell']
type ViewRow = components['schemas']['ViewRow']
type StatusRule = components['schemas']['StatusRule']
type StatusLevel = components['schemas']['StatusLevel']
type Role = components['schemas']['Role']

/** What a Why trigger shows for one cell (spec §10.1). */
export type WhyDisplay =
  | { state: 'available' }
  | { state: 'needed'; canEdit: boolean }
  | { state: 'written' | 'stale'; excerpt: string; author: string; canEdit: boolean }
  | { state: 'rollup'; neededBelow: number; staleBelow: number; showCounts: boolean }

/**
 * Single-cell surfaces (tile why line, value rows) draw every state; dense
 * surfaces (board, grids, monthly values) never draw `available` (§4.3).
 */
export type WhySurface = 'single' | 'dense'

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

/** `available` per §9.2: derived on the client because views never carry it. */
function isAvailable(row: ViewRow, cell: Cell, scale: StatusLevel[]): boolean {
  if (cell.naReason !== '' || cell.status === '' || !cell.rule) return false
  const best = bestStatus(cell.rule, scale)
  if (best === '') return false
  return cell.status !== best || belowIdeal(row, cell)
}

/**
 * The Why state of one view cell: `Cell.rca` when the server sent it, else
 * `available` derived from `row.rcaIdeal`, the status and the rule. Tags are
 * shown only to people who can act: `canEdit` on the cell, or for roll-up
 * counts any admin or contributor (`role`). Null draws nothing.
 */
export function displayState(
  row: ViewRow,
  cell: Cell,
  scale: StatusLevel[],
  surface: WhySurface,
  role?: Role,
): WhyDisplay | null {
  if (cell.ytd) return null
  const rca = cell.rca
  const canEdit = rca?.canEdit === true
  if (rca?.state === 'written' || rca?.state === 'stale') {
    return { state: rca.state, excerpt: rca.excerpt ?? '', author: rca.author ?? '', canEdit }
  }
  if (rca?.state === 'needed') return { state: 'needed', canEdit }
  const neededBelow = rca?.neededBelow ?? 0
  const staleBelow = rca?.staleBelow ?? 0
  if (neededBelow + staleBelow > 0) {
    return { state: 'rollup', neededBelow, staleBelow, showCounts: canEdit || role === 'admin' || role === 'contributor' }
  }
  if (surface === 'dense') return null
  return isAvailable(row, cell, scale) ? { state: 'available' } : null
}
