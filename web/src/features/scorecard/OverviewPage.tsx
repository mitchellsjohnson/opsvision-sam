import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMe, useOrgUnits, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import {
  monthLabel,
  parent,
  parsePeriod,
  periodLabel,
  type Grain,
  type Period,
  type ViewRequest,
} from '../../lib/period'
import { StatusBadge } from '../../ui/StatusBadge'
import { usePeriodState } from '../../shell/usePeriodState'
import { buildTrendColumns, columnRequest, type Column } from './columns'
import { changeText } from './format'
import { needsAttention, type NeedsAttentionItem } from './logic/needsAttention'
import { defaultStatusScale } from './charts/chartTheme'
import { MetricChart } from './charts/MetricChart'
import { focusReturnRef } from './focusTrigger'
import { LayoutGrid } from './LayoutGrid'
import { cellReported, statusAtScope, type StatusScaleEntry } from './logic/statusAtScope'
import { cellKey, groupRows } from './viewHelpers'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type Cell = Schemas['Cell']

function shallowest(rows: ViewRow[]): ViewRow {
  return rows.reduce((best, r) => (r.depth < best.depth ? r : best))
}

function childRows(rows: ViewRow[], scope: ViewRow): ViewRow[] {
  return rows.filter((r) => r.depth === scope.depth + 1)
}

function metricNoun(chartKind: string, children: ViewRow[]): 'segments' | 'services' | 'items' {
  if (chartKind === 'uptime') return 'services'
  if (children.length > 0) return 'segments'
  return 'items'
}

function priorColumn(columns: Column[]): string | undefined {
  if (columns.length < 2) return undefined
  return columns[columns.length - 2]?.key
}

function scopeCell(row: ViewRow, columnKey: string): Cell | undefined {
  return row.cells.find((c) => cellKey(c) === columnKey)
}

function nextPeriod(p: Period): Period {
  if (p.grain === 'year') return { grain: 'year', fy: p.fy + 1, index: 0 }
  const max = p.grain === 'month' ? 12 : p.grain === 'quarter' ? 4 : 2
  if (p.index < max) return { ...p, index: p.index + 1 }
  return { grain: p.grain, fy: p.fy + 1, index: 1 }
}

