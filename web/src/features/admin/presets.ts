import type { Methodology, Metric } from '../../api/queries'
import { allPriorities } from './conditionModel'
import { newMetric, type Band, type DeriveRule, type Measure } from './methodologyModel'

/** The derived-measure presets of spec §8.1. */
export type PresetId = 'on_time' | 'weighted_open' | 'within_budget' | 'expected_value' | 'average_age' | 'count' | 'sum'

/** The blanks a preset asks for. Which ones apply depends on the preset. */
export interface PresetParams {
  /** Record type key; the measure keys start with it. */
  recordType: string
  /** The record type's name, for measure and metric names (default: the key). */
  recordTypeName?: string
  /** The filter: which records count. Empty counts every record. */
  where?: string
  /** weighted_open: weight per priority, `none` included (default: defaultWeights of the priorities). */
  weights?: Record<string, number>
  /** within_budget: how far actual may exceed planned, in percent (default 20). */
  tolerance?: number
  /** within_budget, count, sum: the date that places a record in a period. */
  bucketBy?: string
  /** sum: the number field to add up. */
  field?: string
  /** average_age: the date the age starts at (also the date that places a record in a period). */
  ageFrom?: string
  /** average_age: the date the age ends at; empty means the end of the period. */
  ageTo?: string
  /** within_budget: the key suffix of the planned and actual measures (default `spend_k`). */
  unit?: string
  /** count, sum: a key for the measure instead of the default. */
  key?: string
  /** Also create the metric, for presets that have one (default true). */
  withMetric?: boolean
  /** The new metric's category (default: the first category). */
  categoryId?: string
  /** Where the new metric is reported (default: nowhere yet). */
  reportedAt?: Metric['reportedAt']
  /** Status keys from best to worst, for the default bands (default G, Y, R). */
  statusKeys?: readonly string[]
}

export type PresetBlank = 'weights' | 'tolerance' | 'bucketBy' | 'field' | 'ages' | 'unit'

export interface PresetInfo {
  id: PresetId
  label: string
  /** What the preset calculates, in plain language. */
  sentence: string
  /** The blanks it asks for, besides the record type and the filter. */
  blanks: PresetBlank[]
  hasMetric: boolean
}

export const PRESETS: readonly PresetInfo[] = [
  {
    id: 'on_time',
    label: 'On-time delivery',
    sentence: 'Each due date is a commitment; a slip counts as a miss in that month.',
    blanks: [],
    hasMetric: true,
  },
  {
    id: 'weighted_open',
    label: 'Weighted open items',
    sentence: 'Every day, each open item adds the weight of its priority; the score is the average per day.',
    blanks: ['weights'],
    hasMetric: true,
  },
  {
    id: 'within_budget',
    label: 'Delivered within budget',
    sentence: 'The share of finished items whose actual spend stayed within the planned spend plus a tolerance.',
    blanks: ['tolerance', 'bucketBy', 'unit'],
    hasMetric: true,
  },
  {
    id: 'expected_value',
    label: 'Delivered expected value',
    sentence: 'The share of measured items whose delivered value met the expected value.',
    blanks: [],
    hasMetric: true,
  },
  {
    id: 'average_age',
    label: 'Average age',
    sentence: 'The average number of days between two dates, such as created and completed.',
    blanks: ['ages'],
    hasMetric: true,
  },
  { id: 'count', label: 'Count', sentence: 'How many items fall in each month.', blanks: ['bucketBy'], hasMetric: false },
  { id: 'sum', label: 'Sum', sentence: 'A number added up over the items in each month.', blanks: ['field', 'bucketBy'], hasMetric: false },
]

export function presetInfo(id: PresetId): PresetInfo {
  return PRESETS.find((p) => p.id === id) ?? (PRESETS[0] as PresetInfo)
}

/**
 * Default weights per priority: `none` weighs 1, the lowest named priority 2,
 * and the ones above it 4, 16, 64, … (64 / 16 / 4 / 2 / 1 for P1 to P4).
 */
export function defaultWeights(priorities: readonly string[]): Record<string, number> {
  const named = allPriorities(priorities).slice(0, -1)
  const out: Record<string, number> = {}
  named.forEach((p, i) => {
    const fromBottom = named.length - 1 - i
    out[p] = fromBottom === 0 ? 2 : 4 ** fromBottom
  })
  out.none = 1
  return out
}

