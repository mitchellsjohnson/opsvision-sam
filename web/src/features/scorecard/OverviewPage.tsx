import { useEffect, useMemo, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { skipToken, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { LayoutDashboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { keys, useItemKinds, useMe, useOrgLevels, useOrgUnits, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { lastMonth, monthLabel, monthsOf, parent, parsePeriod, periodLabel, prev, type Grain, type Period } from '../../lib/period'
import { StatusChip } from '../../ui/status'
import { usePeriodState } from '../../shell/usePeriodState'
import { NeedsAttention, type AttentionMeta } from './AttentionCard'
import { buildTrendColumns, shortLabel, type Column } from './columns'
import { formatMetricValue } from './format'
import { needsAttention } from './logic/needsAttention'
import { chartTheme, defaultStatusScale, MOVE_CLASS, type Move } from './charts/chartTheme'
import { MetricChart } from './charts/MetricChart'
import { formatMoneyCompact, overPlanPhrase } from './charts/moneyPlan'
import { buildPoints, headerChange } from './charts/points'
import { multiSeriesHeader, noTotalNote } from './charts/seriesLayout'
import { versionBoundaries } from './charts/versionMarkers'
import { LAYOUT_BUTTON } from './CustomizeBar'
import { focusReturnRef } from './focusTrigger'
import { HealthSummary, NOT_REPORTED } from './HealthSummary'
import { ItemSummaryTile } from './ItemSummaryTile'
import { LayoutGrid } from './LayoutGrid'
import { NotReportedCard } from './NotReportedCard'
import { SectionHeader } from './SectionHeader'
import { TileFrame } from './TileFrame'
import { worstChildren } from './logic/drivers'
import { ITEM_PARAM, itemSummary, sortItems } from './logic/itemGrid'
import { countNoun, nounForms, type NounForms } from './logic/nouns'
import {
  absentItemMetrics,
  attentionInputs,
  healthTally,
  itemRowsOf,
  metricStandings,
  type MetricStanding,
} from './logic/standings'
import { columnUnit, thresholdText } from './logic/statusText'
import { cellReported, type StatusScaleEntry } from './logic/statusAtScope'
import { cellKey, groupRows, ratioParts } from './viewHelpers'
import { useScorecardViewRequest } from './viewRequest'
import { StatusBoard } from './StatusBoard'
import { buildBoardRow } from './logic/statusBoard'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type Frequency = Schemas['Frequency']
type ItemKind = Schemas['ItemKind']

const HEALTH_TITLE: Record<Grain, string> = {
  month: 'Health this month',
  quarter: 'Health this quarter',
  half: 'Health this half',
  year: 'Health this year',
}

/** The first matching tile's Expand button: where Show all moves focus. */
const FIRST_TILE = '[data-layout-item^="metric:"] article button[aria-label^="Expand "]'

/** The item kinds' names, asked for only where an item metric is drawn (so other pages never ask). */
function WithItemKinds({ children }: { children: (kindName: (id: string | undefined) => string | undefined) => ReactNode }) {
  const kinds = useItemKinds()
  return children((id) => (id ? kinds.data?.find((k) => k.id === id)?.name : undefined))
}

/** Asks for the item kinds while the view has item rows, so captions can name them. */
function ItemKindsLoader() {
  useItemKinds()
  return null
}

/** `vs H2 FY25`: a half's change names the half it compares with in full, since there are so few (§5.2). */
function halfChange(change: { text: string; move: Move } | null, counted: string): { text: string; move: Move } | null {
  const p = parsePeriod(counted)
  if (!change || p?.grain !== 'half') return change
  const before = prev(p)
  return { ...change, text: change.text.replace(/ vs H\d$/, ` vs H${before.index} FY${String(before.fy).slice(-2)}`) }
}

const NO_KINDS = () => undefined

/** A column's short label under a ribbon: a month's initial, else the label (`Q3`). */
function initialOf(column: Column): string {
  return parsePeriod(column.period)?.grain === 'month' && !column.ytd ? column.label.slice(0, 1) : column.label
}

const MEASURED: Record<Frequency, string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  biannual: 'twice a year',
  annual: 'yearly',
}

/** Stands in for the scope row of a metric that has none: no cells. */
function emptyScope(head: ViewRow): ViewRow {
  return { ...head, subjectId: '', subjectName: '', cells: [] }
}

function scopeCell(row: ViewRow | null, columnKey: string): Cell | undefined {
  return row?.cells.find((c) => cellKey(c) === columnKey)
}

function Bone({ className }: { className: string }) {
  return <div data-skeleton="" className={clsx('rounded bg-ink/[0.06]', className)} />
}

/** Widgets at their final size while the one Overview request loads. */
function PageSkeleton() {
  const card = 'rounded-lg border border-ink/20 bg-white p-4'
  return (
    <div aria-busy="true" className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
      <p role="status" className="sr-only">
        Loading overview
      </p>
      <div aria-hidden="true" className={clsx(card, 'sm:col-span-2')}>
        <Bone className="h-5 w-48" />
        <Bone className="mt-3 h-3 w-full" />
        <div className="mt-3 flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Bone key={i} className="h-9 w-28" />
          ))}
        </div>
      </div>
      <div aria-hidden="true" className={clsx(card, 'sm:col-span-2')}>
        <Bone className="h-5 w-40" />
        <Bone className="mt-3 h-48 w-full" />
      </div>
      <div aria-hidden="true" className="border-b border-ink/15 pb-1.5 pt-2 sm:col-span-2">
        <Bone className="h-5 w-32" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden="true" className={card}>
          <Bone className="h-5 w-48" />
          <Bone className="mt-1 h-3 w-40" />
          <Bone className="mt-3 h-8 w-28" />
          <Bone className="mt-2 h-[120px] w-full" />
          <Bone className="mt-1 h-[18px] w-full" />
        </div>
      ))}
    </div>
  )
}

