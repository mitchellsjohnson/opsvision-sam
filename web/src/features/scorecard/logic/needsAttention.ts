import type { components } from '../../../api/schema'
import { monthsOf, parsePeriod } from '../../../lib/period'
import type { Column } from '../columns'
import type { StatusScaleEntry } from './statusAtScope'
import { streakAt, type BoardCell } from './statusBoard'

export type Direction = components['schemas']['Direction']
export type StatusRule = components['schemas']['StatusRule']

export interface NeedsAttentionItem {
  metricKey: string
  name: string
  categoryOrder: number
  status: string
  value: number | null
  change: number | null
  direction: Direction
  rule: StatusRule
  priorStatus: string
  /** Months the status has held at the counted period (`streakMonths`). */
  streakMonths: number
  /** The scale's label for `priorStatus`; '' when there is none. */
  priorLabel: string
  /** The scale's label for `status`. */
  label: string
  /** `sinceText` at the counted period: `Red since Jul 2026 · 4 months`, `Red all 12 months shown`. */
  since: string
  /** For item metrics, the reason in items: `1 service Red`. */
  countReason?: string
}

function rankOf(scale: StatusScaleEntry[], status: string): number {
  return scale.find((s) => s.key === status)?.rank ?? 0
}

function worstRank(scale: StatusScaleEntry[]): number {
  return Math.max(...scale.map((s) => s.rank))
}

function bestRank(scale: StatusScaleEntry[]): number {
  return Math.min(...scale.map((s) => s.rank))
}

export function distancePastWorst(item: NeedsAttentionItem, scale: StatusScaleEntry[]): number {
  if (item.value == null) return 0
  if (item.rule.type === 'change') {
    if (item.change == null) return 0
    return Math.abs(item.change)
  }
  if (item.rule.type !== 'bands' || !item.rule.bands?.length) return 0

  const worstKey = scale.find((s) => s.rank === worstRank(scale))?.key
  if (!worstKey) return 0

  const bands = item.rule.bands
  const worstIdx = bands.findIndex((b) => b.status === worstKey)
  if (worstIdx < 0) return 0

  const worstBand = bands[worstIdx]!
  let threshold: number
  if (worstBand.op === '') {
    const neighbor = bands[worstIdx - 1]
    if (!neighbor) return 0
    threshold = neighbor.value
  } else {
    threshold = worstBand.value
  }

  let width = 10
  const betterNeighbor = bands[worstIdx - 1]
  const betterBeyond = bands[worstIdx - 2]
  if (worstBand.op === '') {
    if (betterBeyond) width = Math.abs(betterBeyond.value - threshold) || 10
    else if (betterNeighbor) width = Math.abs(betterNeighbor.value - threshold) || 10
  } else if (betterNeighbor) {
    width = Math.abs(threshold - betterNeighbor.value) || 10
  }

  const value = item.value
  if (item.direction === 'higher_better') {
    if (value >= threshold) return 0
    return (threshold - value) / width
  }
  if (value <= threshold) return 0
  return (value - threshold) / width
}

/** How many metrics Needs attention shows. */
const SHOWN = 3

/** Worst status (1), lost a rank since the prior period (2, "slipping"), or a middle status (3). */
export type Tier = 1 | 2 | 3

export type RankedItem = NeedsAttentionItem & {
  tier: Tier
  /** Band widths past the worst line (`distancePastWorst`). */
  distance: number
  /** Worst now, and not worst in the prior period. */
  newRed: boolean
  /** `Red since Jul 2026 · 4 months`, `New Red · fell from Green`, `1 service Red`, `Fell from Green`. */
  reason: string
}

function tierFor(item: NeedsAttentionItem, scale: StatusScaleEntry[]): Tier | null {
  const rank = rankOf(scale, item.status)
  if (rank === bestRank(scale)) return null
  if (rank === worstRank(scale)) return 1
  const lost = rankOf(scale, item.status) - rankOf(scale, item.priorStatus)
  if (item.priorStatus && lost >= 1) return 2
  if (rank > bestRank(scale) && rank < worstRank(scale)) return 3
  return null
}

function reasonFor(item: NeedsAttentionItem, tier: Tier, newRed: boolean): string {
  if (item.countReason) return item.countReason
  if (tier === 1 && newRed) return item.priorLabel ? `New ${item.label} · fell from ${item.priorLabel}` : `New ${item.label}`
  if (tier === 2 && item.priorLabel) return `Fell from ${item.priorLabel}`
  return item.since || item.label
}

/**
 * How many months the status at `index` has held, whatever the grain: a
 * quarter counts 3, a half 6, a year 12. 0 when the cell has no status.
 */
export function streakMonths(cells: BoardCell[], index: number, columns: Column[]): number {
  const streak = streakAt(cells, index)
  return columns.slice(index - streak + 1, index + 1).reduce((n, c) => {
    const p = parsePeriod(c.period)
    return n + (p && !c.ytd ? monthsOf(p).length : 1)
  }, 0)
}

const byStreak = (a: RankedItem, b: RankedItem) =>
  b.streakMonths - a.streakMonths || b.distance - a.distance || a.categoryOrder - b.categoryOrder

/**
 * The metrics that need attention, at most three (§4.3): the most severe New
 * Red takes one slot, the other worst-status metrics fill slots by streak in
 * months, then distance past the line, then category order; then slipping,
 * then middle statuses. Shown by tier, then streak, then distance. `totals`
 * counts every metric in each tier, shown or not.
 */
export function needsAttention(
  items: NeedsAttentionItem[],
  scale: StatusScaleEntry[],
): { shown: RankedItem[]; totals: { red: number; slipping: number; middle: number } } {
  const ranked: RankedItem[] = []
  const lostOf = new Map<string, number>()
  for (const item of items) {
    const tier = tierFor(item, scale)
    if (tier == null) continue
    const newRed = tier === 1 && item.priorStatus !== '' && rankOf(scale, item.priorStatus) < worstRank(scale)
    lostOf.set(item.metricKey, item.priorStatus ? rankOf(scale, item.status) - rankOf(scale, item.priorStatus) : 0)
    ranked.push({ ...item, tier, distance: distancePastWorst(item, scale), newRed, reason: reasonFor(item, tier, newRed) })
  }

  const red = ranked.filter((r) => r.tier === 1).sort(byStreak)
  const slipping = ranked
    .filter((r) => r.tier === 2)
    .sort((a, b) => (lostOf.get(b.metricKey) ?? 0) - (lostOf.get(a.metricKey) ?? 0) || byStreak(a, b))
  const middle = ranked.filter((r) => r.tier === 3).sort(byStreak)

  const severestNew = [...red.filter((r) => r.newRed)].sort(
    (a, b) => b.distance - a.distance || a.categoryOrder - b.categoryOrder,
  )[0]
  const picked = new Set<RankedItem>(severestNew ? [severestNew] : [])
  for (const r of [...red, ...slipping, ...middle]) {
    if (picked.size >= SHOWN) break
    picked.add(r)
  }
  const order = [...red, ...slipping, ...middle]
  const shown = [...picked].sort((a, b) => a.tier - b.tier || (a.tier === 1 ? byStreak(a, b) : order.indexOf(a) - order.indexOf(b)))

  return { shown, totals: { red: red.length, slipping: slipping.length, middle: middle.length } }
}