/** camelCase to snake_case, for keys built from field names. */
function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** `a && b`, keeping an OR filter together. */
export function andWhere(filter: string | undefined, extra: string): string {
  const f = (filter ?? '').trim()
  if (f === '') return extra
  return /\|\||\bor\b/.test(f) ? `(${f}) && ${extra}` : `${f} && ${extra}`
}

function factor(tolerance: number): string {
  return String(Number((1 + tolerance / 100).toFixed(6)))
}

interface Planned {
  measures: Measure[]
  metric?: Metric
}

function derived(key: string, name: string, unit: string, derive: DeriveRule, orgAgg: Measure['orgAgg'] = 'sum'): Measure {
  const rule: DeriveRule = { ...derive }
  if (!rule.where) delete rule.where
  return { key, name, unit, orgAgg, timeAgg: 'sum', source: 'derived', derive: rule }
}

function bands(statusKeys: readonly string[], op: '>=' | '<=', green: number, yellow: number): Band[] {
  const [g = 'G', y = 'Y'] = statusKeys
  const r = statusKeys.length >= 3 ? (statusKeys[statusKeys.length - 1] ?? 'R') : 'R'
  return [
    { status: g, op, value: green },
    { status: y, op, value: yellow },
    { status: r, op: '', value: 0 },
  ]
}

/** The measures and metric a preset produces for the params, before merging. */
function plan(content: Methodology, id: PresetId, p: PresetParams): Planned {
  const t = p.recordType
  const T = p.recordTypeName || t
  const where = p.where?.trim() || undefined
  const statusKeys = p.statusKeys && p.statusKeys.length > 0 ? p.statusKeys : ['G', 'Y', 'R']
  const metric = (key: string, name: string, over: Partial<Metric>): Metric => ({
    ...newMetric(p.categoryId ?? content.categories[0]?.id ?? '', statusKeys),
    key,
    name,
    reportedAt: p.reportedAt ?? [],
    ...over,
  })
  const base = { recordType: t }

  switch (id) {
    case 'on_time':
      return {
        measures: [
          derived(`${t}_committed`, `${T} commitments`, 'count', { ...base, op: 'commitments', outcome: 'resolved', where }),
          derived(`${t}_on_time`, `${T} commitments met on time`, 'count', { ...base, op: 'commitments', outcome: 'met', where }),
        ],
        metric: metric(`${t}_on_time_pct`, `${T} on-time delivery`, {
          formula: `${t}_on_time / ${t}_committed * 100`,
          format: 'percent0',
          direction: 'higher_better',
          rule: { type: 'bands', bands: bands(statusKeys, '>=', 90, 80) },
          definition: 'Each due date is a commitment, judged in the month it falls in. A slip counts as a miss in that month.',
        }),
      }
    case 'weighted_open':
      return {
        measures: [
          derived(`${t}_points_sum`, `${T} weighted open points`, 'points', {
            ...base,
            op: 'daily_open_weighted',
            weights: { ...(p.weights ?? defaultWeights([])) },
            where,
          }),
          // Every unit reports the same calendar days, so days take the max across units.
          derived(`${t}_days`, `${T} days in period`, 'days', { ...base, op: 'days_in_period' }, 'max'),
        ],
        metric: metric(`${t}_weighted_score`, `${T} weighted score`, {
          formula: `${t}_points_sum / ${t}_days`,
          format: 'number2',
          direction: 'lower_better',
          rule: {
            type: 'change',
            compare: 'prior_period',
            bands: [
              { status: statusKeys[0] ?? 'G', op: '>=', value: 0 },
              { status: statusKeys[1] ?? 'Y', op: '>=', value: -5 },
              { status: statusKeys[statusKeys.length - 1] ?? 'R', op: '', value: 0 },
            ],
          },
          definition: 'Open items weighted by priority, averaged per day. Judged on change against the prior period.',
        }),
      }
    case 'within_budget': {
      const bucketBy = p.bucketBy || 'completedAt'
      const unit = p.unit?.trim() || 'spend_k'
      const tolerance = p.tolerance ?? 20
      const within = tolerance === 0 ? 'actual <= planned' : `actual <= planned * ${factor(tolerance)}`
      return {
        measures: [
          derived(`${t}_measured`, `${T} measured for budget`, 'count', { ...base, op: 'count', bucketBy, where }),
          derived(`${t}_within_budget`, `${T} within budget`, 'count', {
            ...base,
            op: 'count',
            bucketBy,
            where: andWhere(where, within),
          }),
          derived(`planned_${unit}`, `Planned ${unit}`, unit, { ...base, op: 'sum', field: 'planned', bucketBy, where }),
          derived(`actual_${unit}`, `Actual ${unit}`, unit, { ...base, op: 'sum', field: 'actual', bucketBy, where }),
        ],
        metric: metric(`${t}_within_budget_pct`, `${T} delivered within budget`, {
          formula: `${t}_within_budget / ${t}_measured * 100`,
          format: 'percent0',
          direction: 'higher_better',
          rule: { type: 'bands', bands: bands(statusKeys, '>=', 90, 80) },
          definition: `Share of measured items whose actual spend was at most ${tolerance}% over plan.`,
        }),
      }
    }
    case 'expected_value':
      return {
        measures: [
          derived(`${t}_ev_measured`, `${T} assessed for expected value`, 'count', { ...base, op: 'count', bucketBy: 'measuredAt', where }),
          derived(`${t}_ev_delivered`, `${T} that delivered expected value`, 'count', {
            ...base,
            op: 'count',
            bucketBy: 'measuredAt',
            where: andWhere(where, 'deliveredValue >= expectedValue'),
          }),
        ],
        metric: metric(`${t}_ev_pct`, `${T} delivered expected value`, {
          formula: `${t}_ev_delivered / ${t}_ev_measured * 100`,
          format: 'percent0',
          direction: 'higher_better',
          rule: { type: 'bands', bands: bands(statusKeys, '>=', 90, 80) },
          definition: 'Share of measured items whose delivered value met the value expected.',
        }),
      }
    case 'average_age': {
      const from = p.ageFrom || 'createdAt'
      const age: DeriveRule = { ...base, op: 'age_sum', bucketBy: from, ageFrom: from, where }
      if (p.ageTo) age.ageTo = p.ageTo
      return {
        measures: [
          derived(`${t}_age_days_sum`, `${T} age (sum of days)`, 'days', age),
          derived(`${t}_count`, `${T} count`, 'count', { ...base, op: 'count', bucketBy: from, where }),
        ],
        metric: metric(`${t}_average_age`, `${T} average age`, {
          formula: `${t}_age_days_sum / ${t}_count`,
          format: 'days0',
          direction: 'lower_better',
          rule: { type: 'bands', bands: bands(statusKeys, '<=', 14, 17) },
          definition: 'Average age in days.',
        }),
      }
    }
    case 'count':
      return {
        measures: [
          derived(p.key || `${t}_count`, `${T} count`, 'count', { ...base, op: 'count', bucketBy: p.bucketBy || 'createdAt', where }),
        ],
      }
    case 'sum': {
      const f = p.field || 'planned'
      return {
        measures: [
          derived(p.key || `${t}_${snake(f)}_sum`, `${T} ${snake(f).replace(/_/g, ' ')} total`, '', {
            ...base,
            op: 'sum',
            field: f,
            bucketBy: p.bucketBy || 'createdAt',
            where,
          }),
        ],
      }
    }
  }
}

