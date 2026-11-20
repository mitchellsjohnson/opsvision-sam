import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import { buildTrendColumns, COARSE_SPAN, coarseColumns, type CoarseGrain, type Column } from '../columns'
import { focusBodyKind } from '../focusBody'
import { cellKey, columnsFor, groupRows, metricScope } from '../viewHelpers'
import { periodStatus, type PeriodStatus } from './coarse'
import { buildItemRows, itemSummary, type ItemRow } from './itemGrid'
import { streakMonths, type NeedsAttentionItem } from './needsAttention'
import { countNoun, nounForms, nounFromId, type NounForms } from './nouns'
import { buildBoardRow, type BoardRow } from './statusBoard'
import type { StatusScaleEntry } from './statusAtScope'
import { sinceText } from './statusText'

type Schemas = components['schemas']
type ScorecardView = Schemas['ScorecardView']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type MetricDef = Schemas['Metric']
type MethodologyVersion = Schemas['MethodologyVersion']

export type MetricNoun = NounForms

const LEGACY: Record<'segments' | 'services' | 'items', NounForms> = {
  segments: { one: 'segment', many: 'segments' },
  services: { one: 'service', many: 'services' },
  items: { one: 'item', many: 'items' },
}

/**
 * What a metric's children are called in captions (§3.3): for items, the
 * item kind's name, else the kind id from the metric's `reportedAt`; for
 * units, the children's org level; else `item` / `unit`. Without `o`, the
 * words callers had before (`services`, `segments`, `items`).
 */
export function metricNoun(
  chartKind: string,
  scope: ViewRow | null,
  children: ViewRow[],
  o?: { metric?: MetricDef; itemKinds?: { id: string; name: string }[]; levelName?: string },
): NounForms {
  if (!o) {
    if (chartKind === 'uptime') return LEGACY.services
    return scope && children.length > 0 ? LEGACY.segments : LEGACY.items
  }
  const kindId = o.metric?.reportedAt.find((s) => s.kind === 'item_kind')?.id
  if (kindId || children.some((c) => c.subjectKind === 'item')) {
    const name = kindId ? o.itemKinds?.find((k) => k.id === kindId)?.name : undefined
    if (name) return nounForms(name, 'item')
    return kindId ? nounFromId(kindId) : nounForms(undefined, 'item')
  }
  if (children.length > 0) return nounForms(o.levelName, 'unit')
  return nounForms(undefined, 'item')
}

function scopeCell(row: ViewRow | null, columnKey: string): Cell | undefined {
  return row?.cells.find((c) => cellKey(c) === columnKey)
}

/** One metric's standing in the selected period, as Health, Needs attention, the tiles and the report count it. */
export interface MetricStanding {
  key: string
  category: { id: string; name: string }
  rows: ViewRow[]
  scope: ViewRow | null
  head: ViewRow
  children: ViewRow[]
  noun: MetricNoun
  /** The metric's own columns: the trend, or its coarse grain's periods. */
  columns: Column[]
  /** The coarse columns when the metric reports less often than the selected grain, else []. */
  coarse: Column[]
  status: PeriodStatus | null
  prior: PeriodStatus | null
  /** The scope's cell in the counted column. */
  cell: Cell | undefined
  rule: Schemas['StatusRule'] | undefined
  /** Uptime and metrics reported only for items (§6.1). */
  isItems: boolean
  kindId: string | undefined
  /** The metric over its own columns, for streaks and the attention ribbon. */
  own: BoardRow
}

export interface Standings {
  /** The trend window ending at the period: 12 months, 8 quarters, 4 halves or 3 years. */
  trend: Column[]
  selected: Column | undefined
  priorTrend: Column | undefined
  metrics: MetricStanding[]
}

/**
 * Every metric's standing in `period`, from a view with the trend window and
 * the coarse periods the version in force asks for. The Overview and the
 * report both count from it, so they agree.
 */
