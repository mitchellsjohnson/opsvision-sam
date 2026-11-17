import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { columnUnit } from '../logic/statusText'
import type { ChartPoint } from './points'

/** Plan is 100%: a value above it is over plan. */
export const PLAN = 100

/**
 * The slide export's money-plan axis: centred on 100%, half-height the
 * largest deviation plus 3 points, and never under ±15.
 */
export function symmetricPlanDomain(values: number[]): [number, number] {
  const deviation = Math.max(0, ...values.map((v) => Math.abs(v - PLAN)))
  const half = Math.max(Math.ceil(deviation + 3), 15)
  return [PLAN - half, PLAN + half]
}

/**
 * The app's money-plan axis in points from plan, up = over plan (§6). The
 * side the data uses runs to its largest deviation (at least 12) plus 3;
 * when every deviation is on one side, the other side is a fifth of that
 * (at least 3), so the bars get the height. Mixed months stay symmetric.
 */
export function moneyPlanDomain(deviations: number[]): [number, number] {
  const largest = Math.max(0, ...deviations.map((d) => Math.abs(d)))
  const side = Math.ceil(Math.max(largest, 12)) + 3
  const small = Math.max(3, Math.round(0.2 * side))
  if (deviations.length > 0 && deviations.every((d) => d >= 0)) return [-small, side]
  if (deviations.length > 0 && deviations.every((d) => d <= 0)) return [-side, small]
  return [-side, side]
}

/** `$12.7M` from $1,000k (one decimal), `$950k` below; other units as plain numbers (`12,668`). */
export function formatMoneyCompact(value: number, unit: string): string {
  if (unit === '$k') {
    const k = Math.round(value)
    return Math.abs(k) >= 1000 ? `$${(value / 1000).toFixed(1)}M` : `$${k}k`
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** `+4%`, `-4%` or `0%`: how far a value is from plan, in the metric's format. */
export function deviationText(value: number, format: string): string {
  const decimals = metricDecimals(format)
  const delta = Number((value - PLAN).toFixed(decimals))
  const text = formatMetricValue(format, Math.abs(delta))
  return delta > 0 ? `+${text}` : delta < 0 ? `-${text}` : text
}

function valued(points: ChartPoint[]): number[] {
  return points.flatMap((p) => (p.kind === 'value' && p.value !== null ? [p.value] : []))
}

/** `Over plan in 12 of the last 12 months`, or `in 3 of 5 months` when some periods have no value. */
export function moneyPlanContext(points: ChartPoint[], columns: Column[]): string {
  const values = valued(points)
  const over = values.filter((v) => v > PLAN).length
  const unit = columnUnit(columns[0], values.length)
  return values.length === points.length
    ? `Over plan in ${over} of the last ${values.length} ${unit}`
    : `Over plan in ${over} of ${values.length} ${unit}`
}

/**
 * `over plan in 12 of the last 12 months`: what a framed tile's value row
 * joins after the amounts (`$12.7M spent of $12.2M planned · over plan in …`, §6),
 * since a framed money-plan chart leaves its own context line out.
 */
export function overPlanPhrase(points: ChartPoint[], columns: Column[]): string {
  if (valued(points).length === 0) return ''
  const text = moneyPlanContext(points, columns)
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** The chart's text summary: `Spend vs plan: over plan in 1 of 2 months; Oct 104% of plan, Green`. */
export function moneyPlanSummary(name: string, points: ChartPoint[], columns: Column[], statusLabel: (key: string) => string): string {
  const values = valued(points)
  const over = values.filter((v) => v > PLAN).length
  const current = points.at(-1)
  const now =
    current?.kind === 'value'
      ? `${current.label} ${current.display} of plan${current.status ? `, ${statusLabel(current.status)}` : ''}`
      : `${current?.label ?? ''} ${current?.kind === 'na' ? 'n/a' : 'no data'}`
  return `${name}: over plan in ${over} of ${values.length} ${columnUnit(columns[0], values.length)}; ${now}`
}
