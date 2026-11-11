import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMe, useScorecards, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import type { ViewRequest } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { defaultStatusScale } from './charts/chartTheme'
import { MetricChart } from './charts/MetricChart'
import { buildMonthTrendColumns, buildTrendColumns, columnRequest, type Column } from './columns'
import { focusReturnRef } from './focusTrigger'
import { defaultLayout } from './logic/layout'
import { cellReported, statusAtScope, type StatusScaleEntry } from './logic/statusAtScope'
import { TablePage } from './TablePage'
import { cellKey, groupRows } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']

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

function shallowest(rows: ViewRow[]): ViewRow {
  return rows.reduce((best, r) => (r.depth < best.depth ? r : best))
}

function childRows(rows: ViewRow[], scope: ViewRow): ViewRow[] {
  return rows.filter((r) => r.depth === scope.depth + 1)
}

function downloadBlob(filename: string, mime: string, body: string | Blob) {
  const blob = body instanceof Blob ? body : new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function chartCsv(columns: Column[], chartRows: ViewRow[]): string {
  const lines = ['subject,period,value,status']
  for (const row of chartRows) {
    for (const col of columns) {
      const cell = row.cells.find((c) => cellKey(c) === col.key)
      const value = cell?.value ?? ''
      const status = cell?.status ?? ''
      lines.push(`${row.subjectName},${col.period},${value},${status}`)
    }
  }
  return lines.join('\n')
}

function chartSvg(title: string, columns: Column[], chartRows: ViewRow[]): string {
  const allValues = chartRows.flatMap((row) =>
    columns
      .map((col) => row.cells.find((c) => cellKey(c) === col.key)?.value)
      .filter((v): v is number => v != null),
  )
  const min = allValues.length ? Math.min(...allValues) : 0
  const max = allValues.length ? Math.max(...allValues) : 100
  const span = max - min || 1
  const strokes = ['#1D2433', '#5B4BDB', '#0E7490', '#B45309']
  const polylines: string[] = []
  const letters: string[] = []
  const legends: string[] = []
  chartRows.forEach((row, rowIndex) => {
    const points: Array<{ x: number; y: number; status: string }> = []
    columns.forEach((col, i) => {
      const cell = row.cells.find((c) => cellKey(c) === col.key)
      const v = cell?.value
      if (v == null) return
      const x = 40 + (i / Math.max(columns.length - 1, 1)) * 520
      const y = 200 - ((v - min) / span) * 160
      points.push({ x, y, status: cell?.status ?? '' })
    })
    if (points.length === 0) return
    const color = strokes[rowIndex % strokes.length]!
    polylines.push(
      `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" />`,
    )
    for (const p of points) {
      if (p.status) letters.push(`<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" font-size="12">${p.status}</text>`)
    }
    if (chartRows.length > 1) {
      legends.push(`<text x="20" y="${44 + rowIndex * 16}" font-size="12" fill="${color}">${row.subjectName}</text>`)
    }
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240">
  <title>${title}</title>
  <text x="20" y="24" font-size="16" font-weight="600">${title}</text>
  ${legends.join('\n  ')}
  ${polylines.join('\n  ')}
  ${letters.join('\n  ')}
</svg>`
}

async function metricPng(svg: string, filename: string) {
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = 600
  canvas.height = 240
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0)
  URL.revokeObjectURL(url)
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(filename, 'image/png', blob)
  }, 'image/png')
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
  const me = useMe()
  const fy = period.fiscalYearStartMonth
  const scale: StatusScaleEntry[] = useMemo(
    () =>
      me.data?.tenant?.statusScale?.map((s) => ({ key: s.key, rank: s.rank })) ??
      defaultStatusScale().map((s) => ({ key: s.key, rank: s.rank })),
    [me.data?.tenant?.statusScale],
  )
  const statusColors = me.data?.tenant?.statusScale ?? defaultStatusScale()
  const statusLabel = (key: string) => statusColors.find((s) => s.key === key)?.label

  const trendColumns = useMemo(
    () =>
      windowMonths === 24
        ? buildMonthTrendColumns(period.period, 24, fy)
        : buildTrendColumns(period.period, fy),
    [period.period, fy, windowMonths],
  )
  const trendRequest: ViewRequest = { ...columnRequest(trendColumns) }
  if (period.subjects.length > 0) trendRequest.subjects = period.subjects

  const view = useView(period.ready ? scorecardId : undefined, trendRequest)
  const selectedColumn = trendColumns[trendColumns.length - 1]
  const columnKey = selectedColumn?.key ?? ''

  const groups = view.data ? groupRows(view.data) : []
  const metricGroup = groups.flatMap((g) => g.metrics).find((m) => m.key === metricKey)
  const scope = metricGroup ? shallowest(metricGroup.rows) : undefined
  const children = scope ? childRows(metricGroup!.rows, scope) : []
  const cell = scope?.cells.find((c) => cellKey(c) === columnKey)
  const scopeReported = cellReported(cell)
  const reportedChildren = children.filter((ch) => cellReported(ch.cells.find((c) => cellKey(c) === columnKey)))
  const chartChildren = !scopeReported && reportedChildren.length > 0
  const chartRows = chartChildren ? reportedChildren : scope ? [scope] : []
  const atScope = scope
    ? statusAtScope({
        scope,
        children,
        columnKey,
        scale,
        noun: children.length > 0 ? 'segments' : 'items',
      })
    : null

  const rankedChildren = useMemo(() => {
    return [...children]
      .map((ch) => {
        const c = ch.cells.find((x) => cellKey(x) === columnKey)
        const rank = scale.find((s) => s.key === c?.status)?.rank ?? -1
        return { row: ch, cell: c, rank }
      })
      .filter((x) => x.cell && cellReported(x.cell))
      .sort((a, b) => b.rank - a.rank)
  }, [children, columnKey, scale])

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
    if (!scope || chartRows.length === 0) return
    downloadBlob(`${scope.metricKey}.csv`, 'text/csv', chartCsv(trendColumns, chartRows))
  }

  const exportSvg = () => {
    if (!scope || chartRows.length === 0) return
    downloadBlob(`${scope.metricKey}.svg`, 'image/svg+xml', chartSvg(scope.metricName, trendColumns, chartRows))
  }

  const exportPng = async () => {
    if (!scope || chartRows.length === 0) return
    await metricPng(chartSvg(scope.metricName, trendColumns, chartRows), `${scope.metricKey}.png`)
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

  if (view.isPending) return <p role="status">Loading…</p>
  if (!scope || !metricGroup) {
    return <p role="alert">Could not load this metric.</p>
  }

  return (
    <div className="min-h-0">
      <div className="flex flex-wrap gap-2 border-b border-ink/15 pb-3">
        <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-cream" onClick={exportPng}>
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

      <div className="mt-4" style={{ minHeight: 280 }}>
        <MetricChart
          row={scope}
          chartRows={chartRows}
          childRows={children}
          columns={trendColumns}
          currentColumnKey={columnKey}
          currentDisplay={cell?.display ?? ''}
          currentStatus={atScope?.status ?? ''}
          statusLabel={statusLabel}
          scale={statusColors}
          tableTo={tableLink}
        />
      </div>

      {rankedChildren.length > 0 && (
        <section aria-label="Org breakdown" className="mt-6">
          <h3 className="text-sm font-semibold text-accent-deep">Breakdown</h3>
          <ul className="mt-2 space-y-1">
            {rankedChildren.map(({ row: ch, cell: c }) => (
              <li key={ch.subjectId}>
                <button
                  type="button"
                  className="w-full rounded border border-ink/20 px-3 py-2 text-left text-sm hover:bg-cream"
                  onClick={() => updatePeriod({ scope: ch.subjectId })}
                >
                  <span className="font-medium">{ch.subjectName}</span>
                  <span className="ml-2 tabular-nums">{c?.display || '—'}</span>
                  {c?.status && <span className="ml-2">{c.status}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-4">
        <Link to={tableLink} className="text-sm font-medium text-accent-deep hover:underline" onClick={onClose}>
          View as table
        </Link>
      </p>
    </div>
  )
}

/** Full-screen focus dialog for a metric chart or the scorecard table. */
export function FocusDialog() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const [period] = usePeriodState()
  const scorecards = useScorecards()
  const scorecardName = scorecards.data?.scorecards.find((s) => s.id === scorecardId)?.name ?? 'Scorecard'
  const focusId = params.get('focus') ?? ''
  const open = focusId !== ''

  const layoutRequest: ViewRequest = useMemo(() => {
    const cols = buildTrendColumns(period.period, period.fiscalYearStartMonth)
    const req: ViewRequest = { ...columnRequest(cols) }
    if (period.subjects.length > 0) req.subjects = period.subjects
    return req
  }, [period])
  const layoutView = useView(period.ready && open && focusId !== 'table' ? scorecardId : undefined, layoutRequest)
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