const TITLE = 'text-[28px] font-semibold leading-9 text-accent-deep'

/** The page title row; while loading, the title is drawn but the h1 waits for content, so heading navigation never lands on an empty page. */
function OverviewHeader({ parts, actions, loading = false }: { parts: string[]; actions: ReactNode; loading?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        {loading ? (
          <p aria-hidden="true" className={TITLE}>
            Overview
          </p>
        ) : (
          <h1 className={TITLE}>Overview</h1>
        )}
        <p className="mt-0.5 text-sm text-ink/80">{parts.join(' · ')}</p>
      </div>
      {actions}
    </div>
  )
}

/** Remembers the control that opened the dialog, so focus goes back to it on close. */
function rememberTrigger(trigger: HTMLElement) {
  focusReturnRef.current = trigger
}

/** The month after `p` closes. */
function monthAfter(p: Period): Period {
  const last = lastMonth(p)
  return last.index < 12 ? { ...last, index: last.index + 1 } : { ...last, fy: last.fy + 1, index: 1 }
}

const shortMonth = (month: Period, fy: number) => monthLabel(month, fy).split(' ')[0] ?? ''

/** `Latest: Q3 FY2026 (Jul–Sep) · Q4 due by Jan`: a coarse metric's counted period and the one due next (§5.5). */
function coarseContext(counted: Column, fy: number): string {
  const p = parsePeriod(counted.period)
  if (!p) return counted.fullLabel
  const months = monthsOf(p)
  const span = `${shortMonth(months[0]!, fy)}–${shortMonth(months[months.length - 1]!, fy)}`
  const next = parent(monthAfter(p), p.grain)
  return `Latest: ${counted.fullLabel} (${span}) · ${shortLabel(next, fy)} due by ${shortMonth(monthAfter(next), fy)}`
}

/** The last column with a value in `row`, for a metric that stopped reporting. */
function lastValued(row: ViewRow | null, columns: Column[]): { index: number; cell: Cell } | null {
  for (let i = columns.length - 1; i >= 0; i--) {
    const c = scopeCell(row, columns[i]!.key)
    if (c && c.value !== null && c.naReason === '') return { index: i, cell: c }
  }
  return null
}

