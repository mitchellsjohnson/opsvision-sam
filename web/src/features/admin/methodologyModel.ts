import type { ErrorDetail } from '../../api/errors'
import type { Methodology, Metric, MethodologyVersion, VersionChange } from '../../api/queries'
import type { components } from '../../api/schema'
import { formatPeriod, monthsOf, parsePeriod, periodLabel } from '../../lib/period'

type Schemas = components['schemas']
export type Band = Schemas['Band']
export type ScaleStep = Schemas['ScaleStep']
export type Category = Schemas['Category']
export type Measure = Schemas['Measure']
export type DeriveRule = Schemas['DeriveRule']
export type StatusRule = Schemas['StatusRule']
export type RuleType = Schemas['RuleType']

// ---- Option lists -----------------------------------------------------------

export const AGG_OPTIONS = [
  { value: 'sum', label: 'Sum' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'latest', label: 'Latest' },
  { value: 'average', label: 'Average' },
  { value: 'none', label: 'None' },
] as const

export const DIRECTION_OPTIONS = [
  { value: 'higher_better', label: 'Higher is better' },
  { value: 'lower_better', label: 'Lower is better' },
] as const

export const FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'biannual', label: 'Twice a year' },
  { value: 'annual', label: 'Yearly' },
] as const

export const FORMAT_OPTIONS = [
  { value: 'percent0', label: 'Percent, no decimals (12%)' },
  { value: 'percent1', label: 'Percent, 1 decimal (12.3%)' },
  { value: 'percent2', label: 'Percent, 2 decimals (12.34%)' },
  { value: 'number0', label: 'Number, no decimals' },
  { value: 'number1', label: 'Number, 1 decimal' },
  { value: 'number2', label: 'Number, 2 decimals' },
  { value: 'money_k', label: 'Money in thousands' },
  { value: 'days0', label: 'Days' },
] as const

export const RULE_OPTIONS = [
  { value: 'bands', label: 'Bands: value ranges map to a status' },
  { value: 'change', label: 'Change: movement against a comparison point' },
  { value: 'scale', label: 'Scale: steps from a minimum value' },
] as const

export const COMPARE_OPTIONS = [
  { value: 'prior_period', label: 'Prior period' },
  { value: 'prior_year_average', label: 'Prior year average' },
  { value: 'baseline', label: 'Baseline' },
] as const

export const OP_OPTIONS = [
  { value: '>=', label: '≥ (at least)' },
  { value: '>', label: '> (more than)' },
  { value: '<=', label: '≤ (at most)' },
  { value: '<', label: '< (less than)' },
] as const

export function labelOf(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  superseded: 'Superseded',
}

/** Text for a version status; the chip shows this text, never color alone. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** "Effective Oct 2026", or "Not published" for a version with no effective period. */
export function effectiveLabel(effectiveFrom: string, fiscalYearStartMonth: number): string {
  const p = parsePeriod(effectiveFrom)
  return p ? `Effective ${periodLabel(p, fiscalYearStartMonth)}` : 'Not published'
}

// ---- Editor state -----------------------------------------------------------

/** A metric in the editor, with the editor-only state around it. */
export interface MetricRow {
  /** Stable across edits (including key edits), unlike the key or the index. */
  uid: string
  /** Added in this session and not yet saved; only then may the key change. */
  isNew: boolean
  metric: Metric
  /** The Advanced (JSON) text while it differs from the metric, with the parse error if any. */
  advancedText?: string
  advancedError?: string
}

export interface DraftState {
  name: string
  categories: Category[]
  measures: Measure[]
  metrics: MetricRow[]
}

let uidCounter = 0
export function nextUid(): string {
  uidCounter += 1
  return `m${uidCounter}`
}

export function draftFrom(version: Pick<MethodologyVersion, 'name' | 'content'>): DraftState {
  const content = structuredClone(version.content)
  return {
    name: version.name,
    categories: content.categories,
    measures: content.measures,
    metrics: content.metrics.map((metric) => ({ uid: nextUid(), isNew: false, metric })),
  }
}

export function contentOf(draft: DraftState): Methodology {
  return {
    categories: draft.categories,
    measures: draft.measures,
    metrics: draft.metrics.map((r) => r.metric),
  }
}

/** A string that changes exactly when the saveable content does. */
export function fingerprint(draft: DraftState): string {
  return JSON.stringify({ name: draft.name, content: contentOf(draft) })
}

/** After a save, every metric is stored: its key is fixed from now on. */
export function markSaved(draft: DraftState): DraftState {
  return { ...draft, metrics: draft.metrics.map((r) => (r.isNew ? { ...r, isNew: false } : r)) }
}