/** Next reporting period for quarterly, biannual, or annual metrics after the selected month. */
function nextDuePeriodLabel(frequency: ViewRow['frequency'], selectedPeriod: string, fyStart: number): string | null {
  if (frequency === 'monthly') return null
  const month = parsePeriod(selectedPeriod)
  if (!month || month.grain !== 'month') return null
  const grain: Grain =
    frequency === 'quarterly' ? 'quarter' : frequency === 'biannual' ? 'half' : frequency === 'annual' ? 'year' : 'month'
  if (grain === 'month') return null
  const containing = parent(month, grain)
  return periodLabel(nextPeriod(containing), fyStart)
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

function Skeleton() {
  return (
    <p role="status" aria-busy="true">
      Loading overview…
    </p>
  )
}

export function OverviewPage() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [period] = usePeriodState()
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const orgUnits = useOrgUnits()
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
  const trendRequest: ViewRequest = { ...columnRequest(trendColumns) }
  if (period.subjects.length > 0) trendRequest.subjects = period.subjects

  const view = useView(period.ready ? scorecardId : undefined, trendRequest)
  const ytdRequest: ViewRequest | null =
    period.ytd && selectedColumn
      ? {
          ytd: [selectedColumn.period],
          ...(period.subjects.length > 0 ? { subjects: period.subjects } : {}),
        }
      : null
  const ytdView = useView(
    period.ready && ytdRequest ? scorecardId : undefined,
    ytdRequest ?? { periods: [] },
  )

  const parsed = parsePeriod(period.period)
  const headerParts = [
    parsed ? periodLabel(parsed, fy) : period.period,
    period.ytd && parsed?.grain === 'month' ? `year to date through ${monthLabel(parsed, fy).split(' ')[0]}` : null,
    period.scope
      ? (orgUnits.data?.units.find((u) => u.id === period.scope)?.name ?? 'Selected unit')
      : `All of ${companyName}`,
  ].filter(Boolean)

  const tableLink = (metricKey: string) => {
    const next = new URLSearchParams(params)
    const search = next.size > 0 ? `?${next.toString()}` : ''
    return { pathname: '../table', search, hash: `#metric-${metricKey}` }
  }

  const ytdCellFor = (row: ViewRow): Cell | undefined =>
    ytdView.data?.rows
      .find((r) => r.metricKey === row.metricKey && r.subjectId === row.subjectId)
      ?.cells.find((c) => c.ytd && c.display !== '')

  if (view.isPending || (ytdRequest && ytdView.isPending)) return <Skeleton />
  if (view.isError) {
    return (
      <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        Could not load the overview: {view.error.message}
      </div>
    )
  }

  const groups = groupRows(view.data)
  const columnKey = selectedColumn?.key ?? ''
  const priorKey = priorColumn(trendColumns)

  const metrics = groups.flatMap((g) =>
    g.metrics.map((m) => {
      const scope = shallowest(m.rows)
      const children = childRows(m.rows, scope)
      const noun = metricNoun(scope.chartKind, children)
      const atScope = statusAtScope({
        scope,
        children,
        columnKey,
        scale,
        noun,
      })
      return { category: g, metric: m, scope, children, atScope, noun }
    }),
  )

  const healthLabelsMap = healthLabels(scale)
  const healthCounts = new Map<string, number>()
  let notReported = 0
  for (const { atScope } of metrics) {
    if (!atScope.status) notReported++
    else healthCounts.set(atScope.status, (healthCounts.get(atScope.status) ?? 0) + 1)
  }

  const attentionItems: NeedsAttentionItem[] = []
  for (const { category, scope, atScope } of metrics) {
    if (!atScope.status) continue
    const cell = scope.cells.find((c) => cellKey(c) === columnKey)
    const prior = priorKey ? scope.cells.find((c) => cellKey(c) === priorKey) : undefined
    const metricDef = versions.data?.versions
      .find((v) => v.id === cell?.versionId)
      ?.content.metrics.find((x) => x.key === scope.metricKey)
    attentionItems.push({
      metricKey: scope.metricKey,
      name: scope.metricName,
      categoryOrder: view.data.categories.find((c) => c.id === category.id)?.order ?? 0,
      status: atScope.status,
      value: cell?.value ?? null,
      change: cell?.change ?? null,
      direction: scope.direction,
      rule: cell?.rule ?? metricDef?.rule ?? { type: 'bands' },
      priorStatus: prior?.status ?? '',
    })
  }
  const attention = needsAttention(attentionItems, scale)

  const ribbonLabel =
    parsed?.grain === 'quarter'
      ? '8-quarter status'
      : parsed?.grain === 'half'
        ? '4-half status'
        : parsed?.grain === 'year'
          ? '3-year status'
          : '12-month status'

  const unreported = metrics.filter(({ atScope }) => !atScope.status)

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
      itemLabels[`metric:${m.key}`] = meta?.scope.metricName ?? m.name
      metricCategories[m.key] = g.name
    }
  }

  const renderMetricCard = (metricKey: string) => {
    const meta = metrics.find((m) => m.metric.key === metricKey)
    if (!meta || (healthFilter && meta.atScope.status !== healthFilter)) return null
    const { metric, scope, children, atScope, noun } = meta
    const cell = scopeCell(scope, columnKey)
    const scopeReported = cellReported(cell)
    const reportedChildren = children.filter((ch) => cellReported(scopeCell(ch, columnKey)))
    const chartChildren = !scopeReported && reportedChildren.length > 0
    const scopeNote = chartChildren
      ? `Company total not reported; ${reportedChildren.length} ${noun} reported`
      : atScope.caption || undefined
    const chartRows = chartChildren ? reportedChildren : [scope]
    const ytdCell = ytdCellFor(scope)
    const ytdDisplay = ytdCell?.display ? `YTD ${ytdCell.display}` : null
    return (
      <article
        aria-label={scope.metricName}
        className="h-full cursor-pointer rounded-lg border border-ink/20 bg-white p-4 pt-10"
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('button, a, [role="button"]')) return
          focusReturnRef.current = e.currentTarget
          const next = new URLSearchParams(params)
          next.set('focus', metric.key)
          setParams(next)
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold">{scope.metricName}</h3>
          <button
            type="button"
            className="rounded border border-ink/20 px-2 py-0.5 text-xs hover:bg-cream"
            onClick={(e) => {
              focusReturnRef.current = e.currentTarget
              const next = new URLSearchParams(params)
              next.set('focus', metric.key)
              setParams(next)
            }}
          >
            Expand
          </button>
        </div>
        {atScope.caption && !chartChildren && <p className="text-xs text-ink/80">{atScope.caption}</p>}
        <MetricChart
          row={scope}
          chartRows={chartRows}
          childRows={children}
          columns={trendColumns}
          currentColumnKey={columnKey}
          currentDisplay={cell?.display ?? ''}
          currentStatus={atScope.status}
          statusLabel={statusLabel}
          scale={statusColors}
          tableTo={tableLink(metric.key)}
          scopeNote={scopeNote}
          ytdDisplay={ytdDisplay}
        />
        {cell && cell.changeKind && (
          <p className="mt-1 text-xs text-ink/70">
            {changeText({
              period: cell.period,
              ytd: cell.ytd,
              format: scope.format,
              change: cell.change,
              changeKind: cell.changeKind,
              compare: undefined,
              fyStart: fy,
            })}
          </p>
        )}
      </article>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-accent-deep">Overview</h1>
      <p className="mt-1 text-sm text-ink/80">{headerParts.join(' · ')}</p>

      <LayoutGrid
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
      <section aria-label={ribbonLabel}>
        <h2 className="text-base font-semibold text-accent-deep">{ribbonLabel}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {metrics.map(({ metric, scope, atScope }) => {
            const cells = trendColumns.map((col) => scope.cells.find((c) => cellKey(c) === col.key))
            const current = scope.cells.find((c) => cellKey(c) === columnKey)
            return (
              <li key={metric.key} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40 font-medium">{scope.metricName}</span>
                <span className="flex gap-0.5">
                  {cells.map((cell, i) => (
                    <StatusBadge key={trendColumns[i]!.key} status={cell?.status ?? ''} label={statusLabel(cell?.status ?? '')} className="min-w-6 px-1" />
                  ))}
                </span>
                <span className="tabular-nums">{current?.display || '—'}</span>
                {atScope.caption && <span className="text-ink/70">{atScope.caption}</span>}
              </li>
            )
          })}
        </ul>
      </section>
        )}
        renderNeeds={() =>
          attention.length > 0 ? (
        <section aria-label="Needs attention">
          <h2 className="text-lg font-semibold text-accent-deep">Needs attention</h2>
          <ul className="mt-3 grid gap-4 lg:grid-cols-3">
            {attention.map((item) => {
              const meta = metrics.find((m) => m.metric.key === item.metricKey)
              const driver = meta?.children
                .map((ch) => {
                  const cell = ch.cells.find((c) => cellKey(c) === columnKey)
                  return cell?.status ? { name: ch.subjectName, status: cell.status, rank: scale.find((s) => s.key === cell.status)?.rank ?? 0 } : null
                })
                .filter(Boolean)
                .sort((a, b) => (b?.rank ?? 0) - (a?.rank ?? 0))[0]
              return (
                <li key={item.metricKey} className="rounded-lg border border-ink/20 bg-white p-4">
                  <h3 className="font-semibold">{item.name}</h3>
                  <p className="mt-1 text-sm text-ink/80">
                    {driver ? `Driver: ${driver.name}` : 'No child breakdown'}
                  </p>
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
          const sectionCounts = new Map<string, number>()
          for (const m of g.metrics) {
            const meta = metrics.find((x) => x.metric.key === m.key)
            if (!meta) continue
            if (meta.atScope.status)
              sectionCounts.set(meta.atScope.status, (sectionCounts.get(meta.atScope.status) ?? 0) + 1)
          }
          return (
            <section aria-labelledby={`overview-cat-${g.id}`} className="pt-8">
              <h2 id={`overview-cat-${g.id}`} className="text-lg font-semibold text-accent-deep">
                {g.name}
                <span className="ml-2 text-sm font-normal text-ink/70">
                  {[...sectionCounts].map(([k, n]) => `${n}${k}`).join(' ')}
                </span>
              </h2>
            </section>
          )
        }}
        renderMetric={renderMetricCard}
        renderUnreported={() =>
          unreported.length > 0 ? (
            <p className="text-sm text-ink/80">
              Not reported:{' '}
              {unreported
                .map((m) => {
                  const due = nextDuePeriodLabel(m.scope.frequency, period.period, fy)
                  return due ? `${m.scope.metricName} (next due ${due})` : m.scope.metricName
                })
                .join(', ')}
              {canEnter && (
                <>
                  {' '}
                  <Link to={`/entry?period=${period.period}`} className="font-medium text-accent-deep hover:underline">
                    Enter data
                  </Link>
                </>
              )}
            </p>
          ) : null
        }
      />
    </div>
  )
}
