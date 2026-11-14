import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMe, useOrgUnits, useScorecards, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { usePeriodState } from '../../shell/usePeriodState'
import { defaultStatusScale } from './charts/chartTheme'
import { FOCUS_CHART_HEIGHT, MetricChart } from './charts/MetricChart'
import { buildMonthTrendColumns, buildTrendColumns } from './columns'
import { focusReturnRef } from './focusTrigger'
import { defaultLayout } from './logic/layout'
import { cellReported, statusAtScope, type StatusScaleEntry } from './logic/statusAtScope'
import { TablePage } from './TablePage'
import { chartCsv, chartSvg, downloadBlob, metricPng } from './exports'
import { cellKey, groupRows, metricScope } from './viewHelpers'
import { useScorecardViewRequest } from './viewRequest'

function metricKeysInLayout(view: components['schemas']['ScorecardView']): string[] {
  const groups = groupRows(view)
  const metricsByCategory: Record<string, { key: string }[]> = {}
  for (const g of groups) {
    metricsByCategory[g.id] = g.metrics.map((m) => ({ key: m.key }))
  }
  return defaultLayout(view.categories, metricsByCategory)
    .filter((i) => i.id.startsWith('metric:'))
    .map((i) => i.id.slice('metric:'.length))
}

function MetricFocusBody({
  metricKey,
  metricIds,
  onClose,
  contentRef,
}: {
  metricKey: string
  metricIds: string[]
  onClose: () => void
  contentRef: React.RefObject<HTMLDivElement | null>
}) {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [period, updatePeriod] = usePeriodState()
  const [params, setParams] = useSearchParams()
  const [windowMonths, setWindowMonths] = useState<12 | 24>(12)
  const [exportError, setExportError] = useState('')
  const me = useMe()
  const orgUnits = useOrgUnits()
  const versions = useVersions(scorecardId)
  const fy = period.fiscalYearStartMonth
  const scale: StatusScaleEntry[] = useMemo(
    () =>
      me.data?.tenant?.statusScale?.map((s) => ({ key: s.key, rank: s.rank })) ??
      defaultStatusScale().map((s) => ({ key: s.key, rank: s.rank })),
    [me.data?.tenant?.statusScale],
  )
  const statusColors = me.data?.tenant?.statusScale ?? defaultStatusScale()
  const statusLabel = (key: string) => statusColors.find((s) => s.key === key)?.label

  // 24 months asks for this metric's rows only, which keeps the request well
  // inside the API's limits; 12 shares the Overview's request and cache.
  const { request, ready } = useScorecardViewRequest(
    windowMonths === 24 ? { months: 24, metrics: [metricKey] } : {},
  )
  const view = useView(ready ? scorecardId : undefined, request, { keepPrevious: true })
  // While the other window loads, the chart keeps the window it has data for.
  const shownMonths = view.isPlaceholderData && view.data ? (view.data.periods.length > 12 ? 24 : 12) : windowMonths
  const trendColumns = useMemo(
    () =>
      shownMonths === 24
        ? buildMonthTrendColumns(period.period, 24, fy)
        : buildTrendColumns(period.period, fy),
    [period.period, fy, shownMonths],
  )
  const selectedColumn = trendColumns[trendColumns.length - 1]
  const columnKey = selectedColumn?.key ?? ''

  const groups = view.data ? groupRows(view.data) : []
  const metricGroup = groups.flatMap((g) => g.metrics).find((m) => m.key === metricKey)
  const measured = metricGroup ? metricScope(metricGroup.rows) : null
  const head = measured?.head
  const scope = measured?.scope ?? null
  const children = measured?.children ?? []
  // A metric with no org-unit row (item-only) has no scope value to chart.
  const chartRow = scope ?? (head ? { ...head, subjectId: '', subjectName: '', cells: [] } : undefined)
  const cell = scope?.cells.find((c) => cellKey(c) === columnKey)
  const scopeReported = cellReported(cell)
  const reportedChildren = children.filter((ch) => cellReported(ch.cells.find((c) => cellKey(c) === columnKey)))
  const chartChildren = !scopeReported && reportedChildren.length > 0
  const chartRows = chartChildren ? reportedChildren : chartRow ? [chartRow] : []
  const noun = head?.chartKind === 'uptime' ? 'services' : scope && children.length > 0 ? 'segments' : 'items'
  const atScope = head
    ? statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey, scale, noun })
    : null

  const rankedChildren = children
    .map((ch) => {
      const c = ch.cells.find((x) => cellKey(x) === columnKey)
      const rank = scale.find((s) => s.key === c?.status)?.rank ?? -1
      return { row: ch, cell: c, rank }
    })
    .filter((x) => x.cell && cellReported(x.cell))
    .sort((a, b) => b.rank - a.rank)

  const tableLink = useMemo(() => {
    const q = new URLSearchParams(params)
    q.delete('focus')
    const search = q.size > 0 ? `?${q.toString()}` : ''
    return {
      pathname: `/scorecards/${scorecardId}/table`,
      search,
      hash: `#metric-${metricKey}`,
    }
  }, [params, scorecardId, metricKey])

  const idx = metricIds.indexOf(metricKey)
  const prevId = metricIds[idx > 0 ? idx - 1 : metricIds.length - 1]
  const nextId = metricIds[idx >= 0 && idx < metricIds.length - 1 ? idx + 1 : 0]

  const setFocus = (id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('focus', id)
      return next
    })
  }

  const exportCsv = () => {
    if (!head || chartRows.length === 0) return
    downloadBlob(`${head.metricKey}.csv`, 'text/csv', chartCsv(trendColumns, chartRows))
  }

  const unitName = (id: string) => orgUnits.data?.units.find((u) => u.id === id)?.name
  const exportScope = (() => {
    if (period.subjects.length > 0) {
      const names = period.subjects.map((id) => unitName(id) ?? id)
      return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
    }
    if (period.scope) return unitName(period.scope) ?? 'Selected unit'
    return `All of ${me.data?.tenant?.name ?? 'the company'}`
  })()
  const restatedName = period.restate
    ? (versions.data?.versions.find((v) => v.id === period.restate)?.name ?? 'the selected methodology version')
    : ''
  const exportedChart = (metric: NonNullable<typeof head>) =>
    chartSvg({
      title: metric.metricName,
      scope: exportScope,
      restatedUnder: restatedName,
      format: metric.format,
      columns: trendColumns,
      rows: chartRows,
      scale: statusColors,
    })

  const exportSvg = () => {
    if (!head || chartRows.length === 0) return
    downloadBlob(`${head.metricKey}.svg`, 'image/svg+xml', exportedChart(head))
  }

  const exportPng = async () => {
    if (!head || chartRows.length === 0) return
    setExportError('')
    try {
      await metricPng(exportedChart(head), `${head.metricKey}.png`)
    } catch {
      setExportError('We couldn’t make the image. Try SVG or CSV.')
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
    } catch {
      /* clipboard may be unavailable in tests */
    }
  }

  const present = () => {
    const el = contentRef.current
    if (el?.requestFullscreen) void el.requestFullscreen()
  }

  const waiting = view.isPending || (view.isPlaceholderData && !metricGroup)
  let chartArea
  if (view.isError) {
    chartArea = (
      <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        <p>We couldn’t load this chart: {view.error.message}</p>
        <button
          type="button"
          className="mt-2 rounded border border-ink/40 bg-white px-2 py-1 text-sm font-medium"
          onClick={() => void view.refetch()}
        >
          Try again
        </button>
      </div>
    )
  } else if (waiting) {
    chartArea = <div className={`mt-4 ${FOCUS_CHART_HEIGHT}`} aria-busy="true" />
  } else if (!chartRow) {
    chartArea = <p role="alert">This metric has no rows for this selection.</p>
  } else {
    chartArea = (
      <>
        <div className="mt-4" aria-busy={view.isPlaceholderData || undefined}>
          <MetricChart
            size="focus"
            row={chartRow}
            chartRows={chartRows}
            childRows={children}
            columns={trendColumns}
            currentColumnKey={columnKey}
            currentDisplay={cell?.display ?? ''}
            currentStatus={atScope?.status ?? ''}
            statusLabel={statusLabel}
            scale={statusColors}
            tableTo={tableLink}
            scopeNote={atScope?.caption || undefined}
          />
        </div>

        {rankedChildren.length > 0 && (
          <section aria-label="Org breakdown" className="mt-6">
            <h3 className="text-sm font-semibold text-accent-deep">Breakdown</h3>
            <ul className="mt-2 space-y-1">
              {rankedChildren.map(({ row: ch, cell: c }) => {
                const content = (
                  <>
                    <span className="font-medium">{ch.subjectName}</span>
                    <span className="ml-2 tabular-nums">{c?.display || '—'}</span>
                    {c?.status && <span className="ml-2">{c.status}</span>}
                  </>
                )
                return (
                  <li key={ch.subjectId}>
                    {ch.subjectKind === 'item' ? (
                      <p className="rounded border border-ink/20 px-3 py-2 text-sm">{content}</p>
                    ) : (
                      <button
                        type="button"
                        className="w-full rounded border border-ink/20 px-3 py-2 text-left text-sm hover:bg-cream"
                        onClick={() => updatePeriod({ scope: ch.subjectId })}
                      >
                        {content}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <p className="mt-4">
          <Link to={tableLink} className="text-sm font-medium text-accent-deep hover:underline" onClick={onClose}>
            View as table
          </Link>
        </p>
      </>
    )
  }

  return (
    <div className="min-h-0">
      <div className="flex flex-wrap gap-2 border-b border-ink/15 pb-3">
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={() => void exportPng()}>
          Export PNG
        </button>
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={exportSvg}>
          Export SVG
        </button>
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={exportCsv}>
          Export CSV
        </button>
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={present}>
          Present
        </button>
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={() => void copyLink()}>
          Copy link
        </button>
        <button type="button" disabled aria-label="Ask SAM (coming soon)" className="rounded border border-ink/20 px-2 py-1 text-sm opacity-60">
          Ask SAM
        </button>
      </div>
      {exportError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          {exportError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink/80">Period window</span>
        <button
          type="button"
          aria-pressed={windowMonths === 12}
          className="rounded border border-ink/20 px-2 py-0.5 text-sm hover:bg-cream"
          onClick={() => setWindowMonths(12)}
        >
          12
        </button>
        <button
          type="button"
          aria-pressed={windowMonths === 24}
          className="rounded border border-ink/20 px-2 py-0.5 text-sm hover:bg-cream"
          onClick={() => setWindowMonths(24)}
        >
          24
        </button>
        <div className="ml-auto flex gap-2">
          <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={() => setFocus(prevId!)}>
            Previous metric
          </button>
          <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={() => setFocus(nextId!)}>
            Next metric
          </button>
        </div>
      </div>
      <p role="status" className="mt-1 min-h-5 text-sm text-ink/80">
        {waiting || view.isPlaceholderData ? 'Loading chart…' : ''}
      </p>

      {chartArea}
    </div>
  )
}

/** Full-screen focus dialog for a metric chart or the scorecard table. */
export function FocusDialog() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const scorecards = useScorecards()
  const scorecardName = scorecards.data?.scorecards.find((s) => s.id === scorecardId)?.name ?? 'Scorecard'
  const focusId = params.get('focus') ?? ''
  const open = focusId !== ''

  const { request: layoutRequest, ready } = useScorecardViewRequest()
  const layoutView = useView(ready && open && focusId !== 'table' ? scorecardId : undefined, layoutRequest)
  const metricIds = layoutView.data ? metricKeysInLayout(layoutView.data) : []

  const contentRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('focus')
      return next
    })
  }, [setParams])

  const title =
    focusId === 'table' ? `${scorecardName} table` : layoutView.data?.rows.find((r) => r.metricKey === focusId)?.metricName ?? focusId

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/50" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (focusReturnRef.current) {
              e.preventDefault()
              focusReturnRef.current.focus()
              focusReturnRef.current = null
            }
          }}
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg bg-cream p-6 shadow-xl md:inset-8"
        >
          <Dialog.Title className="pr-10 text-xl font-semibold text-accent-deep">{title}</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" className="absolute right-4 top-4 rounded-md p-1 hover:bg-white">
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>
          <div ref={contentRef} className="mt-4 min-h-0 flex-1 overflow-y-auto">
            {focusId === 'table' ? (
              <TablePage
                scorecardId={scorecardId}
                scorecardName={scorecardName}
                measureWidth={1600}
                embeddedInFocus
              />
            ) : focusId ? (
              <MetricFocusBody metricKey={focusId} metricIds={metricIds} onClose={close} contentRef={contentRef} />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
