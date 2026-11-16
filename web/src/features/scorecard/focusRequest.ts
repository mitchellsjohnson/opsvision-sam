import type { components } from '../../api/schema'
import { parsePeriod, type Grain } from '../../lib/period'
import { rangeMonths, type RangeKey } from './charts/ranges'
import { coarserGrain, FREQUENCY_GRAIN } from './columns'
import type { ViewRequestOptions } from './viewRequest'

type Frequency = components['schemas']['Frequency']

const TREND_SPAN: Record<Exclude<Grain, 'month'>, number> = { quarter: 8, half: 4, year: 3 }

/**
 * The full-screen chart's window: the metric's own grain when it is coarser
 * than the selected one (quarters × 8, halves × 4, years × 3, whatever the
 * range), else the selected grain's trend; months are 12, or 24 when the
 * range goes past 12. Never more than 24 periods.
 */
export function focusWindow(range: RangeKey, period: string, frequency: Frequency): { grain: Grain; count: number } {
  const selected = parsePeriod(period)?.grain ?? 'month'
  const own = FREQUENCY_GRAIN[frequency]
  const grain = coarserGrain(own, selected) ? own : selected
  if (grain === 'month') return { grain, count: rangeMonths(range, period) > 12 ? 24 : 12 }
  return { grain, count: TREND_SPAN[grain] }
}

/**
 * The view request options for a window. Twelve months share the Overview's
 * request and cache; 24 months ask for this metric's rows only, as today;
 * any other window asks for its own grain only, for this metric.
 */
export function focusRequestOptions(window: { grain: Grain; count: number }, metricKey: string): ViewRequestOptions {
  if (window.grain === 'month') return window.count === 12 ? {} : { months: window.count, metrics: [metricKey] }
  return { window, metrics: [metricKey] }
}
