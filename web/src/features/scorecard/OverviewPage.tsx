import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import clsx from 'clsx'
import { LayoutDashboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMe, useOrgLevels, useOrgUnits, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { monthLabel, parsePeriod, periodLabel } from '../../lib/period'
import { Sparkline } from '../../ui/Sparkline'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusChip } from '../../ui/status'
import { usePeriodState } from '../../shell/usePeriodState'
import { buildTrendColumns, COARSE_SPAN, coarseColumns, type CoarseGrain, type Column } from './columns'
import { changeText, withDirection } from './format'
import { needsAttention, type NeedsAttentionItem } from './logic/needsAttention'
import { defaultStatusScale, MOVE_CLASS } from './charts/chartTheme'
import { MetricChart } from './charts/MetricChart'
import { headerChange } from './charts/points'
import { LAYOUT_BUTTON } from './CustomizeBar'
import { focusReturnRef } from './focusTrigger'
import { LayoutGrid } from './LayoutGrid'
import { NotReportedCard } from './NotReportedCard'
import { SectionHeader } from './SectionHeader'
import { TileFrame } from './TileFrame'
import { periodStatus } from './logic/coarse'
import { nounForms } from './logic/nouns'
import { columnUnit, thresholdText } from './logic/statusText'
import { cellReported, type StatusScaleEntry } from './logic/statusAtScope'
import { cellKey, columnsFor, groupRows, metricScope } from './viewHelpers'
import { useScorecardViewRequest } from './viewRequest'
import { StatusBoard } from './StatusBoard'
import { buildBoardRow } from './logic/statusBoard'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']
type Frequency = Schemas['Frequency']

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

/** The column before `key` among `columns`. */
function priorColumn(columns: Column[], key: string): string | undefined {
  const i = columns.findIndex((c) => c.key === key)
  return i > 0 ? columns[i - 1]?.key : undefined
}

function scopeCell(row: ViewRow | null, columnKey: string): Cell | undefined {
  return row?.cells.find((c) => cellKey(c) === columnKey)
}

