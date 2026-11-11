import { useMemo, useState } from 'react'
import { Link, type To } from 'react-router'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import type { components } from '../../../api/schema'
import { usePrefersReducedMotion } from '../../../ui/Sparkline'
import type { Column } from '../columns'
import { formatMetricValue, overrideSentence } from '../format'
import { cellKey } from '../viewHelpers'
import { chartTheme, type StatusTheme } from './chartTheme'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type CellT = Schemas['Cell']
type Band = Schemas['Band']

export interface MetricChartProps {
  row: ViewRow
  childRows?: ViewRow[]
  columns: Column[]
  currentColumnKey: string
  currentDisplay: string
  currentStatus: string
  statusLabel: (key: string) => string | undefined
  scale: components['schemas']['StatusLevel'][]
  tableTo: To
  scopeNote?: string
  ytdDisplay?: string | null
}

interface PointRow {
  key: string
  label: string
  value: number | null
  display: string
  status: string
  naReason: string
  overrideReason: string
  kind: 'value' | 'na' | 'missing'
}

function cellsByKey(row: ViewRow): Map<string, CellT> {
  return new Map(row.cells.map((c) => [cellKey(c), c]))
}

function pointKind(cell: CellT | undefined): PointRow['kind'] {
  if (!cell) return 'missing'
  if (cell.naReason !== '') return 'na'
  if (cell.value == null && cell.status === '') return 'missing'
  return 'value'
}

function buildPoints(row: ViewRow, columns: Column[]): PointRow[] {
  const byKey = cellsByKey(row)
  return columns.map((col) => {
    const cell = byKey.get(col.key)
    const kind = pointKind(cell)
    return {
      key: col.key,
      label: col.label,
      value: kind === 'value' ? (cell?.value ?? null) : null,
      display: cell?.display ?? '',
      status: cell?.status ?? '',
      naReason: cell?.naReason ?? '',
      overrideReason: cell?.override ? overrideSentence(cell.override) : '',
      kind,
    }
  })
}

function sparseOverride(kind: string, columns: Column[], points: PointRow[]): boolean {
  if (kind === 'discrete') return false
  if (columns.length < 4) return false
  let na = 0
  let valued = 0
  for (const p of points) {
    if (p.kind === 'na') na++
    else if (p.kind === 'value') valued++
  }
  return na > valued
}

function bandRects(bands: Band[] | undefined, direction: ViewRow['direction'], yDomain: [number, number]): Array<{ y0: number; y1: number; status: string }> {
  if (!bands?.length) return []
  const sorted = [...bands].sort((a, b) => a.value - b.value)
  const rects: Array<{ y0: number; y1: number; status: string }> = []
  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]!
    const next = sorted[i + 1]
    const y0 = band.value
    const y1 = next?.value ?? yDomain[1]
    if (direction === 'higher_better') rects.push({ y0, y1, status: band.status })
    else rects.push({ y0: Math.min(y0, y1), y1: Math.max(y0, y1), status: band.status })
  }
  return rects
}

function yDomain(points: PointRow[], target: number | null): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  if (values.length === 0) return [0, 100]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

