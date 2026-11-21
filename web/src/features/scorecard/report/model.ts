import type { components } from '../../../api/schema'
import { currentMonth, monthLabel, parsePeriod, periodLabel } from '../../../lib/period'
import { groupedOverrideLabel, shortLabel, type Column } from '../columns'
import { changeText, formatMetricValue } from '../format'
import { isSparse, pointKind, type PointKind } from '../charts/sparse'
import { applyLayout, defaultLayout, type LayoutItem } from '../logic/layout'
import { needsAttention } from '../logic/needsAttention'
import { absentItemMetrics, attentionInputs, healthTally, metricNoun, metricStandings } from '../logic/standings'
import { cellReported, statusAtScope, type StatusScaleEntry } from '../logic/statusAtScope'
import { worstChildValue } from '../logic/statusBoard'
import { cellKey, groupRows, metricScope } from '../viewHelpers'
import { requiredFor } from '../../rca/rcaState'
import { noteDate } from '../../rca/rcaText'

type Schemas = components['schemas']
type ReportDocument = Schemas['ReportDocument']
type ScorecardView = Schemas['ScorecardView']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type StatusLevel = Schemas['StatusLevel']
type MethodologyVersion = Schemas['MethodologyVersion']
type MetricSummary = Schemas['MetricSummary']
type RcaLink = Schemas['RcaLink']
type RcaEvidenceKey = Schemas['RcaEvidenceKey']

/** The month's exec summaries, read with `listMetricSummaries` (the report document carries none). */
export interface ReportSummaries {
  /**
   * `live`: the month's summaries now; `published`: a revision's frozen
   * copies; `before`: a revision published before exec summaries were
   * required (v1 and v2), which has none.
   */
  source: 'live' | 'published' | 'before'
  items: MetricSummary[]
  /** A published revision's live summaries now: a newer revision is `Exec summary edited since publication`. */
  current?: MetricSummary[]
}

/** A metric's exec summary as the report shows it. A missing one carries no text, author or links. */
export interface ReportMetricSummary {
  state: 'missing' | 'written' | 'stale' | 'optional'
  text?: string
  author?: string
  /** `Nov 2`: when it was last written. */
  date?: string
  links: RcaLink[]
  linksTotal: number
  /** Why it is required (`Red`, `Below 100% (94%)`). */
  reason?: string
  /** The company-level evidence keys behind the attribution line. */
  evidence: RcaEvidenceKey[]
  /** `{standing headline}: {key} {points} · …`, shown and exported as attribution, never as the summary. */
  attributionLine?: string
  editedSincePublication: boolean
  /** An unwritten coarse period another month required (`Jun 2026`): `requiredFor`. Screens say so; downloads do not. */
  neededFor?: string
}

/** One line of Notes → Exec summaries and one row of the downloads' appendix. */
export interface ExecSummaryNote {
  key: string
  name: string
  display: string
  status: string
  statusLabel: string
  /** Null when the summary is missing. */
  text: string | null
  links: RcaLink[]
  /** Evidence keys, for `(INC-2041, INC-2047)`. */
  keys: string[]
}

export interface ReportModelInput {
  doc: ReportDocument
  scorecardName: string
  companyName: string
  /** The selected org unit; '' for the whole company. */
  scope: string
  scopeName: string
  /** The scope's units and their tracked items; unused at the company scope. */
  scopeSubjects: string[]
  /** The report month, `2026-M10`. */
  period: string
  fiscalYearStartMonth: number
  scale: StatusLevel[]
  /** The user's saved Overview layout ("Use my layout"); null for the standard order. */
  layout: LayoutItem[] | null
  /** Published, month to date, or live: see `reportStatusLine`. */
  statusLine: string
  /**
   * The Overview's view of the same month and scope (its trend window and
   * coarse periods), so the report counts, labels and ranks each metric as
   * the Overview does; null or absent to count from the report's own months.
   */
  overview?: ScorecardView | null
  /** The scorecard's methodology versions: rules, item kinds and item-only metrics with no rows. */
  versions?: MethodologyVersion[]
  /** The month's exec summaries; absent or null while they are not loaded. */
  summaries?: ReportSummaries | null
}

