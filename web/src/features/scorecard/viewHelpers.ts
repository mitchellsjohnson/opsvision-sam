import type { components } from '../../api/schema'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type ScorecardView = Schemas['ScorecardView']

export interface MetricGroup {
  key: string
  name: string
  rows: ViewRow[]
}

export interface CategoryGroup {
  id: string
  name: string
  metrics: MetricGroup[]
}

/** Rows grouped by category (in category order), then metric (in the order returned). */
export function groupRows(view: ScorecardView): CategoryGroup[] {
  const byCategory = new Map<string, Map<string, MetricGroup>>()
  for (const row of view.rows) {
    const metrics = byCategory.get(row.categoryId) ?? new Map<string, MetricGroup>()
    byCategory.set(row.categoryId, metrics)
    const group = metrics.get(row.metricKey) ?? { key: row.metricKey, name: row.metricName, rows: [] }
    metrics.set(row.metricKey, group)
    group.rows.push(row)
  }
  const known = [...view.categories].sort((a, b) => a.order - b.order)
  const groups: CategoryGroup[] = []
  for (const c of known) {
    const metrics = byCategory.get(c.id)
    if (metrics) groups.push({ id: c.id, name: c.name, metrics: [...metrics.values()] })
  }
  for (const [id, metrics] of byCategory) {
    if (!known.some((c) => c.id === id)) groups.push({ id, name: 'Other', metrics: [...metrics.values()] })
  }
  return groups
}

/** The key of a cell's column, matching `Column.key`: `2026-M10` or `YTD:2026-M10`. */
export function cellKey(c: Cell): string {
  return c.ytd ? `YTD:${c.period}` : c.period
}

/** `a / b`, optionally scaled like `a / b * 100`: a ratio of two measures. */
const RATIO = /^\s*([A-Za-z0-9_.-]+)\s*\/\s*([A-Za-z0-9_.-]+)\s*(?:\*\s*[0-9.]+\s*)?$/

/**
 * The two measure keys of a ratio metric (numerator, denominator) when the
 * formula is a ratio of exactly the two measures the cell carries; else null.
 */
export function ratioParts(
  formula: string | undefined,
  components: Record<string, number>,
): [string, string] | null {
  const match = formula === undefined ? null : RATIO.exec(formula)
  if (!match || !match[1] || !match[2]) return null
  if (Object.keys(components).length !== 2) return null
  if (!Object.hasOwn(components, match[1]) || !Object.hasOwn(components, match[2])) return null
  return [match[1], match[2]]
}

/**
 * The keys of the derived measures a formula references that records can
 * explain (a `days_in_period` measure counts days, not records).
 */
export function derivedMeasureKeys(formula: string | undefined, measures: readonly Schemas['Measure'][]): string[] {
  if (formula === undefined) return []
  const names = new Set(formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
  return measures
    .filter((m) => names.has(m.key) && m.source === 'derived' && m.derive && m.derive.op !== 'days_in_period')
    .map((m) => m.key)
}

/** A number with thousands separators and up to two decimals. */
export function plainNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