export function newMetric(categoryId: string, statusKeys: readonly string[]): Metric {
  return {
    key: '',
    name: '',
    categoryId,
    formula: '',
    format: 'number1',
    direction: 'higher_better',
    frequency: 'monthly',
    reportedAt: [],
    rollItemsToOrg: false,
    rule: { type: 'bands', bands: defaultBands(statusKeys) },
    targets: [],
    definition: '',
    notes: '',
    example: '',
    source: '',
    link: '',
  }
}

function defaultBands(statusKeys: readonly string[]): Band[] {
  const best = statusKeys[0] ?? ''
  const worst = statusKeys[statusKeys.length - 1] ?? ''
  return [
    { status: best, op: '>=', value: 0 },
    { status: worst, op: '', value: 0 },
  ]
}

// ---- Rules ------------------------------------------------------------------

/** The bands that have a condition, in order (everything but the else band). */
export function conditionBands(bands: readonly Band[] | undefined): Band[] {
  return (bands ?? []).filter((b) => b.op !== '')
}

/** The else band's status, or '' when the rule has none yet. */
export function elseStatus(bands: readonly Band[] | undefined): string {
  return (bands ?? []).find((b) => b.op === '')?.status ?? ''
}

/** Builds the stored bands: the condition rows in order, then the else band last. */
export function buildBands(rows: readonly Band[], otherwise: string): Band[] {
  return [...rows.map((b) => ({ status: b.status, op: b.op, value: b.value })), { status: otherwise, op: '', value: 0 }]
}

/** Switches rule type, keeping what still applies (per-subject bands, and bands between bands and change). */
export function withRuleType(rule: StatusRule, type: RuleType, statusKeys: readonly string[]): StatusRule {
  if (rule.type === type) return rule
  const next: StatusRule = { type }
  if (rule.perSubject !== undefined) next.perSubject = rule.perSubject
  if (type === 'scale') {
    next.scale = rule.scale ?? [{ status: statusKeys[0] ?? '', min: 0 }]
    return next
  }
  next.bands = rule.bands && rule.bands.length > 0 ? rule.bands : defaultBands(statusKeys)
  if (type === 'change') next.compare = rule.compare ?? 'prior_period'
  return next
}

/** A one-line description of a rule for read-only views. */
export function ruleSummary(rule: StatusRule): string {
  const bandText = (bands: readonly Band[] | undefined) =>
    (bands ?? [])
      .map((b) => (b.op === '' ? `else ${b.status}` : `${b.op} ${b.value} ${b.status}`))
      .join(', ')
  switch (rule.type) {
    case 'bands':
      return `Bands: ${bandText(rule.bands)}`
    case 'change':
      return `Change vs ${labelOf(COMPARE_OPTIONS, rule.compare ?? '').toLowerCase()}: ${bandText(rule.bands)}`
    case 'scale':
      return `Scale: ${(rule.scale ?? []).map((s) => `${s.status} from ${s.min}`).join(', ')}`
  }
}

// ---- Advanced (JSON) ----------------------------------------------------------

export interface Advanced {
  targets: Metric['targets']
  perSubject: NonNullable<StatusRule['perSubject']>
}

export function advancedText(metric: Metric): string {
  const a: Advanced = { targets: metric.targets, perSubject: metric.rule.perSubject ?? [] }
  return JSON.stringify(a, null, 2)
}

export type AdvancedResult = { ok: true; value: Advanced } | { ok: false; error: string }

/** Parses the Advanced (JSON) text: an object with a `targets` list and a `perSubject` list. */
export function parseAdvanced(text: string): AdvancedResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : 'could not be parsed'}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Expected an object with "targets" and "perSubject" lists.' }
  }
  const obj = raw as Record<string, unknown>
  const extra = Object.keys(obj).filter((k) => k !== 'targets' && k !== 'perSubject')
  if (extra.length > 0) return { ok: false, error: `Unknown field "${extra[0]}". Use "targets" and "perSubject".` }
  const list = (name: string): unknown[] | string => {
    const v = obj[name] ?? []
    if (!Array.isArray(v)) return `"${name}" must be a list.`
    if (!v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) {
      return `Every entry in "${name}" must be an object.`
    }
    return v
  }
  const targets = list('targets')
  if (typeof targets === 'string') return { ok: false, error: targets }
  const perSubject = list('perSubject')
  if (typeof perSubject === 'string') return { ok: false, error: perSubject }
  return {
    ok: true,
    value: { targets: targets as Advanced['targets'], perSubject: perSubject as Advanced['perSubject'] },
  }
}

