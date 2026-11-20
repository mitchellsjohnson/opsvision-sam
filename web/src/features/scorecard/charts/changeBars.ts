import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import type { Column } from '../columns'
import { cellKey } from '../viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']

export interface ChangeBar {
  key: string
  /** How much worse than the comparison, in percent (or the format's units for a delta); negative is better. Null with no change. */
  worse: number | null
  status: string
}

function lastRule(row: ViewRow, columns: Column[]) {
  return row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)?.rule
}

/** Whether the row's status is judged on change (§9): its last column has a change rule. */
export function isChangeRow(row: ViewRow, columns: Column[]): boolean {
  return lastRule(row, columns)?.type === 'change'
}

/**
 * One bar per column: the change that set its status, as how much worse.
 * An `improvement_pct` change is positive when better (engine/metric.go),
 * so `worse = −change`; a delta is worse when it moves against the direction.
 */
export function changeBarsFor(row: ViewRow, columns: Column[]): ChangeBar[] {
  const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
  return columns.map((col) => {
    const cell = cells.get(col.key)
    const status = cell?.status ?? ''
    if (!cell || cell.change === null || cell.changeKind === '') return { key: col.key, worse: null, status }
    if (cell.changeKind === 'improvement_pct') return { key: col.key, worse: -cell.change, status }
    return { key: col.key, worse: row.direction === 'higher_better' ? -cell.change : cell.change, status }
  })
}

/**
 * The rule's band edges in worse terms, low first, and the Red boundary: the
 * edge the worst band starts at (`−(−5)` = 5% worse). Null without bands.
 */
export function changeEdges(row: ViewRow, columns: Column[]): { edges: number[]; red: number | null } {
  const bands = lastRule(row, columns)?.bands ?? []
  const values = bands.filter((b) => b.op !== '').map((b) => b.value)
  const edges = [...new Set(values.map((v) => (v === 0 ? 0 : -v)))].sort((a, b) => a - b)
  return { edges, red: edges.length > 0 ? edges[edges.length - 1]! : null }
}

const GRAIN_WORD = { month: 'month', quarter: 'quarter', half: 'half-year', year: 'year' } as const

/** `Change vs the prior month`, `Change vs last year's average` or `Change vs the baseline`. */
export function changeCaption(compare: string | undefined, column: Column | undefined): string {
  if (compare === 'prior_year_average') return "Change vs last year's average"
  if (compare === 'baseline') return 'Change vs the baseline'
  const grain = parsePeriod(column?.period)?.grain ?? 'month'
  return `Change vs the prior ${GRAIN_WORD[grain]}`
}

/** `+27%`, `−33%` or `0%`: a bar's label, whole percent. */
export function worseText(worse: number): string {
  const n = Math.round(worse)
  return n > 0 ? `+${n}%` : n < 0 ? `−${-n}%` : '0%'
}

/** The chart summary's part for change bars: `Changes: Sep 27% worse (Red), Oct 26% worse (Red)`; '' when every period is at the best status. */
export function changeSummary(bars: ChangeBar[], columns: Column[], scale: StatusLevel[], statusLabel: (key: string) => string): string {
  const best = Math.min(...scale.map((s) => s.rank))
  const parts = bars.flatMap((b, i) => {
    const rank = scale.find((s) => s.key === b.status)?.rank
    if (b.worse === null || rank === undefined || rank <= best) return []
    const n = Math.abs(Math.round(b.worse))
    return [`${columns[i]?.label ?? ''} ${n}% ${b.worse >= 0 ? 'worse' : 'better'} (${statusLabel(b.status)})`]
  })
  return parts.length > 0 ? `Changes: ${parts.join(', ')}` : ''
}

/** A right-hand label's line box: 10px text on a 12px leading. */
export const SIDE_LABEL = 12
/** Room above the highest bar and below the lowest for their labels. */
const BAR_PAD = { top: 13, bottom: 4 }

/**
 * The bar panel's value-to-pixel map: the largest scale that keeps room for
 * the bars' labels, the Red boundary's label clear of `worse` in the top
 * slot, and the zero line (with its `0%` tick, when drawn) clear of
 * `better` in the bottom slot, whatever the bars hold.
 */
export function changeScale(height: number, values: number[], red: number | null, zeroTick: boolean): (v: number) => number {
  const hi = Math.max(1, red ?? 0, ...values)
  const lo = Math.min(-1, ...values)
  // y(v) = zero − k·v. Each bound is [c, m]: zero ≥ c + k·m below, zero ≤ c + k·m above.
  const floors: [number, number][] = [[BAR_PAD.top, hi]]
  if (red !== null && red > 0) floors.push([SIDE_LABEL + 1 + SIDE_LABEL / 2, red])
  const ceilings: [number, number][] = [
    [height - BAR_PAD.bottom, lo],
    [height - SIDE_LABEL - 1 - (zeroTick ? SIDE_LABEL / 2 : 0), 0],
  ]
  const k = Math.min(...floors.flatMap(([fc, fm]) => ceilings.map(([cc, cm]) => (cc - fc) / (fm - cm))))
  const zero = Math.min(...ceilings.map(([c, m]) => c + k * m))
  return (v) => zero - k * v
}

/** A bar label's width: 10px semibold, about 6px a character, and 2px apart. */
const labelWidth = (text: string) => text.length * 6 + 2

/**
 * Which bars keep their label when the columns are too narrow for all of
 * them: the worst status first, then the latest, each kept only when it
 * clears the labels already kept. Unmeasured (`slot` 0), every candidate.
 */
export function keptLabels(candidates: { index: number; rank: number; text: string }[], slot: number, count: number): Set<number> {
  if (slot <= 0) return new Set(candidates.map((c) => c.index))
  const span = (c: { index: number; text: string }) => {
    const w = labelWidth(c.text)
    // The first and last labels sit inside their column's outer edge.
    const center = c.index === 0 ? w / 2 : c.index === count - 1 ? slot * count - w / 2 : (c.index + 0.5) * slot
    return [center - w / 2, center + w / 2] as const
  }
  const kept: (readonly [number, number])[] = []
  const out = new Set<number>()
  for (const c of [...candidates].sort((a, b) => b.rank - a.rank || b.index - a.index)) {
    const [x0, x1] = span(c)
    if (kept.some(([k0, k1]) => x0 < k1 && k0 < x1)) continue
    kept.push([x0, x1])
    out.add(c.index)
  }
  return out
}
