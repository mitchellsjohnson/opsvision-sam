import { useEffect, useMemo, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import clsx from 'clsx'
import { LayoutDashboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { useItemKinds, useMe, useOrgLevels, useOrgUnits, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { monthLabel, parsePeriod, periodLabel, type Grain } from '../../lib/period'
import { StatusChip } from '../../ui/status'
import { usePeriodState } from '../../shell/usePeriodState'
import { NeedsAttention, type AttentionMeta } from './AttentionCard'
import { buildTrendColumns, COARSE_SPAN, coarseColumns, type CoarseGrain, type Column } from './columns'
import { formatMetricValue } from './format'
import { needsAttention, streakMonths, type NeedsAttentionItem } from './logic/needsAttention'
import { chartTheme, defaultStatusScale, MOVE_CLASS } from './charts/chartTheme'
import { MetricChart } from './charts/MetricChart'
import { headerChange } from './charts/points'
import { multiSeriesHeader, noTotalNote } from './charts/seriesLayout'
import { versionBoundaries } from './charts/versionMarkers'
import { LAYOUT_BUTTON } from './CustomizeBar'
import { focusBodyKind } from './focusBody'
import { focusReturnRef } from './focusTrigger'
import { HealthSummary, NOT_REPORTED } from './HealthSummary'
import { ItemSummaryTile } from './ItemSummaryTile'
import { LayoutGrid } from './LayoutGrid'
import { NotReportedCard } from './NotReportedCard'
import { SectionHeader } from './SectionHeader'
import { TileFrame } from './TileFrame'
import { periodStatus } from './logic/coarse'
import { worstChildren } from './logic/drivers'
import { buildItemRows, ITEM_PARAM, itemSummary, sortItems } from './logic/itemGrid'
import { countNoun, nounForms, type NounForms } from './logic/nouns'
import { columnUnit, sinceText, thresholdText } from './logic/statusText'
import { cellReported, type StatusScaleEntry } from './logic/statusAtScope'
import { cellKey, columnsFor, groupRows, metricScope } from './viewHelpers'
import { useScorecardViewRequest } from './viewRequest'
import { StatusBoard } from './StatusBoard'
import { buildBoardRow } from './logic/statusBoard'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type Frequency = Schemas['Frequency']

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

function metricNoun(chartKind: string, scope: ViewRow | null, children: ViewRow[]): 'segments' | 'services' | 'items' {
  if (chartKind === 'uptime') return 'services'
  if (scope && children.length > 0) return 'segments'
  return 'items'
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
  // The coarse periods the shared request added (the version in force decides which).
  const responded = new Set(view.data.periods)
  const coarseByGrain: Partial<Record<CoarseGrain, Column[]>> = {}
  for (const grain of ['quarter', 'half', 'year'] as const) {
    const cols = coarseColumns(period.period, grain, COARSE_SPAN[grain], fy)
    if (cols.length > 0 && cols.every((c) => responded.has(c.period))) coarseByGrain[grain] = cols
  }

  const priorTrend = trendColumns[trendColumns.length - 2]
  const metricDefOf = (metricKey: string, versionId: string) =>
    versions.data?.versions.find((v) => v.id === versionId)?.content.metrics.find((x) => x.key === metricKey)

  const metrics = groups.flatMap((g) =>
    g.metrics.map((m) => {
      const { scope, children, head } = metricScope(m.rows)
      const noun = metricNoun(head.chartKind, scope, children)
      const columns = columnsFor(head.frequency, selectedGrain, trendColumns, coarseByGrain)
      const coarse = columns === trendColumns ? [] : columns
      const status = selectedColumn
        ? periodStatus({ scope, children, frequency: head.frequency, selected: selectedColumn, coarse, scale, noun, fy })
        : null
      const prior = priorTrend
        ? periodStatus({ scope, children, frequency: head.frequency, selected: priorTrend, coarse, scale, noun, fy })
        : null
      const columnKey = status?.counted.key ?? ''
      const cell = scopeCell(scope, columnKey)
      const metricDef = metricDefOf(head.metricKey, cell?.versionId || view.data.versionByPeriod[columnKey] || '')
      // The metric over its own columns (quarters for a quarterly metric), for streaks and the attention ribbon.
      const own = buildBoardRow({
        key: m.key,
        category: { id: g.id, name: g.name },
        scope,
        head,
        children,
        noun,
        columns,
        scale,
        fyStart: fy,
      })
      return {
        category: g,
        metric: m,
        scope,
        head,
        children,
        noun,
        columns,
        coarse,
        status,
        prior,
        cell,
        rule: cell?.rule ?? metricDef?.rule,
        // Uptime and metrics reported only for items get the item tile (§6.1).
        isItems: focusBodyKind(m.rows) === 'items' && m.rows.some((r) => r.subjectKind === 'item'),
        kindId: metricDef?.reportedAt.find((s) => s.kind === 'item_kind')?.id,
        own,
      }
    }),
  )
  type MetricMeta = (typeof metrics)[number]

  const byRank = [...statusColors].sort((a, b) => a.rank - b.rank)
  const bestKey = byRank[0]?.key ?? ''
  const worstLevel = byRank[byRank.length - 1]
  const worstKey = worstLevel?.key ?? ''
  const worstLabel = worstLevel?.label || worstKey
  // A metric reported only for tracked items has no rows when no item is in
  // view (a scope with no services): it is not reported, not gone.
  const shownKeys = new Set(metrics.map((m) => m.metric.key))
  const absentItemMetrics = (
    versions.data?.versions.find((v) => v.id === view.data.versionByPeriod[selectedColumn?.key ?? ''])?.content.metrics ?? []
  ).filter((m) => !shownKeys.has(m.key) && m.reportedAt.length > 0 && m.reportedAt.every((s) => s.kind === 'item_kind'))
  const tally = (statuses: string[]) => {
    const counts = new Map<string, number>([[NOT_REPORTED, absentItemMetrics.length]])
    for (const s of statuses) {
      const key = s || NOT_REPORTED
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const healthCounts = tally(metrics.map((m) => m.status?.status ?? ''))
  const priorCounts = priorTrend ? tally(metrics.map((m) => m.prior?.status ?? '')) : null
  const healthTitle = HEALTH_TITLE[selectedGrain]

  const itemRowsOf = (m: MetricMeta) => buildItemRows(m.metric.rows, m.columns, scale, () => '', fy)
  const levelNoun = (children: ViewRow[]) =>
    nounForms(orgLevels.data?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name, 'unit')

  const attentionInputs = (kindName: (id: string | undefined) => string | undefined): NeedsAttentionItem[] =>
    metrics.flatMap((m): NeedsAttentionItem[] => {
      const { category, head, status, columns, own, cell } = m
      if (!status?.status) return []
      const index = columns.findIndex((c) => c.key === status.counted.key)
      const before = index > 0 ? own.cells[index - 1] : undefined
      const priorStatus = before?.kind === 'status' ? before.status : ''
      const label = statusLabel(status.status) ?? status.status
      const items = m.isItems ? itemRowsOf(m) : null
      const worst = items ? itemSummary(items, scale).worst : null
      const count = items ? items.filter((r) => r.reported && r.status === status.status).length : 0
      return [
        {
          metricKey: head.metricKey,
          name: head.metricName,
          categoryOrder: view.data.categories.find((c) => c.id === category.id)?.order ?? 0,
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
  const itemCandidates = metrics.some((m) => m.isItems && m.kindId && m.status?.status && m.status.status !== bestKey)

  const boardRows = metrics.map(({ category, metric, scope, head, children, noun, coarse }) =>
    buildBoardRow({
      key: metric.key,
      category: { id: category.id, name: category.name },
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
    ...metrics.flatMap(({ category, metric, head, status }) =>
      status?.notReported ? [{ key: metric.key, name: head.metricName, why: status.notReported.text, category: category.name }] : [],
    ),
    ...absentItemMetrics.map((m) => ({ key: m.key, name: m.name, why: windowText, category: categoryName(m.categoryId) })),
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
      const meta = metrics.find((x) => x.metric.key === m.key)
      itemLabels[`metric:${m.key}`] = meta?.head.metricName ?? m.name
      metricCategories[m.key] = g.name
    }
  }

  /** The tile's threshold and direction line (§3.5), with how many children have their own target. */
  const thresholdOf = (m: MetricMeta, noun: NounForms): string => {
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

  const renderMetricCard = (metricKey: string) => {
    const meta = metrics.find((m) => m.metric.key === metricKey)
    const shownStatus = meta?.status?.status ?? ''
    if (!meta || !shownByHealth(shownStatus)) return null
    const { metric, scope, head, children, noun, columns, status, cell } = meta
    const columnKey = status?.counted.key ?? ''
    const scopeReported = cellReported(cell)
    const reportedChildren = children.filter((ch) => cellReported(scopeCell(ch, columnKey)))
    const chartChildren = !scopeReported && reportedChildren.length > 0
    const levelName = orgLevels.data?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name
    // Several lines and no company value anywhere in the window: a metric with no company total (§7.6).
    const seriesNoun = noun === 'items' && children[0]?.subjectKind === 'unit' ? nounForms(levelName, 'unit').many : noun
    const noTotal = chartChildren && reportedChildren.length > 1 && !columns.some((c) => cellReported(scopeCell(scope, c.key)))
    const scopeNote = noTotal
      ? noTotalNote(reportedChildren.length, seriesNoun, head.definition ?? '')
      : chartChildren && scope
        ? `Company total not reported; ${reportedChildren.length} ${noun} reported`
        : (shownStatus && status?.caption) || undefined
    const chartRow = scope ?? emptyScope(head)
    const chartRows = chartChildren ? reportedChildren : [chartRow]
    const worstSeries =
      chartRows.length > 1 ? multiSeriesHeader(chartRows, columnKey, statusColors, (k) => statusLabel(k) ?? k, seriesNoun) : null
    const ytdCell = scope ? ytdCellFor(scope) : undefined
    const ytdDisplay = ytdCell?.display ? `YTD ${ytdCell.display}` : null
    const threshold = thresholdOf(meta, noun === 'services' ? nounForms('services', 'item') : nounForms(levelName, 'unit'))
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
          onExpand={(trigger) => openFocus(metric.key, trigger)}
          state="window"
        >
          {null}
        </TileFrame>
      )
    }

    if (meta.isItems) {
      const tile = (kindName: (id: string | undefined) => string | undefined) => (
        <ItemSummaryTile
          head={head}
          rows={itemRowsOf(meta)}
          columns={columns}
          scale={statusColors}
          direction={head.direction}
          noun={nounForms(kindName(meta.kindId), 'item')}
          rule={meta.rule}
          onExpand={(trigger) => openFocus(metric.key, trigger)}
          onOpenItem={(itemId, trigger) => openItem(metric.key, itemId, trigger)}
        />
      )
      return meta.kindId ? <WithItemKinds>{tile}</WithItemKinds> : tile(NO_KINDS)
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
      const change = headerChange(chartRow, cell, fy)
      value = (
        <>
          <span data-testid="header-value" className="text-[28px] font-semibold leading-9 tabular-nums">
            {cell?.display || '—'}
          </span>
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
        extras={state === 'normal' ? ytdDisplay : undefined}
        context={scopeNote}
        onExpand={(trigger) => openFocus(metric.key, trigger)}
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
          markers={versionBoundaries(versions.data?.versions ?? [], columns, metric.key, period.restate)}
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
  const attentionMeta = (m: MetricMeta): AttentionMeta => {
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
      const rows = itemRowsOf(m)
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
    const { shown, totals } = needsAttention(attentionInputs(kindName), scale)
    if (shown.length === 0) return null
    return (
      <NeedsAttention
        shown={shown.flatMap((item) => {
          const m = metrics.find((x) => x.head.metricKey === item.metricKey)
          return m ? [{ item, meta: attentionMeta(m), href: focusHref(m.metric.key) }] : []
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
      <LayoutGrid
        renderHeaderActions={(button) => <OverviewHeader parts={headerParts as string[]} actions={button} />}
        scorecardId={scorecardId}
        categories={view.data.categories}
        metricsByCategory={metricsByCategory}
        isAdmin={me.data?.role === 'admin'}
        itemLabels={itemLabels}
        metricCategories={metricCategories}
        renderHealth={() => (
          <HealthSummary
            title={healthTitle}
            period={selectedLabel}
            total={metrics.length + absentItemMetrics.length}
            counts={healthCounts}
            prior={priorCounts}
            priorLabel={priorTrend?.label ?? ''}
            selected={healthFilter}
            onSelect={selectHealth}
            scale={statusColors}
          />
        )}
        renderRibbon={() => (
          <StatusBoard
            label={ribbonLabel}
            columns={trendColumns}
            rows={boardRows}
            scale={statusColors}
            onOpen={openFocus}
          />
        )}
        renderNeeds={() =>
          itemCandidates ? <WithItemKinds>{renderAttention}</WithItemKinds> : renderAttention(NO_KINDS)
        }
        renderSection={(categoryId) => {
          const g = groups.find((x) => x.id === categoryId)
          if (!g) return null
          return (
            <SectionHeader
              id={`overview-cat-${g.id}`}
              name={g.name}
              rows={boardRows.filter((r) => r.category.id === g.id)}
              scale={statusColors}
            />
          )
        }}
        renderMetric={renderMetricCard}
        renderUnreported={() => (
          <NotReportedCard
            period={period.period}
            items={unreported}
            quiet={quiet.length > 0 ? `Reported less often and up to date: ${quiet.join(' · ')}.` : null}
            canEnter={canEnter}
          />
        )}
      />
    </div>
  )
}