/** Applies parsed advanced values to a metric. */
export function withAdvanced(metric: Metric, a: Advanced): Metric {
  const rule: StatusRule = { ...metric.rule }
  if (a.perSubject.length > 0) rule.perSubject = a.perSubject
  else delete rule.perSubject
  return { ...metric, targets: a.targets, rule }
}

// ---- Validation errors -------------------------------------------------------

/**
 * The errors at or below a path prefix, such as `metrics[2]`, with the part of
 * each path below the prefix (`.rule.bands[1].status`, or '' for the prefix itself).
 */
export function underPath(errors: readonly ErrorDetail[], prefix: string): { rest: string; message: string }[] {
  const out: { rest: string; message: string }[] = []
  for (const e of errors) {
    if (e.path === prefix) out.push({ rest: '', message: e.message })
    else if (e.path.startsWith(`${prefix}.`) || e.path.startsWith(`${prefix}[`)) {
      out.push({ rest: e.path.slice(prefix.length), message: e.message })
    }
  }
  return out
}

/** Messages for exactly one field path. */
export function atPath(errors: readonly ErrorDetail[], path: string): string[] {
  return errors.filter((e) => e.path === path).map((e) => e.message)
}

/** Messages at or below a path, each prefixed with where below the path it applies. */
export function describeUnder(errors: readonly ErrorDetail[], prefix: string): string[] {
  return underPath(errors, prefix).map((e) => {
    const where = e.rest.replace(/^\./, '')
    return where === '' ? e.message : `${where}: ${e.message}`
  })
}

/** The metric index in a `metrics[i]...` path, or undefined for other paths. */
export function metricIndex(path: string): number | undefined {
  const m = /^metrics\[(\d+)\]/.exec(path)
  return m ? Number(m[1]) : undefined
}

// ---- Diff -------------------------------------------------------------------

export interface MetricDiff {
  key: string
  fields: { field: string; before: unknown; after: unknown }[]
}

export interface GroupedDiff {
  added: { key: string; metric: unknown }[]
  removed: { key: string; metric: unknown }[]
  changed: MetricDiff[]
}

/** `metrics[key]` or `metrics[key].field` => the key and the field (if any). */
export function parseDiffPath(path: string): { key: string; field: string } | undefined {
  const m = /^metrics\[([^\]]+)\](?:\.(.+))?$/.exec(path)
  return m ? { key: m[1] ?? '', field: m[2] ?? '' } : undefined
}

/** Groups the API's path-addressed changes into added, removed and changed metrics. */
export function groupDiff(changes: readonly VersionChange[]): GroupedDiff {
  const out: GroupedDiff = { added: [], removed: [], changed: [] }
  for (const c of changes) {
    const p = parseDiffPath(c.path)
    if (!p) continue
    if (c.kind === 'added' && p.field === '') out.added.push({ key: p.key, metric: c.after })
    else if (c.kind === 'removed' && p.field === '') out.removed.push({ key: p.key, metric: c.before })
    else if (c.kind === 'changed') {
      let m = out.changed.find((x) => x.key === p.key)
      if (!m) {
        m = { key: p.key, fields: [] }
        out.changed.push(m)
      }
      m.fields.push({ field: p.field, before: c.before, after: c.after })
    }
  }
  return out
}

/** Scalars as text; structured values (rules, targets) pretty-printed as JSON. */
export function prettyValue(v: unknown): { text: string; structured: boolean } {
  if (v === undefined || v === null) return { text: '(none)', structured: false }
  if (typeof v === 'string') return { text: v === '' ? '(empty)' : v, structured: false }
  if (typeof v === 'object') return { text: JSON.stringify(v, null, 2), structured: true }
  return { text: String(v), structured: false }
}

// ---- Versions ---------------------------------------------------------------

/** The first month of a period string, e.g. `2026-M01` for `2026-FY`; '' if it is not a period. */
function firstMonth(period: string): string {
  const p = parsePeriod(period)
  const first = p ? monthsOf(p)[0] : undefined
  return first ? formatPeriod(first) : ''
}

/**
 * The version the API compares against by default: the published or
 * superseded version with the latest effective month.
 */
export function versionInForce(versions: readonly MethodologyVersion[]): MethodologyVersion | undefined {
  return versions
    .filter((v) => (v.status === 'published' || v.status === 'superseded') && firstMonth(v.effectiveFrom) !== '')
    .sort((a, b) => firstMonth(b.effectiveFrom).localeCompare(firstMonth(a.effectiveFrom)))[0]
}
