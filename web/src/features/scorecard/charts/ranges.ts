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

/** The last value less the first among `columns`; null with fewer than two values. */
export function rangeChange(row: ViewRow, columns: Column[]): RangeChange | null {
  const byKey = new Map(row.cells.map((c) => [cellKey(c), c]))
  const values = columns
    .map((col) => byKey.get(col.key))
    .filter((c) => c != null && c.naReason === '' && c.value != null)
    .map((c) => c!.value!)
  if (values.length < 2) return null
  const decimals = metricDecimals(row.format)
  const delta = Number((values[values.length - 1]! - values[0]!).toFixed(decimals)) || 0
  if (delta === 0) return { text: 'No change', move: valueMove(0, row.direction) }
  return { text: signedAmount(row.format, delta), move: valueMove(delta, row.direction) }
}
