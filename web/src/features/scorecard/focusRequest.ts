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

const SHARED_SPAN: Record<Grain, number> = { month: 12, ...TREND_SPAN }

/**
 * The view request options for a window. The selected period's own trend
 * (12 months, 8 quarters, 4 halves, 3 years) shares the Overview's request
 * and cache; 24 months ask for this metric's rows only, as today; any other
 * window asks for its own grain only, for this metric.
 */
export function focusRequestOptions(window: { grain: Grain; count: number }, metricKey: string, period: string): ViewRequestOptions {
  const selected = parsePeriod(period)?.grain ?? 'month'
  if (window.grain === selected && window.count === SHARED_SPAN[selected]) return {}
  if (window.grain === 'month') return { months: window.count, metrics: [metricKey] }
  return { window, metrics: [metricKey] }
}