export function metricStandings(input: {
  view: ScorecardView
  period: string
  fy: number
  scale: StatusScaleEntry[]
  versions?: MethodologyVersion[]
  /** The item kinds' names, for item metrics' nouns; their ids stand in without them. */
  itemKinds?: { id: string; name: string }[]
  /** The org levels, for unit children's nouns. */
  orgLevels?: { depth: number; name: string }[]
}): Standings {
  const { view, period, fy, scale } = input
  const trend = buildTrendColumns(period, fy)
  const selected = trend[trend.length - 1]
  const priorTrend = trend[trend.length - 2]
  const selectedGrain = parsePeriod(period)?.grain ?? 'month'
  const responded = new Set(view.periods)
  const coarseByGrain: Partial<Record<CoarseGrain, Column[]>> = {}
  for (const grain of ['quarter', 'half', 'year'] as const) {
    const cols = coarseColumns(period, grain, COARSE_SPAN[grain], fy)
    if (cols.length > 0 && cols.every((c) => responded.has(c.period))) coarseByGrain[grain] = cols
  }
  const metricDef = (metricKey: string, versionId: string): MetricDef | undefined =>
    input.versions?.find((v) => v.id === versionId)?.content.metrics.find((x) => x.key === metricKey)
  const levelName = (children: ViewRow[]) => input.orgLevels?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name

  const metrics = groupRows(view).flatMap((g) =>
    g.metrics.map((m): MetricStanding => {
      const { scope, children, head } = metricScope(m.rows)
      const nounDef = metricDef(head.metricKey, view.versionByPeriod[selected?.key ?? ''] ?? '')
      // Callers that pass neither kinds nor levels (the report) keep their words unless the metric names its kind.
      const legacy = !input.itemKinds && !input.orgLevels && !nounDef?.reportedAt.some((s) => s.kind === 'item_kind')
      const noun = legacy
        ? metricNoun(head.chartKind, scope, children)
        : metricNoun(head.chartKind, scope, children, { metric: nounDef, itemKinds: input.itemKinds, levelName: levelName(children) })
      const columns = columnsFor(head.frequency, selectedGrain, trend, coarseByGrain)
      const coarse = columns === trend ? [] : columns
      const status = selected
        ? periodStatus({ scope, children, frequency: head.frequency, selected, coarse, scale, noun, fy })
        : null
      const prior = priorTrend
        ? periodStatus({ scope, children, frequency: head.frequency, selected: priorTrend, coarse, scale, noun, fy })
        : null
      const columnKey = status?.counted.key ?? ''
      const cell = scopeCell(scope, columnKey)
      const def = metricDef(head.metricKey, cell?.versionId || view.versionByPeriod[columnKey] || '')
      const category = { id: g.id, name: g.name }
      return {
        key: m.key,
        category,
        rows: m.rows,
        scope,
        head,
        children,
        noun,
        columns,
        coarse,
        status,
        prior,
        cell,
        rule: cell?.rule ?? def?.rule,
        isItems: focusBodyKind(m.rows) === 'items' && m.rows.some((r) => r.subjectKind === 'item'),
        kindId: def?.reportedAt.find((s) => s.kind === 'item_kind')?.id,
        own: buildBoardRow({ key: m.key, category, scope, head, children, noun, columns, scale, fyStart: fy }),
      }
    }),
  )
  return { trend, selected, priorTrend, metrics }
}

/**
 * Metrics the version in force reports only for tracked items that have no
 * rows in the view (a scope with no services): not reported, not gone.
 */
export function absentItemMetrics(
  view: ScorecardView,
  versions: MethodologyVersion[] | undefined,
  selected: Column | undefined,
  shown: MetricStanding[],
): MetricDef[] {
  const keys = new Set(shown.map((m) => m.key))
  const defs = versions?.find((v) => v.id === view.versionByPeriod[selected?.key ?? ''])?.content.metrics ?? []
  return defs.filter((m) => !keys.has(m.key) && m.reportedAt.length > 0 && m.reportedAt.every((s) => s.kind === 'item_kind'))
}

/** Metrics by status key, every metric counted once; no status counts under `notReported`. */
export function healthTally(statuses: string[], absent: number, notReported: string): Map<string, number> {
  const counts = new Map<string, number>([[notReported, absent]])
  for (const s of statuses) {
    const key = s || notReported
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** An item metric's rows over its own columns. */
export function itemRowsOf(m: MetricStanding, scale: StatusScaleEntry[], fy: number): ItemRow[] {
  return buildItemRows(m.rows, m.columns, scale, () => '', fy)
}

/**
 * What Needs attention ranks (§4.3), one entry per metric with a status: the
 * worst item's value for an item metric, the prior status and the streak at
 * the counted column, and the reason.
 */
export function attentionInputs(
  metrics: MetricStanding[],
  options: {
    categories: ScorecardView['categories']
    scale: StatusScaleEntry[]
    fy: number
    statusLabel: (key: string) => string | undefined
    kindName?: (id: string | undefined) => string | undefined
  },
): NeedsAttentionItem[] {
  const { categories, scale, fy, statusLabel } = options
  const kindName = options.kindName ?? (() => undefined)
  return metrics.flatMap((m): NeedsAttentionItem[] => {
    const { head, status, columns, own, cell } = m
    if (!status?.status) return []
    const index = columns.findIndex((c) => c.key === status.counted.key)
    const before = index > 0 ? own.cells[index - 1] : undefined
    const priorStatus = before?.kind === 'status' ? before.status : ''
    const label = statusLabel(status.status) ?? status.status
    const items = m.isItems ? itemRowsOf(m, scale, fy) : null
    const worst = items ? itemSummary(items, scale).worst : null
    const count = items ? items.filter((r) => r.reported && r.status === status.status).length : 0
    return [
      {
        metricKey: head.metricKey,
        name: head.metricName,
        categoryOrder: categories.find((c) => c.id === m.category.id)?.order ?? 0,
        status: status.status,
        value: worst ? worst.value : (cell?.value ?? null),
        change: worst ? (worst.cell?.change ?? null) : (cell?.change ?? null),
        direction: head.direction,
        rule: (worst ? worst.cell?.rule : undefined) ?? m.rule ?? { type: 'bands' },
        priorStatus,
        streakMonths: index >= 0 ? streakMonths(own.cells, index, columns) : 0,
        priorLabel: priorStatus ? (statusLabel(priorStatus) ?? priorStatus) : '',
        label,
        since: index >= 0 ? sinceText(own.cells, index, columns, statusLabel) : '',
        countReason: items ? `${countNoun(count, nounForms(kindName(m.kindId), 'item'))} ${label}` : undefined,
      },
    ]
  })
}
