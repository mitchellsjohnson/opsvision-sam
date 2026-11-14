import clsx from 'clsx'
import { Fragment, useMemo, useState } from 'react'
import { Link, type To } from 'react-router'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
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
import { statusIntervals } from './bands'
import { chartTheme, type StatusTheme } from './chartTheme'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type CellT = Schemas['Cell']

/**
 * The plot height in the full-screen dialog: at least half the viewport, and
 * the viewport less room for the dialog's title and controls (64vh at 1080px).
 */
export const FOCUS_CHART_HEIGHT = 'h-[max(50vh,calc(100vh_-_24rem))]'

/** `tile` is the Overview card; `focus` fills the full-screen dialog. */
export type ChartSize = 'tile' | 'focus'

interface SizeSpec {
  className: string
  style: { height: number } | undefined
  height: number | '100%'
  initial: { width: number; height: number }
  tick: number
  letter: number
  dot: number
}

function sizeSpec(size: ChartSize, tileHeight: number): SizeSpec {
  return size === 'focus'
    ? { className: FOCUS_CHART_HEIGHT, style: undefined, height: '100%', initial: { width: 960, height: 480 }, tick: 13, letter: 12, dot: 5 }
    : { className: '', style: { height: tileHeight }, height: tileHeight, initial: { width: 300, height: tileHeight }, tick: 10, letter: 9, dot: 3.5 }
}

export interface MetricChartProps {
  row: ViewRow
  /** When the scope cell is missing, one trend line per child row. */
  chartRows?: ViewRow[]
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
  size?: ChartSize
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

function yDomain(points: PointRow[], target: number | null, extra: number[] = []): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  for (const v of extra) values.push(v)
  if (values.length === 0) return [0, 100]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

function moneyDomain(points: PointRow[]): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  const max = Math.max(100, ...(values.length ? values : [0]))
  return [0, max * 1.05]
}