export interface ReportPoint {
  label: string
  fullLabel: string
  /** Null when missing or not applicable. */
  value: number | null
  display: string
  status: string
  naReason: string
  kind: PointKind
  /** The month's own target, when its methodology sets one. */
  target: number | null
}

export interface ReportSeries {
  subject: string
  points: ReportPoint[]
}

export interface ReportMetric {
  key: string
  name: string
  categoryName: string
  chartKind: string
  format: string
  direction: Schemas['Direction']
  /** The view row's definition, or the metric name when it has none. */
  definition: string
  /** The methodology version the month's value was computed under. */
  versionId: string
  /** The month's value at the scope; '' when there is none. */
  display: string
  status: string
  statusLabel: string
  /** `worst of 2 segments` when the status comes from children. */
  caption: string
  /** With no value at the scope, the worst reported child or item, which the value leads with (as the board's Current column). */
  worst: { name: string; display: string } | null
  change: string | null
  ytd: string | null
  /** The month's target, as text. */
  goal: string | null
  /** Mostly not applicable, by the app's rule (`isSparse`): exports show a table, not a chart. */
  sparse: boolean
  /** The worst off-track child unit or item, if any. */
  driver: string | null
  /** The scope row's six months, or its reported children when it has no value. */
  series: ReportSeries[]
  /** The company's exec summary for the month; absent away from the company scope or without summaries. */
  summary?: ReportMetricSummary
}

export interface ReportTableCell {
  display: string
  status: string
  naReason: string
}

export interface ReportTableRow {
  key: string
  name: string
  categoryName: string
  cells: ReportTableCell[]
}

export interface ReportModel {
  /** `<scorecard> · <month>`: the PDF title and the deck title. */
  title: string
  scorecardName: string
  monthLabel: string
  period: string
  /** `All of <company>` or the unit's name. */
  scopeLabel: string
  companyName: string
  statusLine: string
  generatedLabel: string
  /** The tenant scale's `#rrggbb` color for each status key. */
  statusColors: Record<string, string>
  companyScope: boolean
  /** Null away from the company scope: the summary belongs to the company report. */
  summary: string | null
  /** `Summary is written for <company>` away from the company scope; else null. */
  summaryFor: string | null
  health: { key: string; label: string; count: number }[]
  notReported: number
  /**
   * Metrics reported less often than monthly in a revision published before
   * it stored what the Overview counts (no `standing`): neither in Health nor
   * Not reported. Empty otherwise.
   */
  notCounted: { names: string[] }
  facts: string[]
  needsAttention: ReportMetric[]
  /** Every metric shown, needs attention included, by category. */
  categories: { id: string; name: string; metrics: ReportMetric[] }[]
  /** The month, the five before it, and year to date. */
  columns: Column[]
  table: ReportTableRow[]
  notes: {
    overrides: string[]
    naReasons: string[]
    notReported: string[]
    versionIds: string[]
  }
  /** A live month's required exec summaries that are not written: publishing waits for them. */
  summariesMissing: MetricSummary[]
  /** A live month's stale summaries, which do not block. */
  summariesStale: number
  summariesStaleNames: string[]
  /** A revision published before exec summaries were required. */
  summariesBefore: boolean
  /** Every summary of the month (missing ones too, when live), worst first. */
  execSummaries: ExecSummaryNote[]
}

/** Table slides and pages split after this many metric rows. */
export const TABLE_ROWS_PER_PAGE = 12

/**
 * How an export draws a metric: a line or bar chart where the kind is one,
 * else (uptime, discrete, sparse, or nothing to plot) a table of period,
 * value, and status letter.
 */
export function exportChart(metric: ReportMetric): 'line' | 'bar' | 'table' {
  if (metric.sparse) return 'table'
  const plotted = metric.series.some((s) => s.points.some((p) => p.value !== null))
  if (!plotted) return 'table'
  if (metric.chartKind === 'money_plan') return 'bar'
  if (metric.chartKind === 'uptime' || metric.chartKind === 'discrete') return 'table'
  return 'line'
}