function healthLabels(scale: StatusScaleEntry[]): Map<string, string> {
  const sorted = [...scale].sort((a, b) => a.rank - b.rank)
  const labels = new Map<string, string>()
  if (sorted[0]) labels.set(sorted[0].key, 'On track')
  if (sorted.length > 2) {
    for (const mid of sorted.slice(1, -1)) labels.set(mid.key, 'Watch')
  } else if (sorted[1]) labels.set(sorted[1].key, 'Watch')
  const worst = sorted[sorted.length - 1]
  if (worst) labels.set(worst.key, 'Off track')
  return labels
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

  const metrics = groups.flatMap((g) =>
    g.metrics.map((m) => {
      const { scope, children, head } = metricScope(m.rows)
      const noun = metricNoun(head.chartKind, scope, children)
      const columns = columnsFor(head.frequency, selectedGrain, trendColumns, coarseByGrain)
      const coarse = columns === trendColumns ? [] : columns
      const status = selectedColumn
        ? periodStatus({ scope, children, frequency: head.frequency, selected: selectedColumn, coarse, scale, noun, fy })
        : null
      return { category: g, metric: m, scope, head, children, noun, columns, coarse, status }
    }),
  )

  const rankOf = (status: string) => scale.find((s) => s.key === status)?.rank ?? 0
  const worstRank = Math.max(...scale.map((s) => s.rank))
  const healthLabelsMap = healthLabels(scale)
  const healthCounts = new Map<string, number>()
  // A metric reported only for tracked items has no rows when no item is in
  // view (a scope with no services): it is not reported, not gone.
  const shownKeys = new Set(metrics.map((m) => m.metric.key))
  const absentItemMetrics = (
    versions.data?.versions.find((v) => v.id === view.data.versionByPeriod[selectedColumn?.key ?? ''])?.content.metrics ?? []
  ).filter((m) => !shownKeys.has(m.key) && m.reportedAt.length > 0 && m.reportedAt.every((s) => s.kind === 'item_kind'))
  let notReported = absentItemMetrics.length
  for (const { status } of metrics) {
    if (!status?.status) notReported++
    else healthCounts.set(status.status, (healthCounts.get(status.status) ?? 0) + 1)
  }

  const attentionItems: NeedsAttentionItem[] = []
  for (const { category, scope, head, status, columns } of metrics) {
    if (!status?.status) continue
    const cell = scopeCell(scope, status.counted.key)
    const priorKey = priorColumn(columns, status.counted.key)
    const prior = priorKey ? scopeCell(scope, priorKey) : undefined
    const metricDef = versions.data?.versions
      .find((v) => v.id === cell?.versionId)
      ?.content.metrics.find((x) => x.key === head.metricKey)
    attentionItems.push({
      metricKey: head.metricKey,
      name: head.metricName,
      categoryOrder: view.data.categories.find((c) => c.id === category.id)?.order ?? 0,
      status: status.status,
      value: cell?.value ?? null,
      change: cell?.change ?? null,
      direction: head.direction,
      rule: cell?.rule ?? metricDef?.rule ?? { type: 'bands' },
      priorStatus: prior?.status ?? '',
    })
  }
  const attention = needsAttention(attentionItems, scale)

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
    setParams(next)
  }

  const metricsByCategory: Record<string, { key: string }[]> = {}
  const metricCategories: Record<string, string> = {}
  const itemLabels: Record<string, string> = {
    'widget:health': 'Health this month',
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

  const renderMetricCard = (metricKey: string) => {
    const meta = metrics.find((m) => m.metric.key === metricKey)
    const shownStatus = meta?.status?.status ?? ''
    if (!meta || (healthFilter && shownStatus !== healthFilter)) return null
    const { metric, scope, head, children, noun, columns, status } = meta
    const columnKey = status?.counted.key ?? ''
    const cell = scopeCell(scope, columnKey)
    const scopeReported = cellReported(cell)
    const reportedChildren = children.filter((ch) => cellReported(scopeCell(ch, columnKey)))
    const chartChildren = !scopeReported && reportedChildren.length > 0
    const scopeNote =
      chartChildren && scope
        ? `Company total not reported; ${reportedChildren.length} ${noun} reported`
        : (shownStatus && status?.caption) || undefined
    const chartRow = scope ?? emptyScope(head)
    const chartRows = chartChildren ? reportedChildren : [chartRow]
    const ytdCell = scope ? ytdCellFor(scope) : undefined
    const ytdDisplay = ytdCell?.display ? `YTD ${ytdCell.display}` : null
    const metricDef = versions.data?.versions
      .find((v) => v.id === (cell?.versionId || view.data.versionByPeriod[columnKey]))
      ?.content.metrics.find((x) => x.key === head.metricKey)
    const rule = cell?.rule ?? metricDef?.rule
    const bestKey = [...scale].sort((a, b) => a.rank - b.rank)[0]?.key
    const ownTargets = (rule?.perSubject ?? []).flatMap((p) => {
      const band = p.bands.find((b) => b.status === bestKey && b.op !== '')
      return band ? [{ name: children.find((c) => c.subjectId === p.subjectId)?.subjectName ?? p.subjectId, value: band.value }] : []
    })
    const levelName = orgLevels.data?.find((l) => l.depth === (children[0]?.depth ?? -1))?.name
    const threshold = rule
      ? thresholdText(rule, {
          format: head.format,
          direction: head.direction,
          chartKind: head.chartKind,
          frequency: head.frequency,
          statusLabel,
          perSubject: ownTargets,
          noun: noun === 'services' ? nounForms('services', 'item') : nounForms(levelName, 'unit'),
          surface: 'tile',
        })
      : ''
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
          childRows={children}
          columns={columns}
          currentColumnKey={columnKey}
          currentDisplay={cell?.display ?? ''}
          currentStatus={shownStatus}
          statusLabel={statusLabel}
          scale={statusColors}
          fiscalYearStartMonth={fy}
          framed
        />
      </TileFrame>
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
      <section aria-label="Health this month">
        <h2 className="sr-only">Health this month</h2>
        <div className="flex flex-wrap gap-2">
            {[...healthCounts].map(([key, count]) => (
              <button
                key={key}
                type="button"
                className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm hover:bg-cream"
                onClick={() => {
                  const next = new URLSearchParams(params)
                  next.set('health', key)
                  setParams(next)
                }}
              >
                {healthLabelsMap.get(key) ?? key} {count}
              </button>
            ))}
            {notReported > 0 && (
              <span className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm">
                Not reported {notReported}
              </span>
            )}
        </div>
        {healthFilter && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-cream px-3 py-1 text-sm">
              <StatusBadge status={healthFilter} label={statusLabel(healthFilter)} />
              <span>{healthLabelsMap.get(healthFilter) ?? healthFilter}</span>
              <button type="button" aria-label="Clear health filter" className="font-medium text-accent-deep" onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('health')
                setParams(next)
              }}>
                Clear
              </button>
            </span>
          </div>
        )}
      </section>
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
          attention.length > 0 ? (
        <section aria-label="Needs attention">
          <h2 className="text-lg font-semibold text-accent-deep">Needs attention</h2>
          <ul className="mt-3 grid gap-4 lg:grid-cols-3">
            {attention.map((item) => {
              const meta = metrics.find((m) => m.metric.key === item.metricKey)
              if (!meta?.status) return null
              const { scope, head, children, status, columns } = meta
              const columnKey = status.counted.key
              const cell = scopeCell(scope, columnKey)
              const driver = children
                .map((ch) => {
                  const c = scopeCell(ch, columnKey)
                  return cellReported(c) && c?.status ? { name: ch.subjectName, rank: rankOf(c.status) } : null
                })
                .filter((d): d is { name: string; rank: number } => d !== null)
                .sort((a, b) => b.rank - a.rank)[0]
              const change =
                cell && cell.changeKind
                  ? changeText({
                      period: cell.period,
                      ytd: cell.ytd,
                      format: head.format,
                      change: cell.change,
                      changeKind: cell.changeKind,
                      compare: item.rule.type === 'change' ? item.rule.compare : undefined,
                      fyStart: fy,
                    })
                  : null
              const trend = scope
                ? columns.map((col) => {
                    const c = scopeCell(scope, col.key)
                    return { label: col.label, value: c && c.naReason === '' ? (c.value ?? null) : null, display: c?.display ?? '' }
                  })
                : []
              const shown = trend.filter((p) => p.value !== null)
              return (
                <li key={item.metricKey} className="rounded-lg border border-ink/20 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold">{item.name}</h3>
                    <button
                      type="button"
                      aria-label={`Expand ${item.name}`}
                      className="rounded border border-ink/20 px-2 py-0.5 text-xs hover:bg-cream"
                      onClick={(e) => {
                        focusReturnRef.current = e.currentTarget
                        const next = new URLSearchParams(params)
                        next.set('focus', item.metricKey)
                        setParams(next)
                      }}
                    >
                      Expand
                    </button>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge status={status.status} label={statusLabel(status.status)} />
                    <span className="text-lg font-semibold tabular-nums">{cell?.display || '—'}</span>
                    {status.caption && <span className="text-xs text-ink/80">{status.caption}</span>}
                  </p>
                  {change && <p className="mt-1 text-xs text-ink/80">{withDirection(change, head.direction)}</p>}
                  {shown.length > 1 && (
                    <div className="mt-2">
                      <Sparkline
                        points={trend}
                        target={cell?.target ?? null}
                        height={40}
                        summary={`Trend over ${trend.length} periods: from ${shown[0]!.display} to ${shown[shown.length - 1]!.display}`}
                      />
                    </div>
                  )}
                  {driver && driver.rank >= worstRank && <p className="mt-1 text-sm text-ink/80">Driver: {driver.name}</p>}
                </li>
              )
            })}
          </ul>
        </section>
          ) : null
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