export function OverviewPage() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [period] = usePeriodState()
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const orgUnits = useOrgUnits()
  const orgLevels = useOrgLevels()
  const versions = useVersions(scorecardId)
  // Read only: `ItemKindsLoader` asks for them while the view has item rows.
  const itemKinds = useQuery<ItemKind[]>({ queryKey: keys.itemKinds, queryFn: skipToken }).data
  const fy = period.fiscalYearStartMonth
  const scale: StatusScaleEntry[] = useMemo(
    () => (me.data?.tenant?.statusScale?.map((s) => ({ key: s.key, rank: s.rank })) ?? defaultStatusScale().map((s) => ({ key: s.key, rank: s.rank }))),
    [me.data?.tenant?.statusScale],
  )
  const statusColors = me.data?.tenant?.statusScale ?? defaultStatusScale()
  const statusLabel = (key: string) => statusColors.find((s) => s.key === key)?.label
  const companyName = me.data?.tenant?.name ?? 'Company'
  const canEnter = me.data?.role === 'admin' || me.data?.role === 'contributor'
  const healthFilter = params.get('health') ?? ''
  // Show all (Needs attention) moves focus to the first tile once the filtered tiles are drawn.
  const focusFirstTile = useRef(false)
  useEffect(() => {
    if (!focusFirstTile.current) return
    const first = document.querySelector<HTMLElement>(FIRST_TILE)
    if (!first) return
    focusFirstTile.current = false
    first.focus()
  })

  const trendColumns = useMemo(() => buildTrendColumns(period.period, fy), [period.period, fy])
  const selectedColumn = trendColumns[trendColumns.length - 1]
  const { request, ready } = useScorecardViewRequest()
  const view = useView(ready ? scorecardId : undefined, request)

  const parsed = parsePeriod(period.period)
  const headerParts = [
    parsed ? periodLabel(parsed, fy) : period.period,
    period.ytd && parsed?.grain === 'month' ? `year to date through ${monthLabel(parsed, fy).split(' ')[0]}` : null,
    period.scope
      ? (orgUnits.data?.units.find((u) => u.id === period.scope)?.name ?? 'Selected unit')
      : `All of ${companyName}`,
  ].filter(Boolean)

  const ytdCellFor = (row: ViewRow): Cell | undefined => row.cells.find((c) => c.ytd && c.display !== '')

  if (view.isPending || view.isError) {
    return (
      <div>
        <OverviewHeader
          parts={headerParts as string[]}
          loading={view.isPending}
          actions={
            <button type="button" className={LAYOUT_BUTTON} disabled>
              <LayoutDashboard aria-hidden size={16} />
              Customize layout
            </button>
          }
        />
        {view.isError ? (
          <div role="alert" className="mt-6 rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
            Could not load the overview: {view.error.message}
          </div>
        ) : (
          <PageSkeleton />
        )}
      </div>
    )
  }

  const groups = groupRows(view.data)
  const selectedGrain = parsed?.grain ?? 'month'
  const { metrics, priorTrend } = metricStandings({
    view: view.data,
    period: period.period,
    fy,
    scale,
    versions: versions.data?.versions,
    itemKinds,
    orgLevels: orgLevels.data ?? [],
  })
  const hasItems = metrics.some((m) => m.isItems && m.kindId)

  const byRank = [...statusColors].sort((a, b) => a.rank - b.rank)
  const bestKey = byRank[0]?.key ?? ''
  const worstLevel = byRank[byRank.length - 1]
  const worstKey = worstLevel?.key ?? ''
  const worstLabel = worstLevel?.label || worstKey
  const absent = absentItemMetrics(view.data, versions.data?.versions, selectedColumn, metrics)
  const healthCounts = healthTally(metrics.map((m) => m.status?.status ?? ''), absent.length, NOT_REPORTED)
  const priorCounts = priorTrend ? healthTally(metrics.map((m) => m.prior?.status ?? ''), absent.length, NOT_REPORTED) : null
  const healthTitle = HEALTH_TITLE[selectedGrain]

  const levelNoun = (children: ViewRow[]) =>
    nounForms(orgLevels.data?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name, 'unit')

  const attentionOf = (kindName: (id: string | undefined) => string | undefined) =>
    needsAttention(attentionInputs(metrics, { categories: view.data.categories, scale, fy, statusLabel, kindName }), scale)
  const itemCandidates = metrics.some((m) => m.isItems && m.kindId && m.status?.status && m.status.status !== bestKey)

  const boardRows = metrics.map(({ category, key, scope, head, children, noun, coarse }) =>
    buildBoardRow({
      key,
      category,
      scope,
      head,
      children,
      noun,
      columns: trendColumns,
      scale,
      fyStart: fy,
      frequency: head.frequency,
      coarse,
    }),
  )

  const ribbonLabel =
    parsed?.grain === 'quarter'
      ? '8-quarter status'
      : parsed?.grain === 'half'
        ? '4-half status'
        : parsed?.grain === 'year'
          ? '3-year status'
          : '12-month status'

  const windowText = `No reports in the last ${trendColumns.length} ${columnUnit(selectedColumn, trendColumns.length)}`
  const categoryName = (id: string) => view.data.categories.find((c) => c.id === id)?.name ?? ''
  const unreported = [
    ...metrics.flatMap(({ category, key, head, status }) =>
      status?.notReported ? [{ key, name: head.metricName, why: status.notReported.text, category: category.name }] : [],
    ),
    ...absent.map((m) => ({ key: m.key, name: m.name, why: windowText, category: categoryName(m.categoryId) })),
  ]
  const quiet = metrics.flatMap(({ status }) => (status?.quiet ? [status.quiet] : []))
  const selectedLabel = parsed ? periodLabel(parsed, fy) : period.period

  const openFocus = (metricKey: string, trigger: HTMLElement) => {
    rememberTrigger(trigger)
    const next = new URLSearchParams(params)
    next.set('focus', metricKey)
    next.delete(ITEM_PARAM)
    setParams(next)
  }

  const metricsByCategory: Record<string, { key: string }[]> = {}
  const metricCategories: Record<string, string> = {}
  const itemLabels: Record<string, string> = {
    'widget:health': healthTitle,
    'widget:ribbon': ribbonLabel,
    'widget:needs': 'Needs attention',
    'widget:unreported': 'Not reported',
  }
  for (const g of groups) {
    metricsByCategory[g.id] = g.metrics.map((m) => ({ key: m.key }))
    itemLabels[`section:${g.id}`] = g.name
    for (const m of g.metrics) {
      const meta = metrics.find((x) => x.key === m.key)
      itemLabels[`metric:${m.key}`] = meta?.head.metricName ?? m.name
      metricCategories[m.key] = g.name
    }
  }

  /** The tile's threshold and direction line (§3.5), with how many children have their own target. */
  const thresholdOf = (m: MetricStanding, noun: NounForms): string => {
    const { head, children, rule } = m
    if (!rule) return ''
    const ownTargets = (rule.perSubject ?? []).flatMap((p) => {
      const band = p.bands.find((b) => b.status === bestKey && b.op !== '')
      return band ? [{ name: children.find((c) => c.subjectId === p.subjectId)?.subjectName ?? p.subjectId, value: band.value }] : []
    })
    return thresholdText(rule, {
      format: head.format,
      direction: head.direction,
      chartKind: head.chartKind,
      frequency: head.frequency,
      statusLabel,
      perSubject: ownTargets,
      noun,
      surface: 'tile',
    })
  }

  const openItem = (metricKey: string, itemId: string, trigger: HTMLElement) => {
    rememberTrigger(trigger)
    const next = new URLSearchParams(params)
    next.set('focus', metricKey)
    next.set(ITEM_PARAM, itemId)
    setParams(next)
  }

  const shownByHealth = (status: string) =>
    !healthFilter || (healthFilter === NOT_REPORTED ? status === '' : status === healthFilter)
  const statusOf = new Map(metrics.map((m) => [m.key, m.status?.status ?? '']))
  const metricShown = (key: string) => shownByHealth(statusOf.get(key) ?? '')
  const filterLabel = healthFilter === NOT_REPORTED ? 'not reported' : (statusLabel(healthFilter) ?? healthFilter)
  const filterCount = healthCounts.get(healthFilter) ?? 0

  const renderMetricCard = (metricKey: string) => {
    const meta = metrics.find((m) => m.key === metricKey)
    const shownStatus = meta?.status?.status ?? ''
    if (!meta || !shownByHealth(shownStatus)) return null
    const { key, scope, head, children, noun, columns, status, cell } = meta
    const columnKey = status?.counted.key ?? ''
    const scopeReported = cellReported(cell)
    const reportedChildren = children.filter((ch) => cellReported(scopeCell(ch, columnKey)))
    const chartChildren = !scopeReported && reportedChildren.length > 0
    const levelName = orgLevels.data?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name
    // Several lines and no company value anywhere in the window: a metric with no company total (§7.6).
    const seriesNoun = noun.many
    const noTotal = chartChildren && reportedChildren.length > 1 && !columns.some((c) => cellReported(scopeCell(scope, c.key)))
    const chartRow = scope ?? emptyScope(head)
    const chartRows = chartChildren ? reportedChildren : [chartRow]
    // Twice-yearly and yearly tiles show period cards (§5.2), which already say which period counts and which is due.
    const cards = meta.coarse.length > 0 && columns.length <= 3 && chartRows.length === 1
    const scopeNote = noTotal
      ? noTotalNote(reportedChildren.length, seriesNoun, head.definition ?? '')
      : chartChildren && scope
        ? `Company total not reported; ${countNoun(reportedChildren.length, noun)} reported`
        : shownStatus && status && meta.coarse.length > 0
          ? [...(cards ? [] : [coarseContext(status.counted, fy)]), ...status.caption.split(' · ').slice(1)].join(' · ') || undefined
          : (shownStatus && status?.caption) || undefined
    const worstSeries =
      chartRows.length > 1 ? multiSeriesHeader(chartRows, columnKey, statusColors, (k) => statusLabel(k) ?? k, seriesNoun) : null
    const ytdCell = scope ? ytdCellFor(scope) : undefined
    const ytdDisplay = ytdCell?.display ? `YTD ${ytdCell.display}` : null
    const moneyPlan = head.chartKind === 'money_plan'
    // `$12.7M spent of $12.2M planned · over plan in 12 of the last 12 months`, when the formula is a ratio of
    // the cell's two measures (§6); the framed chart leaves its own over-plan line to this one.
    const version = versions.data?.versions.find((v) => v.id === (cell?.versionId || view.data.versionByPeriod[columnKey]))
    const parts = moneyPlan && cell ? ratioParts(version?.content.metrics.find((x) => x.key === key)?.formula, cell.components) : null
    const unitOf = (measure: string) => version?.content.measures.find((x) => x.key === measure)?.unit ?? ''
    const planned = parts
      ? `${formatMoneyCompact(cell!.components[parts[0]]!, unitOf(parts[0]))} spent of ${formatMoneyCompact(cell!.components[parts[1]]!, unitOf(parts[1]))} planned`
      : null
    const moneyLine = moneyPlan
      ? [planned, overPlanPhrase(buildPoints(chartRow, columns, fy), columns)].filter(Boolean).join(' · ') || undefined
      : undefined
    const extras = ytdDisplay
    const context = [moneyLine, scopeNote].filter(Boolean).join(' · ') || undefined
    const threshold = thresholdOf(meta, noun)
    const kind = status?.notReported?.kind
    const state = kind === 'window' ? 'window' : kind === 'stopped' ? 'stopped' : 'normal'

    if (state === 'window') {
      const first = columns[0]
      const last = columns[columns.length - 1]
      const by = levelName ? `, by ${nounForms(levelName, 'unit').one}` : ''
      return (
        <TileFrame
          head={head}
          threshold={threshold}
          value={status?.notReported?.text ?? ''}
          context={`Nothing has been entered for ${first?.fullLabel ?? ''} – ${last?.fullLabel ?? ''}. Measured ${MEASURED[head.frequency]}${by}.`}
          footer={
            canEnter ? (
              <Link to={`/entry?period=${period.period}`} className="text-sm font-medium text-accent-deep hover:underline">
                Enter {selectedLabel} data ›
              </Link>
            ) : undefined
          }
          onExpand={(trigger) => openFocus(key, trigger)}
          state="window"
        >
          {null}
        </TileFrame>
      )
    }

    if (meta.isItems) {
      return (
        <ItemSummaryTile
          head={head}
          rows={itemRowsOf(meta, scale, fy)}
          columns={columns}
          scale={statusColors}
          direction={head.direction}
          noun={noun}
          rule={meta.rule}
          onExpand={(trigger) => openFocus(key, trigger)}
          onOpenItem={(itemId, trigger) => openItem(key, itemId, trigger)}
        />
      )
    }

    let value: ReactNode
    if (state === 'stopped') {
      const last = lastValued(scope, columns)
      const after = last ? columns.slice(last.index + 1) : []
      value = (
        <>
          <span data-testid="header-value" className="text-[28px] font-semibold leading-9 tabular-nums">
            {last?.cell.display || '—'}
          </span>
          {last && <span className="text-sm">Last reported {columns[last.index]!.fullLabel}</span>}
          {after.length > 0 && (
            <span className="text-xs">
              · nothing for {after.length === 1 ? after[0]!.label : `${after[0]!.label}–${after[after.length - 1]!.label}`}
            </span>
          )}
        </>
      )
    } else if (worstSeries?.worst) {
      const worst = worstSeries.worst
      value = (
        <>
          <span className="text-xs text-ink/70">Worst</span>
          <span className="text-base font-semibold">{worst.name}</span>
          <span data-testid="header-value" className="text-[28px] font-semibold leading-9 tabular-nums">
            {worst.display}
          </span>
          {worst.status && (
            <span title={statusLabel(worst.status)}>
              <StatusChip status={worst.status} scale={statusColors} size="lg" />
            </span>
          )}
          {worstSeries.count && <span className="text-xs text-ink/70">{worstSeries.count}</span>}
        </>
      )
    } else {
      const change = halfChange(headerChange(chartRow, cell, fy), columnKey)
      value = (
        <>
          <span data-testid="header-value" className="text-[28px] font-semibold leading-9 tabular-nums">
            {cell?.display || '—'}
          </span>
          {moneyPlan && cell?.display && <span className="text-sm text-ink/80">of plan</span>}
          {shownStatus && (
            <span title={statusLabel(shownStatus)}>
              <StatusChip status={shownStatus} scale={statusColors} size="lg" />
            </span>
          )}
          {change && (
            <span
              data-testid="header-change"
              data-tone={change.move.tone}
              className={clsx('text-sm font-medium tabular-nums', MOVE_CLASS[change.move.tone])}
            >
              {change.move.arrow && <span aria-hidden="true">{change.move.arrow} </span>}
              {change.text}
            </span>
          )}
        </>
      )
    }

    return (
      <TileFrame
        head={head}
        threshold={threshold}
        value={value}
        extras={state === 'normal' ? extras : undefined}
        context={context}
        onExpand={(trigger) => openFocus(key, trigger)}
        state={state}
      >
        <MetricChart
          row={chartRow}
          chartRows={chartRows}
          columns={columns}
          currentColumnKey={columnKey}
          currentDisplay={cell?.display ?? ''}
          currentStatus={shownStatus}
          statusLabel={statusLabel}
          scale={statusColors}
          fiscalYearStartMonth={fy}
          framed
          markers={versionBoundaries(versions.data?.versions ?? [], columns, key, period.restate)}
          selectedPeriod={period.period}
        />
      </TileFrame>
    )
  }

  const selectHealth = (key: string) => {
    const next = new URLSearchParams(params)
    if (key) next.set('health', key)
    else next.delete('health')
    setParams(next)
  }

  const focusHref = (metricKey: string) => {
    const next = new URLSearchParams(params)
    next.set('focus', metricKey)
    next.delete(ITEM_PARAM)
    return `?${next.toString()}`
  }

  /** What a needs-attention card shows besides its reason (§4.3). */
  const attentionMeta = (m: MetricStanding): AttentionMeta => {
    const { category, scope, head, children, columns, status, cell, own } = m
    const columnKey = status?.counted.key ?? ''
    const base = {
      category: category.name,
      scale: statusColors,
      display: cell?.display ?? '',
      caption: status?.caption ?? '',
      change: headerChange(scope ?? emptyScope(head), cell, fy),
      threshold: thresholdOf(m, levelNoun(children)),
      ribbon: { cells: own.cells, labels: columns.map(initialOf) },
    }
    if (m.isItems) {
      const rows = itemRowsOf(m, scale, fy)
      const summary = itemSummary(rows, scale)
      const worst = summary.worst
      const others = [...byRank]
        .reverse()
        .filter((l) => l.key !== bestKey && (summary.counts.get(l.key) ?? 0) > 0)
        .map((l) => `${chartTheme(statusColors, l.key).shape} ${summary.counts.get(l.key)} ${l.label}`)
      const distribution = [
        `${summary.best} of ${summary.total} ${byRank[0]?.label ?? bestKey}`,
        ...others,
        ...(summary.notReported > 0 ? [`${summary.notReported} not reported`] : []),
      ].join(' · ')
      const worstRuns = worst ? worst.cells.filter((c) => c.kind === 'status' && c.status === worst.status).length : 0
      return {
        ...base,
        display: '',
        change: null,
        threshold: '',
        trend: null,
        ribbon: { cells: worst?.cells ?? [], labels: columns.map(initialOf) },
        why: null,
        items: {
          worst: worst ? { name: worst.name, display: worst.display, status: worst.status } : null,
          distribution,
          rows: sortItems(rows, 'worst', head.direction, scale)
            .reported.slice(0, 3)
            .map((r) => ({ id: r.id, name: r.name, display: r.display, cells: r.cells })),
          why: worst
            ? `${worst.name}: ${statusLabel(worst.status) ?? worst.status} in ${worstRuns} of the last ${columns.length} ${columnUnit(columns[columns.length - 1], columns.length)}`
            : '',
        },
      }
    }
    const points = scope
      ? columns.map((col) => {
          const c = scopeCell(scope, col.key)
          return { label: col.label, value: c && c.naReason === '' ? (c.value ?? null) : null, display: c?.display ?? '' }
        })
      : []
    const valued = points.filter((p) => p.value !== null)
    const goal = cell?.target ?? null
    const goalText = goal !== null && cell ? `; goal ${formatMetricValue(head.format, goal)}` : ''
    const unit = columnUnit(columns[columns.length - 1], columns.length)
    const kids = worstChildren(children, columnKey, scale, head.direction)
    const worstKid = kids.worst && kids.worst.cell.status ? kids.worst : null
    const kidNoun = levelNoun(children)
    return {
      ...base,
      trend:
        valued.length > 1
          ? {
              points,
              goal,
              bands: m.rule?.type === 'bands' ? (m.rule.bands ?? []) : [],
              summary: `Trend over ${columns.length} ${unit}: from ${valued[0]!.display} to ${valued[valued.length - 1]!.display}${goalText}`,
            }
          : null,
      why: worstKid
        ? {
            lead: head.direction === 'lower_better' ? 'Highest' : 'Lowest',
            name: worstKid.row.subjectName,
            display: worstKid.cell.display,
            status: worstKid.cell.status,
            share: `${kids.worstCount} of ${countNoun(kids.total, kidNoun)} ${statusLabel(worstKid.cell.status) ?? worstKid.cell.status}`,
          }
        : null,
    }
  }

  const renderAttention = (kindName: (id: string | undefined) => string | undefined) => {
    const { shown, totals } = attentionOf(kindName)
    if (shown.length === 0) return null
    return (
      <NeedsAttention
        shown={shown.flatMap((item) => {
          const m = metrics.find((x) => x.head.metricKey === item.metricKey)
          return m ? [{ item, meta: attentionMeta(m), href: focusHref(m.key) }] : []
        })}
        totals={totals}
        worstLabel={worstLabel}
        onShowAll={() => {
          focusFirstTile.current = true
          selectHealth(worstKey)
        }}
      />
    )
  }

  return (
    <div>
      {hasItems && <ItemKindsLoader />}
      <LayoutGrid
        renderHeaderActions={(button) => <OverviewHeader parts={headerParts as string[]} actions={button} />}
        scorecardId={scorecardId}
        categories={view.data.categories}
        metricsByCategory={metricsByCategory}
        isAdmin={me.data?.role === 'admin'}
        itemLabels={itemLabels}
        metricCategories={metricCategories}
        renderHealth={() => (
          <div>
            <HealthSummary
              title={healthTitle}
              period={selectedLabel}
              total={metrics.length + absent.length}
              counts={healthCounts}
              prior={priorCounts}
              priorLabel={priorTrend?.label ?? ''}
              selected={healthFilter}
              onSelect={selectHealth}
              scale={statusColors}
            />
            {healthFilter && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm">
                <span>{`Showing ${filterCount} ${filterLabel} ${filterCount === 1 ? 'metric' : 'metrics'}`}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className="min-h-6 font-medium text-accent-deep hover:underline"
                  onClick={() => {
                    // The pressed toggle stays in the page, so focus goes back to it rather than to the body.
                    const pressed = document.querySelector<HTMLElement>('[role="group"][aria-label="Show metrics by status"] [aria-pressed="true"]')
                    selectHealth('')
                    pressed?.focus()
                  }}
                >
                  Show all
                </button>
              </p>
            )}
          </div>
        )}
        renderRibbon={() => {
          const rows = healthFilter ? boardRows.filter((r) => metricShown(r.key)) : boardRows
          if (rows.length === 0) return null
          return (
            <StatusBoard
              label={healthFilter ? `${ribbonLabel} · ${healthFilter === NOT_REPORTED ? 'Not reported' : filterLabel} only` : ribbonLabel}
              columns={trendColumns}
              rows={rows}
              scale={statusColors}
              onOpen={openFocus}
              categories={groups.map((g) => ({ id: g.id, name: g.name }))}
            />
          )
        }}
        renderNeeds={() => {
          // Which metrics show never depends on the item kinds' names, only their reasons do.
          if (attentionOf(NO_KINDS).shown.length === 0) return null
          return itemCandidates ? <WithItemKinds>{renderAttention}</WithItemKinds> : renderAttention(NO_KINDS)
        }}
        renderSection={(categoryId) => {
          const g = groups.find((x) => x.id === categoryId)
          if (!g || !g.metrics.some((m) => metricShown(m.key))) return null
          return (
            <SectionHeader
              categoryId={g.id}
              name={g.name}
              rows={boardRows.filter((r) => r.category.id === g.id)}
              shown={boardRows.filter((r) => r.category.id === g.id && metricShown(r.key)).length}
              scale={statusColors}
            />
          )
        }}
        renderMetric={renderMetricCard}
        renderUnreported={() =>
          unreported.length > 0 || quiet.length > 0 ? (
            <NotReportedCard
              period={period.period}
              items={unreported}
              quiet={quiet.length > 0 ? `Reported less often and up to date: ${quiet.join(' · ')}.` : null}
              canEnter={canEnter}
            />
          ) : null
        }
      />
    </div>
  )
}