/**
 * The goal to plot beside a single-line chart: each month's own target (null
 * where it has none), when two adjacent months carry one, so there is a
 * segment to draw. Otherwise null and the goal is only stated as text; bar
 * charts never plot it.
 */
export function goalSeries(metric: ReportMetric): (number | null)[] | null {
  if (exportChart(metric) !== 'line' || metric.series.length !== 1) return null
  const targets = metric.series[0]!.points.map((p) => p.target)
  return targets.some((t, i) => i > 0 && t !== null && targets[i - 1] !== null) ? targets : null
}

/** A point's value for a table: its display, `n/a`, or a dash when missing. */
export function pointText(p: { display: string; naReason: string }): string {
  if (p.naReason) return 'n/a'
  return p.display || '—'
}

/**
 * The status table of a metric: one row per month. One series gives
 * Period, Value, Status; several give Period and one `value letter` column
 * per subject (at most six).
 */
export function statusTable(metric: ReportMetric): { header: string[]; rows: { cells: string[]; status: string }[] } {
  const series = metric.series.slice(0, 6)
  if (series.length === 1) {
    return {
      header: ['Period', 'Value', 'Status'],
      rows: series[0]!.points.map((p) => ({ cells: [p.fullLabel, pointText(p), p.status], status: p.status })),
    }
  }
  const points = series[0]?.points ?? []
  return {
    header: ['Period', ...series.map((s) => s.subject)],
    rows: points.map((p, i) => ({
      cells: [p.fullLabel, ...series.map((s) => [pointText(s.points[i]!), s.points[i]!.status].filter(Boolean).join(' '))],
      status: '',
    })),
  }
}

/** Health as the Overview words it: `5 Red`, `4 Yellow`, ..., `2 Not reported`. */
export function healthParts(model: Pick<ReportModel, 'health' | 'notReported'>): string[] {
  return [
    ...model.health.map((h) => `${h.count} ${h.label}`),
    ...(model.notReported > 0 ? [`${model.notReported} Not reported`] : []),
  ]
}

/** The value a metric answers with: the scope's, else the worst child's; '' when neither has one. */
export function metricValue(metric: Pick<ReportMetric, 'display' | 'worst'>): string {
  return metric.display || metric.worst?.display || ''
}

/** The facts under a metric's value: status caption (led by the worst child's name), change, YTD, goal, and driver. */
export function metricFacts(metric: ReportMetric): string[] {
  return [
    [metric.worst?.name ?? '', metric.caption].filter(Boolean).join(' · '),
    metric.change ?? '',
    metric.ytd ? `Year to date ${metric.ytd}` : '',
    metric.goal ? `Goal ${metric.goal}` : '',
    metric.driver ? `Driver: ${metric.driver}` : '',
  ].filter(Boolean)
}

/** A metric's speaker notes: its definition (or name), then the methodology version. */
export function metricNotes(metric: ReportMetric): string {
  return `${metric.definition}\nMethodology version: ${metric.versionId || 'none'}`
}

/**
 * A summary's attribution line: the company standing's headline, then its
 * top evidence keys with their points (`INC-2041 0.56 pts · INC-2047 0.25 pts`).
 */
export function summaryAttributionLine(s: Pick<MetricSummary, 'standing' | 'evidence'>): string {
  const keys = (s.evidence ?? []).map((e) => (e.pointsDisplay ? `${e.key} ${e.pointsDisplay}` : e.key)).join(' · ')
  const headline = s.standing.headline
  if (!headline) return keys
  return keys ? `${headline}: ${keys}` : headline
}

/** Links an export shows before pointing at the appendix. */
export const SUMMARY_LINKS_SHOWN = 3
/** What a download prints for a required summary not written; nothing else fills its place. */
export const SUMMARY_NOT_WRITTEN = 'Exec summary not written yet'

