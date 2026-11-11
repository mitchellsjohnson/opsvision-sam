import type { components } from '../../../api/schema'
import type { StatusScaleEntry } from './statusAtScope'

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

type Tiered = NeedsAttentionItem & {
  tier: number
  distance: number
  ranksLost: number
}

function tierFor(item: NeedsAttentionItem, scale: StatusScaleEntry[]): number | null {
  const rank = rankOf(scale, item.status)
  if (rank === bestRank(scale)) return null
  if (rank === worstRank(scale)) return 1
  const lost = rankOf(scale, item.status) - rankOf(scale, item.priorStatus)
  if (item.priorStatus && lost >= 1) return 2
  if (rank > bestRank(scale) && rank < worstRank(scale)) return 3
  return null
}

export function needsAttention(items: NeedsAttentionItem[], scale: StatusScaleEntry[]): NeedsAttentionItem[] {
  const tiered: Tiered[] = []
  for (const item of items) {
    const distance = distancePastWorst(item, scale)
    const tier = tierFor(item, scale)
    if (tier == null) continue
    tiered.push({
      ...item,
      tier,
      distance,
      ranksLost: item.priorStatus ? rankOf(scale, item.status) - rankOf(scale, item.priorStatus) : 0,
    })
  }

  tiered.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.tier === 1) {
      if (b.distance !== a.distance) return b.distance - a.distance
      return a.categoryOrder - b.categoryOrder
    }
    if (a.tier === 2) {
      if (b.ranksLost !== a.ranksLost) return b.ranksLost - a.ranksLost
      if (b.distance !== a.distance) return b.distance - a.distance
      return a.categoryOrder - b.categoryOrder
    }
    return a.categoryOrder - b.categoryOrder
  })

  return tiered.slice(0, 3)
}