function StatusMarker({ theme, title }: { theme: StatusTheme; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-0.5 text-sm font-semibold ${theme.letterClass}`} style={{ color: theme.letterClass ? undefined : theme.color }}>
      <span aria-hidden="true">{theme.shape}</span>
      <span>{theme.letter}</span>
    </span>
  )
}

function PointButtons({ points, onSelect }: { points: PointRow[]; onSelect: (p: PointRow) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {points.map((p) => {
        const label =
          p.kind === 'na'
            ? `n/a: ${p.naReason || 'Not applicable'}`
            : p.kind === 'missing'
              ? `${p.label}: no data`
              : `${p.label}: ${p.display}${p.overrideReason ? ' †' : ''}`
        return (
          <button
            key={p.key}
            type="button"
            className="rounded border border-ink/20 px-1.5 py-0.5 text-xs hover:bg-cream"
            onClick={() => onSelect(p)}
            aria-label={label}
          >
            {p.kind === 'na' ? 'n/a' : p.kind === 'missing' ? 'no data' : p.display || '—'}
            {p.kind === 'value' && p.status && (
              <span className="sr-only">, status {p.status}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function ChartTooltip({ point, scale }: { point: PointRow | null; scale: components['schemas']['StatusLevel'][] }) {
  if (!point) return null
  if (point.kind === 'na') return <p className="text-sm">{point.naReason || 'Not applicable'}</p>
  if (point.kind === 'missing') return <p className="text-sm">No data</p>
  const theme = chartTheme(scale, point.status)
  return (
    <div className="text-sm">
      <p>
        {point.display} <StatusMarker theme={theme} />
      </p>
      {point.overrideReason && <p>† {point.overrideReason}</p>}
    </div>
  )
}

function RatioChart({
  row,
  columns,
  points,
  scale,
  target,
  animated,
}: {
  row: ViewRow
  columns: Column[]
  points: PointRow[]
  scale: components['schemas']['StatusLevel'][]
  target: number | null
  animated: boolean
}) {
  const [tip, setTip] = useState<PointRow | null>(null)
  const domain = yDomain(points, target)
  const currentCell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = bandRects(bands, row.direction, domain)

  const data = points.map((p) => ({
    ...p,
    plot: p.kind === 'value' ? p.value : null,
  }))

  return (
    <div>
      <div data-testid="metric-chart" aria-hidden="true" className="text-accent-deep" style={{ height: 120 }}>
        <ResponsiveContainer width="100%" height={120} initialDimension={{ width: 300, height: 120 }}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-ink)" strokeOpacity={0.08} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis hide domain={domain} />
            {rects.map((r, i) => {
              const theme = chartTheme(scale, r.status)
              return (
                <ReferenceLine
                  key={`band-${i}`}
                  y={r.y0}
                  stroke={theme.color}
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  ifOverflow="extendDomain"
                />
              )
            })}
            {target !== null && (
              <ReferenceLine
                y={target}
                stroke="var(--color-ink)"
                strokeDasharray="4 3"
                strokeWidth={1}
                label={{ value: `Goal ${formatMetricValue(row.format, target)}`, position: 'insideTopRight', fontSize: 10, fill: 'var(--color-ink)' }}
              />
            )}
            <Line type="linear" dataKey="plot" stroke="currentColor" strokeWidth={2} dot={false} isAnimationActive={animated} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <PointButtons points={points} onSelect={setTip} />
      <div role="status" className="mt-1 min-h-6 text-sm text-ink/80">
        <ChartTooltip point={tip} scale={scale} />
      </div>
    </div>
  )
}

function DiscreteChart({ points, scale, animated }: { points: PointRow[]; scale: components['schemas']['StatusLevel'][]; animated: boolean }) {
  const [tip, setTip] = useState<PointRow | null>(null)
  const data = points.map((p) => ({ ...p, h: p.kind === 'value' ? p.value ?? 0 : 0 }))
  return (
    <div>
      <div aria-hidden="true" style={{ height: 100 }}>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis hide />
            <Bar dataKey="h" isAnimationActive={animated}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'var(--color-ink)'} fillOpacity={p.kind === 'value' ? 0.35 : 0.1} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <PointButtons points={points} onSelect={setTip} />
      <ChartTooltip point={tip} scale={scale} />
    </div>
  )
}

function MoneyPlanChart({ points, scale, animated }: { points: PointRow[]; scale: components['schemas']['StatusLevel'][]; animated: boolean }) {
  const data = points.map((p) => ({ ...p, h: p.kind === 'value' ? p.value ?? 0 : 0 }))
  return (
    <div aria-hidden="true" style={{ height: 100 }}>
      <ResponsiveContainer width="100%" height={100}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
          <YAxis hide domain={[0, 'auto']} />
          <ReferenceLine y={100} stroke="var(--color-ink)" strokeWidth={1} label={{ value: '100%', fontSize: 10 }} />
          <Bar dataKey="h" isAnimationActive={animated}>
            {data.map((p) => (
              <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'transparent'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function UptimeRows({
  childRows,
  currentColumnKey,
  scale,
}: {
  childRows: ViewRow[]
  currentColumnKey: string
  scale: components['schemas']['StatusLevel'][]
}) {
  return (
    <ul className="space-y-1 text-sm">
      {childRows.map((child) => {
        const cell = child.cells.find((c) => cellKey(c) === currentColumnKey)
        const theme = chartTheme(scale, cell?.status ?? '')
        return (
          <li key={child.subjectId} className="flex items-center justify-between gap-2">
            <span>{child.subjectName}</span>
            <span className="flex items-center gap-2">
              <StatusMarker theme={theme} />
              <span className="font-medium tabular-nums">{cell?.display || '—'}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function LetteredChips({ points, scale }: { points: PointRow[]; scale: components['schemas']['StatusLevel'][] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {points.map((p) => {
        const theme = chartTheme(scale, p.status)
        return (
          <span key={p.key} className="inline-flex items-center gap-1 rounded border border-ink/20 px-2 py-1 text-xs">
            <span className="text-ink/70">{p.label}</span>
            {p.kind === 'na' ? (
              <span>n/a</span>
            ) : p.kind === 'missing' ? (
              <span className="text-ink/60">no data</span>
            ) : (
              <>
                <span>{p.display}</span>
                <StatusMarker theme={theme} />
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** Renders the chart for one metric row and encodings required by the UX spec. */
export function MetricChart({
  row,
  childRows = [],
  columns,
  currentColumnKey,
  currentDisplay,
  currentStatus,
  statusLabel,
  scale,
  tableTo,
  scopeNote,
  ytdDisplay,
}: MetricChartProps) {
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const points = useMemo(() => buildPoints(row, columns), [row, columns])
  const kind = sparseOverride(row.chartKind, columns, points) ? 'sparse' : row.chartKind
  const currentCell = row.cells.find((c) => cellKey(c) === currentColumnKey)
  const target = currentCell?.target ?? null
  const theme = chartTheme(scale, currentStatus)
  const summary = `${row.metricName}: ${currentDisplay || 'no data'}, status ${currentStatus || 'none'}`

  return (
    <div>
      <p className="sr-only">{summary}</p>
      {scopeNote && <p className="text-xs text-ink/80">{scopeNote}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-xl font-semibold tabular-nums">{currentDisplay || '—'}</span>
        {currentStatus && <StatusMarker theme={theme} title={statusLabel(currentStatus)} />}
        {ytdDisplay && <span className="text-sm text-ink/80">{ytdDisplay}</span>}
      </div>
      {kind === 'uptime' ? (
        <UptimeRows childRows={childRows} currentColumnKey={currentColumnKey} scale={scale} />
      ) : kind === 'sparse' ? (
        <LetteredChips points={points} scale={scale} />
      ) : kind === 'discrete' ? (
        <DiscreteChart points={points} scale={scale} animated={animated} />
      ) : kind === 'money_plan' ? (
        <MoneyPlanChart points={points} scale={scale} animated={animated} />
      ) : (
        <RatioChart row={row} columns={columns} points={points} scale={scale} target={target} animated={animated} />
      )}
      <p className="mt-2">
        <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
          View as table
        </Link>
      </p>
    </div>
  )
}