/** An appendix row's value in the tenant's words: `84.3% Yellow`. */
export function appendixValue(n: ExecSummaryNote): string {
  return [n.display, n.statusLabel || n.status].filter(Boolean).join(' ')
}

/** Whether a metric's slide or page shows an exec summary block: written, stale or missing (optional ones show nothing). */
export function showsSummary(metric: ReportMetric): boolean {
  return metric.summary !== undefined && metric.summary.state !== 'optional'
}

function metricSummaryOf(s: MetricSummary, published: boolean, current: MetricSummary | undefined, neededFor?: string): ReportMetricSummary {
  const state = published ? 'written' : s.state
  const base = {
    reason: s.requirementReason,
    evidence: s.evidence ?? [],
    attributionLine: summaryAttributionLine(s) || undefined,
    editedSincePublication: false,
  }
  // Nothing stands in for a summary that is not written: no text, author or links.
  if (state === 'missing' || state === 'optional' || !s.text) {
    const unwritten = { state: state === 'missing' ? ('missing' as const) : ('optional' as const), links: [], linksTotal: 0, ...base }
    return neededFor && unwritten.state === 'optional' ? { ...unwritten, neededFor } : unwritten
  }
  return {
    state,
    text: s.text,
    author: s.authorName,
    date: s.updatedAt ? noteDate(s.updatedAt) : undefined,
    links: s.links,
    linksTotal: s.linksTotal,
    ...base,
    editedSincePublication: published && current?.revision !== undefined && s.revision !== undefined && current.revision > s.revision,
  }
}

/** The notes section's headings and lines, empty sections left out. */
export function noteSections(model: ReportModel): { heading: string; lines: string[] }[] {
  return [
    { heading: 'Overrides', lines: model.notes.overrides },
    { heading: 'Not applicable', lines: model.notes.naReasons },
    { heading: 'Not reported', lines: model.notes.notReported },
    { heading: 'Methodology versions', lines: model.notes.versionIds.length > 0 ? model.notes.versionIds : ['None'] },
  ].filter((s) => s.lines.length > 0)
}

/** The table's rows in slide- and page-sized chunks. */
export function tableChunks(model: ReportModel): ReportTableRow[][] {
  const out: ReportTableRow[][] = []
  for (let i = 0; i < model.table.length; i += TABLE_ROWS_PER_PAGE) out.push(model.table.slice(i, i + TABLE_ROWS_PER_PAGE))
  return out.length > 0 ? out : [[]]
}

/** A table cell's text: the value and the status letter. */
export function tableCellText(c: ReportTableCell): string {
  const value = c.naReason ? 'n/a' : c.display || '—'
  return c.status ? `${value} ${c.status}` : value
}

/** `Main scorecard 2026-M10.pdf`: the file name, without characters file systems reject. */
export function reportFileName(model: ReportModel, extension: 'pptx' | 'pdf'): string {
  return `${model.scorecardName.replace(/[\\/:*?"<>|]+/g, '-')} ${model.period}.${extension}`
}

/** `Nov 3, 2026` for a timestamp, in UTC like the API's dates. */
export function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function localDateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The report's header line: `Published on <date> by <name>` for a snapshot
 * (no name when it is not known), `Month to date, as of <today>` for the open
 * month, else `Live data as of <today>`.
 */
export function reportStatusLine(o: {
  live: boolean
  period: string
  today: Date
  fiscalYearStartMonth: number
  publishedAt?: string | null
  publisherName?: string
}): string {
  if (!o.live) {
    const on = o.publishedAt ? ` on ${dateLabel(o.publishedAt)}` : ''
    return `Published${on}${o.publisherName ? ` by ${o.publisherName}` : ''}`
  }
  const today = localDateLabel(o.today)
  return o.period === currentMonth(o.fiscalYearStartMonth, o.today)
    ? `Month to date, as of ${today}`
    : `Live data as of ${today}`
}

