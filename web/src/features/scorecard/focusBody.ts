import type { components } from '../../api/schema'
import { metricScope } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']

/**
 * What the dialog body shows for a metric's rows: the item grid when the
 * metric is uptime, or has item rows and no org-unit value to chart (§6.1);
 * otherwise the chart. Item rows rolled up to a unit with a value lead with
 * that value's chart.
 */
export function focusBodyKind(rows: ViewRow[]): 'chart' | 'items' {
  if (rows.some((r) => r.chartKind === 'uptime')) return 'items'
  if (!rows.some((r) => r.subjectKind === 'item')) return 'chart'
  const scope = metricScope(rows).scope
  return scope?.cells.some((c) => c.value !== null) ? 'chart' : 'items'
}
