import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { cellKey } from '../viewHelpers'
import { valueMove, type Move } from './chartTheme'

type ViewRow = components['schemas']['ViewRow']

export type RangeKey = '3M' | '6M' | '12M' | 'YTD' | '24M'

/** The focus dialog's ranges, in strip order. */
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: '12M', label: '12M' },
  { key: 'YTD', label: 'YTD' },
  { key: '24M', label: '24M' },
]

const MONTHS: Record<Exclude<RangeKey, 'YTD'>, number> = { '3M': 3, '6M': 6, '12M': 12, '24M': 24 }

/**
 * Months a range spans, ending at the selected month. Fiscal months count from
 * the fiscal year start, so YTD is the selected month's index in its year.
 */
export function rangeMonths(key: RangeKey, period: string): number {
  if (key !== 'YTD') return MONTHS[key]
  const p = parsePeriod(period)
  return p?.grain === 'month' ? p.index : 12
}

export interface RangeChange {
  /** `+2.1 pts`, `-0.5`, `+$12k`, or `No change`. */
  text: string
  move: Move
}

/** A signed amount in the metric's format; percentages move in points. */
function signedAmount(format: string, delta: number): string {
  const amount = formatMetricValue(format, Math.abs(delta))
  const sign = delta < 0 ? '-' : '+'
  return format.startsWith('percent') ? `${sign}${amount.replace(/%$/, ' pts')}` : `${sign}${amount}`
}

/**
 * The improvement from `first` to `last` in a change rule's terms (`26% worse`),
 * as the engine computes it: relative to the first value, positive when the
 * value moved the good way. Null from zero, which has no percentage.
 */
function improvementChange(row: ViewRow, first: number, last: number): RangeChange | null {
  if (first === 0) return last === 0 ? { text: 'No change', move: valueMove(0, row.direction) } : null
  const diff = row.direction === 'lower_better' ? first - last : last - first
  const pct = Math.round((diff / Math.abs(first)) * 1000) / 10
  if (pct === 0) return { text: 'No change', move: valueMove(0, row.direction) }
  const text = `${Math.abs(pct)}% ${pct < 0 ? 'worse' : 'better'}`
  // The arrow follows the value; the tone, whether that was better.
  return { text, move: valueMove(row.direction === 'lower_better' ? -pct : pct, row.direction) }
}

/**
 * The last value less the first among `columns`; null with fewer than two
 * values. A metric judged on change states it as the header does: `26% worse`.
 */
export function rangeChange(row: ViewRow, columns: Column[]): RangeChange | null {
  const byKey = new Map(row.cells.map((c) => [cellKey(c), c]))
  const cells = columns.map((col) => byKey.get(col.key)).filter((c) => c != null && c.naReason === '' && c.value != null)
  const values = cells.map((c) => c!.value!)
  if (values.length < 2) return null
  if (cells.some((c) => c!.rule?.type === 'change')) return improvementChange(row, values[0]!, values[values.length - 1]!)
  const decimals = metricDecimals(row.format)
  const delta = Number((values[values.length - 1]! - values[0]!).toFixed(decimals)) || 0
  if (delta === 0) return { text: 'No change', move: valueMove(0, row.direction) }
  return { text: signedAmount(row.format, delta), move: valueMove(delta, row.direction) }
}