function reportColumns(view: ScorecardView, fy: number): Column[] {
  const out: Column[] = view.periods.map((p) => {
    const parsed = parsePeriod(p)
    return {
      key: p,
      label: parsed ? shortLabel(parsed, fy) : p,
      fullLabel: parsed ? periodLabel(parsed, fy) : p,
      period: p,
      ytd: false,
    }
  })
  for (const p of view.ytd) {
    const parsed = parsePeriod(p)
    out.push({
      key: `YTD:${p}`,
      label: 'YTD',
      fullLabel: `Year to date through ${parsed ? monthLabel(parsed, fy) : p}`,
      period: p,
      ytd: true,
    })
  }
  return out
}

function cellAt(row: ViewRow | null, key: string): Cell | undefined {
  return row?.cells.find((c) => cellKey(c) === key)
}

/** How the facts (the API's and `scopeFacts`) start the not-reported sentence. */
const NOT_REPORTED_FACT = 'not reported: '

/** A coarse metric's value in a revision that did not save its periods. */
export const NOT_IN_REVISION = 'Not in this revision'

/**
 * The API's fact sentences for one scope's rows (one per metric): metrics that
 * turned to the worst status this month, a first best status after a run of
 * others, and metrics not reported.
 */
export function scopeFacts(rows: ViewRow[], period: string, scale: StatusScaleEntry[]): string[] {
  const rank = new Map(scale.map((s) => [s.key, s.rank]))
  const worst = Math.max(...scale.map((s) => s.rank))
  const best = Math.min(...scale.map((s) => s.rank))
  const turned: string[] = []
  const firstGreen: string[] = []
  const notReported: string[] = []
  for (const row of [...rows].sort((a, b) => (a.metricKey < b.metricKey ? -1 : a.metricKey > b.metricKey ? 1 : 0))) {
    const months = [...new Set(row.cells.filter((c) => !c.ytd).map((c) => c.period))].sort()
    const at = (p: string) => row.cells.find((c) => !c.ytd && c.period === p)
    const idx = months.indexOf(period)
    const cur = at(period)
    if (!cur || idx < 0) continue
    const prior = idx > 0 ? at(months[idx - 1]!) : undefined
    if (prior && cellReported(cur) && cellReported(prior) && cur.status && prior.status) {
      if (rank.get(cur.status) === worst && rank.get(prior.status) !== worst) turned.push(row.metricName)
    }
    if (cellReported(cur) && cur.status && rank.get(cur.status) === best) {
      let k = 1
      for (let i = idx - 1; i >= 0; i--) {
        const c = at(months[i]!)
        if (!c || !cellReported(c) || !c.status || rank.get(c.status) === best) break
        k++
      }
      if (k >= 2) firstGreen.push(`first green in ${k} months: ${row.metricName}`)
    }
    if (!cellReported(cur)) notReported.push(row.metricName)
  }
  const out: string[] = []
  if (turned.length > 0) out.push(`${turned.length} metric${turned.length === 1 ? '' : 's'} turned red: ${turned.join(', ')}`)
  out.push(...firstGreen)
  if (notReported.length > 0) out.push(`${NOT_REPORTED_FACT}${notReported.join(', ')}`)
  return out
}

interface MetricRows {
  key: string
  categoryId: string
  categoryName: string
  rows: ViewRow[]
}

/** The categories and metrics in the saved layout's order, without hidden ones. */
function orderByLayout(
  groups: { id: string; name: string; metrics: MetricRows[] }[],
  layout: LayoutItem[],
): { id: string; name: string; metrics: MetricRows[] }[] {
  const metricsByCategory = Object.fromEntries(groups.map((g) => [g.id, g.metrics.map((m) => ({ key: m.key }))]))
  const merged = applyLayout(defaultLayout(groups, metricsByCategory), layout)
  const position = new Map(merged.map((item, i) => [item.id, i]))
  const hidden = new Set(merged.filter((i) => i.hidden).map((i) => i.id))
  const at = (id: string) => position.get(id) ?? Number.MAX_SAFE_INTEGER
  return groups
    .filter((g) => !hidden.has(`section:${g.id}`))
    .map((g) => ({
      ...g,
      metrics: g.metrics
        .filter((m) => !hidden.has(`metric:${m.key}`))
        .sort((a, b) => at(`metric:${a.key}`) - at(`metric:${b.key}`)),
    }))
    .filter((g) => g.metrics.length > 0)
    .sort((a, b) => at(`section:${a.id}`) - at(`section:${b.id}`))
}