function StatusMarker({ theme, title }: { theme: StatusTheme; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 text-sm font-semibold ${theme.letterClass}`}
      style={{ color: theme.letterClass ? undefined : theme.color }}
    >
      <span aria-hidden="true">{theme.shape}</span>
      <span>{theme.letter}</span>
    </span>
  )
}

interface DotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: Record<string, unknown>
}

/** A line point drawn as a ring with its status letter above it, so status never rests on color. */
function StatusDot({
  cx,
  cy,
  index,
  payload,
  statusKey,
  scale,
  r = 3.5,
  fontSize = 9,
}: DotProps & { statusKey: string; scale: components['schemas']['StatusLevel'][]; r?: number; fontSize?: number }) {
  const status = typeof payload?.[statusKey] === 'string' ? (payload[statusKey] as string) : ''
  if (cx == null || cy == null || !status) return <g key={`dot-${statusKey}-${index}`} />
  const theme = chartTheme(scale, status)
  return (
    <g key={`dot-${statusKey}-${index}`} data-status-dot={status}>
      <circle cx={cx} cy={cy} r={r} fill="#FFFFFF" stroke={theme.color} strokeWidth={1.5} />
      <text x={cx} y={cy - r - 3.5} textAnchor="middle" fontSize={fontSize} fontWeight={600} fill="var(--color-ink)">
        {status}
      </text>
    </g>
  )
}

function PointButtons({ points, onSelect, prefix }: { points: PointRow[]; onSelect: (p: PointRow) => void; prefix?: string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {points.map((p) => {
        const label =
          p.kind === 'na'
            ? `${prefix ?? ''}${p.label}: n/a: ${p.naReason || 'Not applicable'}`
            : p.kind === 'missing'
              ? `${prefix ?? ''}${p.label}: no data`
              : `${prefix ?? ''}${p.label}: ${p.display}${p.overrideReason ? ' †' : ''}`
        return (
          <button
            key={p.key}
            type="button"
            className="rounded border border-ink/20 px-1.5 py-0.5 text-xs hover:bg-cream"
            onClick={() => onSelect(p)}
            aria-label={label}
          >
            {p.kind === 'na' ? 'n/a' : p.kind === 'missing' ? 'no data' : p.display || '—'}
            {p.overrideReason && <span aria-hidden="true"> †</span>}
            {p.kind === 'value' && p.status && <span className="sr-only">, status {p.status}</span>}
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
  chartRows,
  columns,
  scale,
  target,
  animated,
  size,
}: {
  row: ViewRow
  chartRows: ViewRow[]
  columns: Column[]
  scale: components['schemas']['StatusLevel'][]
  target: number | null
  animated: boolean
  size: ChartSize
}) {
  const spec = sizeSpec(size, 120)
  const [tip, setTip] = useState<PointRow | null>(null)
  const series = useMemo(
    () => chartRows.map((r) => ({ row: r, points: buildPoints(r, columns) })),
    [chartRows, columns],
  )
  const flatPoints = series.flatMap((s) => s.points)
  const domain = yDomain(flatPoints, target)
  const currentCell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const lastIndex = columns.length - 1
  const currentPoint = series.length === 1 ? series[0]!.points[lastIndex] : undefined

  const data = columns.map((col, i) => {
    const entry: Record<string, string | number | null> = { label: col.label, key: col.key }
    for (const { row: r, points } of series) {
      const p = points[i]!
      entry[`plot_${r.subjectId}`] = p.kind === 'value' ? p.value : null
      entry[`status_${r.subjectId}`] = p.kind === 'value' ? p.status : ''
    }
    if (series.length === 1) {
      const p = series[0]!.points[i]!
      entry.plot = p.kind === 'value' ? p.value : null
      entry.status = p.kind === 'value' ? p.status : ''
    }
    return entry
  })

  return (
    <div>
      <div
        data-testid="metric-chart"
        data-size={size}
        data-bands={rects.map((r) => `${r.status}:${r.y0}-${r.y1}`).join(' ')}
        aria-hidden="true"
        className={clsx('text-accent-deep', spec.className)}
        style={spec.style}
      >
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <ComposedChart
            data={data}
            margin={size === 'focus' ? { top: 24, right: 16, bottom: 8, left: 8 } : { top: 16, right: 8, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-ink)" strokeOpacity={0.08} />
            <XAxis dataKey="label" tick={{ fontSize: spec.tick }} />
            {size === 'focus' ? (
              <YAxis
                domain={domain}
                tick={{ fontSize: spec.tick }}
                tickFormatter={(v: number) => formatMetricValue(row.format, v)}
                width={72}
              />
            ) : (
              <YAxis hide domain={domain} />
            )}
            {rects.map((r, i) => {
              const theme = chartTheme(scale, r.status)
              return (
                <ReferenceArea
                  key={`band-${i}`}
                  y1={r.y0}
                  y2={r.y1}
                  fill={theme.color}
                  fillOpacity={0.15}
                  stroke={theme.color}
                  strokeWidth={1}
                  label={{ value: r.status, position: 'insideLeft', fontSize: spec.letter, fontWeight: 600, fill: 'var(--color-ink)', className: 'band-label' }}
                />
              )
            })}
            {target !== null && (
              <ReferenceLine
                y={target}
                stroke="var(--color-ink)"
                strokeDasharray="4 3"
                strokeWidth={1}
                label={{
                  value: `Goal ${formatMetricValue(row.format, target)}`,
                  position: 'insideTopRight',
                  fontSize: spec.tick,
                  fill: 'var(--color-ink)',
                }}
              />
            )}
            {series.map(({ row: r }) => (
              <Line
                key={r.subjectId}
                type="linear"
                dataKey={series.length === 1 ? 'plot' : `plot_${r.subjectId}`}
                stroke="currentColor"
                strokeWidth={2}
                dot={(props: DotProps) => (
                  <StatusDot
                    {...props}
                    key={`dot-${r.subjectId}-${props.index}`}
                    statusKey={series.length === 1 ? 'status' : `status_${r.subjectId}`}
                    scale={scale}
                    r={spec.dot}
                    fontSize={spec.letter}
                  />
                )}
                activeDot={{ r: spec.dot + 1.5 }}
                isAnimationActive={animated}
                connectNulls={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {currentPoint?.kind === 'value' && (
        <p data-testid="current-point-label" className="text-xs text-ink/80">
          Current: {currentPoint.display}{' '}
          <StatusMarker theme={chartTheme(scale, currentPoint.status)} />
        </p>
      )}
      {series.map(({ row: r, points }) => (
        <Fragment key={r.subjectId}>
          {series.length > 1 && <p className="mt-2 text-xs font-medium text-ink/80">{r.subjectName}</p>}
          <PointButtons
            points={points}
            onSelect={setTip}
            prefix={series.length > 1 ? `${r.subjectName} ` : undefined}
          />
        </Fragment>
      ))}
      <div role="status" className="mt-1 min-h-6 text-sm text-ink/80">
        <ChartTooltip point={tip} scale={scale} />
      </div>
    </div>
  )
}

interface BarChartProps {
  points: PointRow[]
  scale: components['schemas']['StatusLevel'][]
  animated: boolean
  size: ChartSize
}

function DiscreteChart({ points, scale, animated, size }: BarChartProps) {
  const spec = sizeSpec(size, 100)
  const [tip, setTip] = useState<PointRow | null>(null)
  const data = points.map((p) => ({ ...p, h: p.kind === 'value' ? p.value ?? 0 : 0, letter: p.kind === 'value' ? p.status : '' }))
  return (
    <div>
      <div data-testid="metric-chart" data-size={size} aria-hidden="true" className={spec.className} style={spec.style}>
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} margin={{ top: 14, right: 4, bottom: 4, left: 4 }}>
            <XAxis dataKey="label" tick={{ fontSize: spec.tick }} />
            <YAxis hide />
            <Bar dataKey="h" isAnimationActive={animated}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'var(--color-ink)'} fillOpacity={p.kind === 'value' ? 1 : 0.1} />
              ))}
              <LabelList dataKey="letter" position="top" fontSize={spec.tick} fontWeight={600} fill="var(--color-ink)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <PointButtons points={points} onSelect={setTip} />
      <ChartTooltip point={tip} scale={scale} />
    </div>
  )
}

function MoneyPlanChart({ points, scale, animated, size }: BarChartProps) {
  const spec = sizeSpec(size, 100)
  const [tip, setTip] = useState<PointRow | null>(null)
  const data = points.map((p) => ({ ...p, h: p.kind === 'value' ? p.value ?? 0 : null, letter: p.kind === 'value' ? p.status : '' }))
  const domain = moneyDomain(points)
  return (
    <div>
      <div data-testid="metric-chart" data-size={size} aria-hidden="true" className={spec.className} style={spec.style}>
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} margin={{ top: 14, right: 4, bottom: 4, left: 4 }}>
            <XAxis dataKey="label" tick={{ fontSize: spec.tick }} />
            <YAxis hide domain={domain} />
            <ReferenceLine y={100} stroke="var(--color-ink)" strokeWidth={1} ifOverflow="extendDomain" label={{ value: '100%', fontSize: spec.tick }} />
            <Bar dataKey="h" isAnimationActive={animated}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'transparent'} />
              ))}
              <LabelList dataKey="letter" position="top" fontSize={spec.tick} fontWeight={600} fill="var(--color-ink)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <PointButtons points={points} onSelect={setTip} />
      <div role="status" className="mt-1 min-h-6 text-sm text-ink/80">
        <ChartTooltip point={tip} scale={scale} />
      </div>
    </div>
  )
}

function UptimeRows({
  childRows,
  columns,
  currentColumnKey,
  scale,
}: {
  childRows: ViewRow[]
  columns: Column[]
  currentColumnKey: string
  scale: components['schemas']['StatusLevel'][]
}) {
  return (
    <ul className="space-y-2 text-sm">
      {childRows.map((child) => {
        const cell = child.cells.find((c) => cellKey(c) === currentColumnKey)
        const theme = chartTheme(scale, cell?.status ?? '')
        const statuses = columns.map((col) => child.cells.find((c) => cellKey(c) === col.key))
        return (
          <li key={child.subjectId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-24">{child.subjectName}</span>
            <span className="flex gap-0.5" data-testid={`uptime-strip-${child.subjectId}`}>
              {statuses.map((c, i) => {
                const col = columns[i]!
                const status = c?.status && c.naReason === '' ? c.status : ''
                const label = !c
                  ? `${col.fullLabel}: no data`
                  : c.naReason
                    ? `${col.fullLabel}: not applicable, ${c.naReason}`
                    : `${col.fullLabel}: ${c.display || 'no data'}${status ? `, status ${status}` : ''}`
                return (
                  <span key={col.key} role="img" aria-label={label}>
                    <StatusMarker theme={chartTheme(scale, status)} />
                  </span>
                )
              })}
            </span>
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
  chartRows,
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
  size = 'tile',
}: MetricChartProps) {
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const lines = chartRows ?? [row]
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
        <UptimeRows childRows={childRows} columns={columns} currentColumnKey={currentColumnKey} scale={scale} />
      ) : kind === 'sparse' ? (
        <LetteredChips points={points} scale={scale} />
      ) : kind === 'discrete' ? (
        <DiscreteChart points={points} scale={scale} animated={animated} size={size} />
      ) : kind === 'money_plan' ? (
        <MoneyPlanChart points={points} scale={scale} animated={animated} size={size} />
      ) : (
        <RatioChart row={row} chartRows={lines} columns={columns} scale={scale} target={target} animated={animated} size={size} />
      )}
      <p className="mt-2">
        <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
          View as table
        </Link>
      </p>
    </div>
  )
}