/** The measure keys (and metric key, if any) a preset would create. */
export function presetKeys(id: PresetId, params: PresetParams): { measures: string[]; metric?: string } {
  const planned = plan({ categories: [], measures: [], metrics: [] }, id, params)
  const out: { measures: string[]; metric?: string } = { measures: planned.measures.map((m) => m.key) }
  if (planned.metric) out.metric = planned.metric.key
  return out
}

/**
 * Adds a preset's measures (and, unless `withMetric` is false, its metric) to
 * a methodology. A measure whose key already exists is made derived in place,
 * keeping its name, unit and aggregation; an existing metric is left as it is.
 * `created` lists the keys that were added. The input is not changed.
 */
export function applyPreset(content: Methodology, id: PresetId, params: PresetParams): { content: Methodology; created: string[] } {
  const next = structuredClone(content)
  const planned = plan(next, id, params)
  const created: string[] = []
  for (const m of planned.measures) {
    const i = next.measures.findIndex((x) => x.key === m.key)
    const existing = next.measures[i]
    if (existing) {
      next.measures[i] = { ...existing, source: 'derived', derive: m.derive }
    } else {
      next.measures.push(m)
      created.push(m.key)
    }
  }
  if (planned.metric && params.withMetric !== false && !next.metrics.some((x) => x.key === planned.metric?.key)) {
    next.metrics.push(planned.metric)
    created.push(planned.metric.key)
  }
  return { content: next, created }
}