/**
 * Everything the report shows, at the selected scope, in document order. The
 * page, the PPTX and the PDF are all drawn from it so they agree.
 */
export function buildReportModel(input: ReportModelInput): ReportModel {
  const { doc, period, scale } = input
  const fy = input.fiscalYearStartMonth
  const companyScope = input.scope === ''
  const inScope = new Set(input.scopeSubjects)
  const view: ScorecardView = companyScope
    ? doc.view
    : { ...doc.view, rows: doc.view.rows.filter((r) => inScope.has(r.subjectId)) }
  const columns = reportColumns(view, fy)
  const monthColumns = columns.filter((c) => !c.ytd)
  const scaleEntries: StatusScaleEntry[] = scale.map((s) => ({ key: s.key, rank: s.rank }))
  const worstRank = Math.max(...scaleEntries.map((s) => s.rank))
  const rankOf = (status: string) => scaleEntries.find((s) => s.key === status)?.rank ?? 0
  const statusLabel = (status: string) => scale.find((s) => s.key === status)?.label ?? status
  const parsed = parsePeriod(period)
  const month = parsed ? monthLabel(parsed, fy) : period

  let groups = groupRows(view).map((g) => ({
    id: g.id,
    name: g.name,
    metrics: g.metrics.map((m) => ({ key: m.key, categoryId: g.id, categoryName: g.name, rows: m.rows })),
  }))
  if (input.layout && input.layout.length > 0) groups = orderByLayout(groups, input.layout)

  // Counted as the Overview counts: the period's status (a coarse metric at its own grain), streaks and ranking.
  // A published revision counts from what it stored; a live one from the Overview's view.
  const counted = doc.standing ?? input.overview
  const standingView = counted
    ? companyScope
      ? counted
      : { ...counted, rows: counted.rows.filter((r) => inScope.has(r.subjectId)) }
    : view
  const standings = metricStandings({ view: standingView, period, fy, scale: scaleEntries, versions: input.versions })
  const standingOf = new Map(standings.metrics.map((s) => [s.key, s]))
  // An older revision holds only the report's months, so a coarse metric has no period to count.
  const withoutStanding = !doc.live && !doc.standing

  const metrics = groups.flatMap((g) => g.metrics).map((m) => {
    const { scope, children, head } = metricScope(m.rows)
    const noun = metricNoun(head.chartKind, scope, children)
    const atScope = (key: string) => statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey: key, scale: scaleEntries, noun })
    const notCounted = withoutStanding && head.frequency !== 'monthly'
    const standing = notCounted ? undefined : standingOf.get(m.key)
    return { ...m, scope, children, head, noun, atScope, notCounted, standing, status: standing?.status?.status ?? '' }
  })

  const reportMetric = (m: (typeof metrics)[number]): ReportMetric => {
    const { scope, children, head, standing } = m
    // A coarse metric's value is its counted quarter, half or year, which the report's months do not hold.
    const cell = standing && standing.coarse.length > 0 ? standing.cell : cellAt(scope, period)
    const reportedChildren = children.filter((ch) => cellReported(cellAt(ch, period)))
    const seriesRows = scope && (cellReported(cell) || reportedChildren.length === 0) ? [scope] : reportedChildren.length > 0 ? reportedChildren : children
    const driver = children
      .map((ch) => {
        const c = cellAt(ch, period)
        return cellReported(c) && c?.status ? { name: ch.subjectName, rank: rankOf(c.status) } : null
      })
      .filter((d): d is { name: string; rank: number } => d !== null)
      .sort((a, b) => b.rank - a.rank)[0]
    const ytdCell = scope?.cells.find((c) => c.ytd && c.display !== '')
    const display = m.notCounted ? NOT_IN_REVISION : cell && cell.naReason === '' ? cell.display : ''
    const worst =
      m.status && !display && standing?.status && !cellReported(standing.cell)
        ? (worstChildValue(standing.children, standing.status.counted.key, scaleEntries, head.direction) ?? null)
        : null
    return {
      key: m.key,
      name: head.metricName,
      categoryName: m.categoryName,
      chartKind: head.chartKind,
      format: head.format,
      direction: head.direction,
      definition: m.rows.find((r) => r.definition?.trim())?.definition?.trim() || head.metricName,
      versionId: cell?.versionId || doc.view.versionByPeriod[period] || '',
      display,
      status: m.status,
      statusLabel: m.status ? statusLabel(m.status) : '',
      caption: m.status ? (standing?.status?.caption ?? '') : '',
      worst,
      change: cell
        ? changeText({
            period: cell.period,
            ytd: false,
            format: head.format,
            change: cell.change,
            changeKind: cell.changeKind,
            compare: cell.rule?.type === 'change' ? cell.rule.compare : undefined,
            fyStart: fy,
          })
        : null,
      ytd: ytdCell?.display || null,
      goal: cell?.target != null ? formatMetricValue(head.format, cell.target) : null,
      sparse: isSparse(
        head.chartKind,
        monthColumns.map((col) => pointKind(cellAt(scope, col.key))),
      ),
      // The worst child already names who drives the status.
      driver: !m.notCounted && !worst && driver && driver.rank >= worstRank ? driver.name : null,
      series: seriesRows.map((row) => ({
        subject: row.subjectName,
        points: monthColumns.map((col) => {
          const c = cellAt(row, col.key)
          const na = c?.naReason ?? ''
          return {
            label: col.label,
            fullLabel: col.fullLabel,
            value: c && na === '' ? c.value : null,
            display: c && na === '' ? c.display : '',
            status: na === '' ? (c?.status ?? '') : '',
            naReason: na,
            kind: pointKind(c),
            target: c?.target ?? null,
          }
        }),
      })),
    }
  }

  // Exec summaries are the company's: joined only at the company scope.
  const sums = input.summaries ?? null
  const published = sums?.source === 'published'
  const sumItems = sums && sums.source !== 'before' ? sums.items : []
  const summaryByKey = new Map(sumItems.map((s) => [s.metricKey, s]))
  const currentByKey = new Map((sums?.current ?? []).map((s) => [s.metricKey, s]))
  const withSummary = (rm: ReportMetric): ReportMetric => {
    const s = companyScope ? summaryByKey.get(rm.key) : undefined
    return s ? { ...rm, summary: metricSummaryOf(s, published, currentByKey.get(rm.key), requiredFor(s, input.period, fy)) } : rm
  }
  const live = sums?.source === 'live'
  const staleItems = live ? sumItems.filter((s) => s.state === 'stale') : []
  const execSummaries: ExecSummaryNote[] = sumItems
    .filter((s) => (live && s.state === 'missing') || (s.state !== 'missing' && s.state !== 'optional' && !!s.text))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rankOf(b.s.standing.status) - rankOf(a.s.standing.status) || a.i - b.i)
    .map(({ s }) => ({
      key: s.metricKey,
      name: s.metricName,
      display: s.standing.display,
      status: s.standing.status,
      statusLabel: s.standing.status ? statusLabel(s.standing.status) : '',
      text: s.state === 'missing' ? null : (s.text ?? null),
      links: s.state === 'missing' ? [] : s.links,
      keys: (s.evidence ?? []).map((e) => e.key),
    }))

  const byKey = new Map(metrics.map((m) => [m.key, withSummary(reportMetric(m))]))

  const shown = metrics.flatMap((m) => (m.standing ? [m.standing] : []))
  const attentionItems = attentionInputs(shown, { categories: view.categories, scale: scaleEntries, fy, statusLabel })

  // As the Overview's Health: every metric once, in the tenant's labels, worst first.
  const absent = absentItemMetrics(standingView, input.versions, standings.selected, standings.metrics)
  const health = [...healthTally(metrics.map((m) => m.status), 0, '')]
    .filter(([key, count]) => key !== '' && count > 0)
    .sort((a, b) => rankOf(b[0]) - rankOf(a[0]))
    .map(([key, count]) => ({ key, label: statusLabel(key), count }))
  const unreported = [
    ...metrics.filter((m) => !m.status && !m.notCounted).map((m) => m.head.metricName),
    ...absent.map((m) => m.name),
  ]

  const overrideGroups = new Map<string, string[]>()
  const naGroups = new Map<string, Map<string, string[]>>()
  for (const m of metrics) {
    for (const row of m.rows) {
      for (const col of monthColumns) {
        const c = cellAt(row, col.key)
        if (!c?.override) continue
        const reason = c.override.reason || 'Overridden'
        const list = overrideGroups.get(reason) ?? []
        list.push(`${row.metricName}, ${row.subjectName}, ${col.fullLabel}`)
        overrideGroups.set(reason, list)
      }
    }
    if (!m.scope) continue
    for (const col of monthColumns) {
      const c = cellAt(m.scope, col.key)
      if (!c?.naReason) continue
      const byMetric = naGroups.get(c.naReason) ?? new Map<string, string[]>()
      const months = byMetric.get(m.head.metricName) ?? []
      months.push(col.fullLabel)
      byMetric.set(m.head.metricName, months)
      naGroups.set(c.naReason, byMetric)
    }
  }

  return {
    title: `${input.scorecardName} · ${month}`,
    scorecardName: input.scorecardName,
    monthLabel: month,
    period,
    scopeLabel: companyScope ? `All of ${input.companyName}` : input.scopeName,
    companyName: input.companyName,
    statusLine: input.statusLine,
    generatedLabel: dateLabel(doc.generatedAt),
    statusColors: Object.fromEntries(scale.map((s) => [s.key, s.color])),
    companyScope,
    summary: companyScope ? doc.summary : null,
    summaryFor: companyScope ? null : `Summary is written for ${input.companyName}`,
    health,
    notReported: unreported.length,
    notCounted: { names: metrics.filter((m) => m.notCounted).map((m) => m.head.metricName) },
    // The facts name what is not reported from the months alone; restate that one from the count above.
    facts: (companyScope ? doc.facts : scopeFacts(metrics.flatMap((m) => (m.scope ? [m.scope] : [])), period, scaleEntries)).flatMap(
      (f) => (!f.startsWith(NOT_REPORTED_FACT) ? [f] : unreported.length > 0 ? [`${NOT_REPORTED_FACT}${unreported.join(', ')}`] : []),
    ),
    needsAttention: needsAttention(attentionItems, scaleEntries).shown.map((item) => byKey.get(item.metricKey)!),
    categories: groups.map((g) => ({ id: g.id, name: g.name, metrics: g.metrics.map((m) => byKey.get(m.key)!) })),
    columns,
    table: metrics.map((m) => ({
      key: m.key,
      name: m.head.metricName,
      categoryName: m.categoryName,
      cells: columns.map((col) => {
        const c = cellAt(m.scope, col.key)
        const na = c?.naReason ?? ''
        return { display: c && na === '' ? c.display : '', status: m.atScope(col.key).status, naReason: na }
      }),
    })),
    notes: {
      overrides: [...overrideGroups].map(([reason, cells]) =>
        cells.length > 1 ? groupedOverrideLabel(reason, cells.length) : `${cells[0]}: ${reason}`,
      ),
      naReasons: [...naGroups].map(
        ([reason, byMetric]) =>
          `${reason}: ${[...byMetric].map(([name, months]) => `${name} (${months.join(', ')})`).join('; ')}`,
      ),
      notReported: unreported,
      versionIds: [...new Set(Object.values(doc.view.versionByPeriod).filter(Boolean))].sort(),
    },
    summariesMissing: live ? sumItems.filter((s) => s.state === 'missing') : [],
    summariesStale: staleItems.length,
    summariesStaleNames: staleItems.map((s) => s.metricName),
    summariesBefore: sums?.source === 'before',
    execSummaries,
  }
}
