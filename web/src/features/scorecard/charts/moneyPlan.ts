import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { columnUnit } from '../logic/statusText'
import type { ChartPoint } from './points'

/** Plan is 100%: a value above it is over plan. */
export const PLAN = 100

/**
 * The money-plan value axis: centred on 100%, half-height the largest
 * deviation plus 3 points, and never under ±15 so small misses stay small.
 */
export function moneyPlanDomain(values: number[]): [number, number] {
  const deviation = Math.max(0, ...values.map((v) => Math.abs(v - PLAN)))
  const half = Math.max(Math.ceil(deviation + 3), 15)
  return [PLAN - half, PLAN + half]
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
