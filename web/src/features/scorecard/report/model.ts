import type { components } from '../../../api/schema'
import { currentMonth, monthLabel, parsePeriod, periodLabel } from '../../../lib/period'
import { groupedOverrideLabel, shortLabel, type Column } from '../columns'
import { changeText, formatMetricValue } from '../format'
import { applyLayout, defaultLayout, type LayoutItem } from '../logic/layout'
import { needsAttention, type NeedsAttentionItem } from '../logic/needsAttention'
import { cellReported, statusAtScope, type StatusScaleEntry } from '../logic/statusAtScope'
import { cellKey, groupRows, metricScope } from '../viewHelpers'

type Schemas = components['schemas']
type ReportDocument = Schemas['ReportDocument']
type ScorecardView = Schemas['ScorecardView']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type StatusLevel = Schemas['StatusLevel']

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
}

export interface ReportPoint {
  label: string
  fullLabel: string
  /** Null when missing or not applicable. */
  value: number | null
  display: string
  status: string
  naReason: string
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
  change: string | null
  ytd: string | null
  goal: string | null
  goalValue: number | null
  /** The worst off-track child unit or item, if any. */
  driver: string | null
  /** The scope row's six months, or its reported children when it has no value. */
  series: ReportSeries[]
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
}

/** Table slides and pages split after this many metric rows. */
export const TABLE_ROWS_PER_PAGE = 12

/**
 * How an export draws a metric: a line or bar chart where the kind is one,
 * else (uptime, discrete, or nothing to plot) a table of period, value, and
 * status letter.
 */
export function exportChart(metric: ReportMetric): 'line' | 'bar' | 'table' {
  const plotted = metric.series.some((s) => s.points.some((p) => p.value !== null))
  if (!plotted) return 'table'
  if (metric.chartKind === 'money_plan') return 'bar'
  if (metric.chartKind === 'uptime' || metric.chartKind === 'discrete') return 'table'
  return 'line'
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

/** The facts under a metric's value: status caption, change, YTD, goal, and driver. */
export function metricFacts(metric: ReportMetric): string[] {
  return [
    metric.caption,
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

function metricNoun(chartKind: string, scope: ViewRow | null, children: ViewRow[]): 'segments' | 'services' | 'items' {
  if (chartKind === 'uptime') return 'services'
  if (scope && children.length > 0) return 'segments'
  return 'items'
}

function healthLabels(scale: StatusScaleEntry[]): Map<string, string> {
  const sorted = [...scale].sort((a, b) => a.rank - b.rank)
  const labels = new Map<string, string>()
  if (sorted[0]) labels.set(sorted[0].key, 'On track')
  for (const mid of sorted.slice(1, -1)) labels.set(mid.key, 'Watch')
  const worst = sorted[sorted.length - 1]
  if (worst && sorted.length > 1) labels.set(worst.key, 'Off track')
  return labels
}

function cellAt(row: ViewRow | null, key: string): Cell | undefined {
  return row?.cells.find((c) => cellKey(c) === key)
}

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
  if (notReported.length > 0) out.push(`not reported: ${notReported.join(', ')}`)
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
  const priorKey = monthColumns[monthColumns.length - 2]?.key
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

  const metrics = groups.flatMap((g) => g.metrics).map((m) => {
    const { scope, children, head } = metricScope(m.rows)
    const noun = metricNoun(head.chartKind, scope, children)
    const atScope = (key: string) => statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey: key, scale: scaleEntries, noun })
    return { ...m, scope, children, head, noun, atScope, current: atScope(period) }
  })

  const reportMetric = (m: (typeof metrics)[number]): ReportMetric => {
    const { scope, children, head, current } = m
    const cell = cellAt(scope, period)
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
    return {
      key: m.key,
      name: head.metricName,
      categoryName: m.categoryName,
      chartKind: head.chartKind,
      format: head.format,
      direction: head.direction,
      definition: m.rows.find((r) => r.definition?.trim())?.definition?.trim() || head.metricName,
      versionId: cell?.versionId || doc.view.versionByPeriod[period] || '',
      display: cell && cell.naReason === '' ? cell.display : '',
      status: current.status,
      statusLabel: current.status ? statusLabel(current.status) : '',
      caption: current.caption,
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
      goalValue: cell?.target ?? null,
      driver: driver && driver.rank >= worstRank ? driver.name : null,
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
          }
        }),
      })),
    }
  }

  const byKey = new Map(metrics.map((m) => [m.key, reportMetric(m)]))

  const attentionItems: NeedsAttentionItem[] = []
  for (const m of metrics) {
    if (!m.current.status) continue
    const cell = cellAt(m.scope, period)
    attentionItems.push({
      metricKey: m.key,
      name: m.head.metricName,
      categoryOrder: view.categories.find((c) => c.id === m.categoryId)?.order ?? 0,
      status: m.current.status,
      value: cell?.value ?? null,
      change: cell?.change ?? null,
      direction: m.head.direction,
      rule: cell?.rule ?? { type: 'bands' },
      priorStatus: priorKey ? (cellAt(m.scope, priorKey)?.status ?? '') : '',
    })
  }

  const labels = healthLabels(scaleEntries)
  const counts = new Map<string, number>()
  for (const m of metrics) if (m.current.status) counts.set(m.current.status, (counts.get(m.current.status) ?? 0) + 1)
  const health = [...counts]
    .sort((a, b) => rankOf(a[0]) - rankOf(b[0]))
    .map(([key, count]) => ({ key, label: labels.get(key) ?? statusLabel(key), count }))
  const unreported = metrics.filter((m) => !m.current.status)

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
    facts: companyScope
      ? doc.facts
      : scopeFacts(
          metrics.flatMap((m) => (m.scope ? [m.scope] : [])),
          period,
          scaleEntries,
        ),
    needsAttention: needsAttention(attentionItems, scaleEntries).map((item) => byKey.get(item.metricKey)!),
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
      notReported: unreported.map((m) => m.head.metricName),
      versionIds: [...new Set(Object.values(doc.view.versionByPeriod).filter(Boolean))].sort(),
    },
  }
}
