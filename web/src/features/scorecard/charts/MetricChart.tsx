import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { Link, type To } from 'react-router'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useYAxisScale,
} from 'recharts'
import type { components } from '../../../api/schema'
import { usePrefersReducedMotion } from '../../../ui/Sparkline'
import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { cellKey } from '../viewHelpers'
import { statusIntervals } from './bands'
import { chartTheme, LINE_COLORS, MOVE_CLASS, statusFill, type Move, type StatusTheme } from './chartTheme'
import { buildPoints, headerChange, type ChartPoint } from './points'
import { isSparse } from './sparse'

export { buildPoints, type ChartPoint } from './points'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

/**
 * The plot height in the full-screen dialog: at least half the viewport, and
 * the viewport less room for the dialog's title and controls above and the
 * status ribbon and range strip below (60vh at 1080px).
 */
export const FOCUS_CHART_HEIGHT = 'h-[max(50vh,calc(100vh_-_27rem))]'

/** `tile` is the Overview card; `focus` fills the full-screen dialog. */
export type ChartSize = 'tile' | 'focus'

interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

interface SizeSpec {
  className: string
  style: { height: number } | undefined
  height: number | '100%'
  initial: { width: number; height: number }
  tick: number
  stroke: number
  /** Radius of the current point's dot, and of the hovered point's. */
  dot: number
  activeDot: number
  margin: Margin
  xAxisHeight: number
  maxBar: number
}

function sizeSpec(size: ChartSize, tileHeight: number): SizeSpec {
  return size === 'focus'
    ? {
        className: FOCUS_CHART_HEIGHT,
        style: undefined,
        height: '100%',
        initial: { width: 960, height: 480 },
        tick: 12,
        stroke: 2.25,
        dot: 4,
        activeDot: 4.5,
        margin: { top: 16, right: 4, bottom: 0, left: 8 },
        xAxisHeight: 24,
        maxBar: 44,
      }
    : {
        className: '',
        style: { height: tileHeight },
        height: tileHeight,
        initial: { width: 300, height: tileHeight },
        tick: 10,
        stroke: 2,
        dot: 3,
        activeDot: 3.5,
        margin: { top: 8, right: 8, bottom: 0, left: 8 },
        xAxisHeight: 18,
        maxBar: 18,
      }
}

const ACCENT = 'var(--color-accent)'
const TICK_OPACITY = 0.55
const ANIMATION = { animationDuration: 600, animationEasing: 'ease-out' } as const
/** The goal and 100% lines: dotted, ink at 40%. */
const GUIDE = { stroke: 'var(--color-ink)', strokeOpacity: 0.4, strokeDasharray: '2 3', strokeWidth: 1 } as const

function tickStyle(spec: SizeSpec) {
  return { fontSize: spec.tick, fill: 'var(--color-ink)', fillOpacity: TICK_OPACITY }
}

function seriesColor(index: number, single: boolean): string {
  return single ? ACCENT : LINE_COLORS[index % LINE_COLORS.length]!
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
  /** Names the prior period in the change text. */
  fiscalYearStartMonth?: number
}

function yDomain(points: ChartPoint[], target: number | null): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  if (values.length === 0) return [0, 100]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

function barDomain(points: ChartPoint[], plan: boolean): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  const max = Math.max(plan ? 100 : 1, ...values)
  return [0, max * 1.05]
}

interface ValueAxis {
  domain: [number, number]
  ticks: number[]
  format: (v: number) => string
  width: number
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag
}

/**
 * The focus value axis: about five ticks on an even step, the domain widened
 * to the outer ticks, and a width that fits the longest label (and `extra`,
 * e.g. the current-value pill).
 */
function valueAxis(format: string, [lo, hi]: [number, number], extra: string[] = []): ValueAxis {
  const decimals = metricDecimals(format)
  const step = niceStep(Math.max((hi - lo) / 4, 10 ** -decimals))
  const start = Math.floor(lo / step) * step
  const end = Math.max(Math.ceil(hi / step) * step, start + step)
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)))
  // Whole steps need no decimals: 80%, not 80.0%.
  const tickFormat = Number.isInteger(step) && /^(percent|number)[1-9]$/.test(format) ? format.replace(/\d$/, '0') : format
  const fmt = (v: number) => formatMetricValue(tickFormat, v)
  const chars = Math.max(...ticks.map((t) => fmt(t).length), ...extra.map((s) => s.length))
  return { domain: [start, end], ticks, format: fmt, width: Math.max(44, Math.ceil(chars * 7.2) + 14) }
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

/** The change with an arrow for its direction, colored good or bad, so color is never the only signal. */
function ChangeLabel({ change, size }: { change: { text: string; move: Move }; size: ChartSize }) {
  return (
    <span
      data-testid="header-change"
      data-tone={change.move.tone}
      className={`${size === 'focus' ? 'text-base' : 'text-xs'} font-medium tabular-nums ${MOVE_CLASS[change.move.tone]}`}
    >
      {change.move.arrow && <span aria-hidden="true">{change.move.arrow} </span>}
      {change.text}
    </span>
  )
}

export interface ChartSeries {
  name: string
  color: string
  points: ChartPoint[]
}

export interface ChartHoverCardProps {
  active?: boolean
  /** Recharts' tooltip payload; each entry's `payload` is the hovered datum, which carries its column index `i`. */
  payload?: ReadonlyArray<{ payload?: unknown }>
  columns: Column[]
  series: ChartSeries[]
  scale: StatusLevel[]
}

function valueText(point: ChartPoint): string {
  if (point.kind === 'na') return 'n/a'
  if (point.kind === 'missing') return 'No data'
  return point.display || '—'
}

function statusText(theme: StatusTheme, withLabel: boolean): string {
  return [theme.shape, theme.letter, withLabel ? theme.label : ''].filter(Boolean).join(' ')
}

/**
 * The hover label for one period, pinned at the top of the plot: the bold
 * value, the full period, the status and the change; one line per series
 * when there are several.
 */
export function ChartHoverCard({ active, payload, columns, series, scale }: ChartHoverCardProps) {
  const datum = payload?.[0]?.payload as { i?: unknown } | undefined
  const i = typeof datum?.i === 'number' ? datum.i : -1
  const column = columns[i]
  if (!active || !column) return null
  const single = series.length === 1 ? series[0]!.points[i] : undefined
  return (
    <div data-testid="chart-hover" className="w-max max-w-64 rounded-md bg-ink px-2 py-1.5 text-[11px] leading-4 text-white shadow-md">
      {single ? (
        <>
          <p className="text-[13px] font-semibold tabular-nums">{valueText(single)}</p>
          <p className="text-white/75">{column.fullLabel}</p>
          {single.kind === 'na' && <p>{single.naReason || 'Not applicable'}</p>}
          {single.kind === 'value' && single.status && (
            <p data-testid="hover-status">{statusText(chartTheme(scale, single.status), true)}</p>
          )}
          {single.change && <p className="text-white/75">{single.change}</p>}
          {single.overrideReason && <p>{`† ${single.overrideReason}`}</p>}
        </>
      ) : (
        <>
          <p className="text-white/75">{column.fullLabel}</p>
          <ul className="mt-0.5 space-y-0.5">
            {series.map((s, idx) => {
              const point = s.points[i]
              if (!point) return null
              return (
                <li key={idx} className="flex items-center gap-1.5">
                  <span data-swatch="" className="inline-block size-2 shrink-0 rounded-full ring-1 ring-white/60" style={{ backgroundColor: s.color }} />
                  <span className="text-white/75">{s.name}</span>
                  <span className="font-semibold tabular-nums">{valueText(point)}</span>
                  {point.kind === 'value' && point.status && <span>{statusText(chartTheme(scale, point.status), false)}</span>}
                  {point.overrideReason && <span>†</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

interface CursorProps {
  /** Line charts: the cursor's top and bottom points. */
  points?: { x: number; y: number }[]
  /** Bar charts: the hovered column's band. */
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A single vertical hairline through the hovered column. */
function Hairline({ points, x = 0, y = 0, width = 0, height = 0 }: CursorProps) {
  const cx = points?.[0]?.x ?? x + width / 2
  return (
    <line
      data-role="hairline"
      x1={cx}
      x2={cx}
      y1={points?.[0]?.y ?? y}
      y2={points?.[1]?.y ?? y + height}
      stroke="var(--color-ink)"
      strokeOpacity={0.35}
      strokeWidth={1}
      pointerEvents="none"
    />
  )
}

function hoverTooltip(columns: Column[], series: ChartSeries[], scale: StatusLevel[], animated: boolean, top: number) {
  return (
    <Tooltip
      content={(props) => <ChartHoverCard active={props.active} payload={props.payload} columns={columns} series={series} scale={scale} />}
      // Keep n/a and missing periods, so they still say why there is no value.
      filterNull={false}
      cursor={<Hairline />}
      // Pinned to the top of the plot; it follows the column and flips left near the right edge.
      position={{ y: top }}
      offset={8}
      allowEscapeViewBox={{ x: false, y: true }}
      // Above neighboring tiles, below the sticky control bar (z-10).
      wrapperStyle={{ zIndex: 5, outline: 'none' }}
      isAnimationActive={animated}
      animationDuration={150}
    />
  )
}

interface DotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: Record<string, unknown>
}

/** The line's only resting dot: on the current (last) point. */
function CurrentDot({ cx, cy, index, payload, dataKey, last, r, color }: DotProps & { dataKey: string; last: number; r: number; color: string }) {
  const key = `dot-${dataKey}-${index}`
  if (index !== last || cx == null || cy == null || payload?.[dataKey] == null) return <g key={key} />
  return <circle key={key} data-current-dot="" cx={cx} cy={cy} r={r} fill={color} stroke="#FFFFFF" strokeWidth={2} />
}

function ActiveDot({ cx, cy, r, color }: { cx?: number; cy?: number; r: number; color: string }) {
  if (cx == null || cy == null) return null
  return <circle data-role="active-dot" cx={cx} cy={cy} r={r} fill={color} stroke="#FFFFFF" strokeWidth={2} />
}

interface LabelViewBox {
  viewBox?: { x?: number; y?: number; width?: number; height?: number }
}

interface BandShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A band's faint tint, without a border. */
function BandRect({ x = 0, y = 0, width = 0, height = 0, color }: BandShapeProps & { color: string }) {
  return (
    <rect data-role="band" x={x} y={y} width={Math.max(width, 0)} height={Math.max(height, 0)} fill={color} fillOpacity={0.06} stroke="none" />
  )
}

const BAND_PILL = { width: 16, height: 14, font: 9 }

/** A band's letter as a tiny pill at the plot's right edge. */
function BandPill({ viewBox, theme }: LabelViewBox & { theme: StatusTheme }) {
  const { x = 0, y = 0, width = 0, height = 0 } = viewBox ?? {}
  const { width: w, height: h, font } = BAND_PILL
  const left = x + width - w - 4
  const mid = y + height / 2
  return (
    <g className="band-pill">
      <rect x={left} y={mid - h / 2} width={w} height={h} rx={h / 2} fill={theme.color} fillOpacity={0.14} />
      <text
        className="band-label"
        x={left + w / 2}
        y={mid}
        dy="0.35em"
        textAnchor="middle"
        fontSize={font}
        fontWeight={700}
        fill={theme.letterClass ? 'var(--color-ink)' : theme.color}
      >
        {theme.letter}
      </text>
    </g>
  )
}

/** Center-to-center room between the goal pill and the current-value pill. */
const PILL_CLEARANCE = 18

/**
 * A reference line's label, right-aligned inside the plot, `gap` px in from
 * the edge. When `avoid` (the current value) sits close, the pill moves off
 * it, above or below as the line lies.
 */
function GuidePill({ viewBox, text, gap, avoid = null }: LabelViewBox & { text: string; gap: number; avoid?: number | null }) {
  const yScale = useYAxisScale()
  const { x = 0, y: lineY = 0, width = 0 } = viewBox ?? {}
  const avoidY = avoid !== null ? yScale?.(avoid) : undefined
  const y =
    avoidY != null && Math.abs(avoidY - lineY) < PILL_CLEARANCE
      ? lineY <= avoidY
        ? avoidY - PILL_CLEARANCE
        : avoidY + PILL_CLEARANCE
      : lineY
  const h = 16
  const w = Math.ceil(text.length * 6.2) + 10
  const left = x + width - gap - 4 - w
  return (
    <g data-role="goal-pill">
      <rect x={left} y={y - h / 2} width={w} height={h} rx={3} fill="var(--color-ink)" fillOpacity={0.72} />
      <text x={left + w / 2} y={y} dy="0.35em" textAnchor="middle" fontSize={11} fontWeight={600} fill="#FFFFFF">
        {text}
      </text>
    </g>
  )
}

/** The current value in an accent pill on the right axis, at the line's last point. */
function AxisPill({ viewBox, text, axisWidth }: LabelViewBox & { text: string; axisWidth: number }) {
  const { x = 0, y = 0, width = 0 } = viewBox ?? {}
  const h = 18
  const left = x + width + 2
  const w = axisWidth - 4
  return (
    <g data-role="current-pill">
      <rect x={left} y={y - h / 2} width={w} height={h} rx={3} fill={ACCENT} />
      <text x={left + w / 2} y={y} dy="0.35em" textAnchor="middle" fontSize={12} fontWeight={600} fill="#FFFFFF">
        {text}
      </text>
    </g>
  )
}

/**
 * Each period's status under the plot, one cell per column with the plot's
 * left and right offsets so cells sit under their columns. Lettered, so status
 * never rests on color; the point buttons give the same to assistive technology.
 */
function StatusRibbon({ points, scale, size, inset }: { points: ChartPoint[]; scale: StatusLevel[]; size: ChartSize; inset: { left: number; right: number } }) {
  const focus = size === 'focus'
  const cell = 'flex min-w-0 flex-1 items-center justify-center gap-0.5 rounded-sm'
  return (
    <div
      data-testid="status-ribbon"
      aria-hidden="true"
      className={`mt-1 flex gap-px font-semibold leading-none ${focus ? 'h-[22px] text-xs' : 'h-[14px] text-[9px]'}`}
      style={{ marginLeft: inset.left, marginRight: inset.right }}
    >
      {points.map((p) => {
        if (p.kind === 'na') {
          return (
            <span key={p.key} data-status="na" className={`${cell} bg-status-na-bg font-medium text-ink/70`}>
              n/a
            </span>
          )
        }
        if (p.kind === 'missing' || !p.status) {
          return (
            <span key={p.key} data-status={p.kind === 'missing' ? 'missing' : 'none'} className={`${cell} ${p.kind === 'missing' ? '' : 'bg-ink/[0.06]'}`}>
              {p.kind === 'missing' && <span data-dot="" className="size-1 rounded-full bg-ink/35" />}
            </span>
          )
        }
        const theme = chartTheme(scale, p.status)
        const fill = statusFill(scale, p.status)
        return (
          <span
            key={p.key}
            data-status={p.status}
            data-tier={fill.tier}
            className={cell}
            style={{
              backgroundColor: fill.background,
              color: fill.letter,
              boxShadow: fill.border ? `inset 0 0 0 1px ${fill.border}` : undefined,
            }}
          >
            {focus && <span>{theme.shape}</span>}
            {theme.letter}
          </span>
        )
      })}
    </div>
  )
}

function pointLabel(p: ChartPoint, prefix = ''): string {
  if (p.kind === 'na') return `${prefix}${p.label}: n/a: ${p.naReason || 'Not applicable'}`
  if (p.kind === 'missing') return `${prefix}${p.label}: no data`
  return `${prefix}${p.label}: ${p.display}${p.overrideReason ? ' †' : ''}`
}

function PointButtons({ points, onSelect, prefix }: { points: ChartPoint[]; onSelect: (p: ChartPoint) => void; prefix?: string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {points.map((p) => (
        <button
          key={p.key}
          type="button"
          className="rounded border border-ink/20 px-1.5 py-0.5 text-xs hover:bg-cream"
          onClick={() => onSelect(p)}
          aria-label={pointLabel(p, prefix)}
        >
          {p.kind === 'na' ? 'n/a' : p.kind === 'missing' ? 'no data' : p.display || '—'}
          {p.overrideReason && <span aria-hidden="true"> †</span>}
          {p.kind === 'value' && p.status && <span className="sr-only">, status {p.status}</span>}
        </button>
      ))}
    </div>
  )
}

function PointSummary({ point, scale }: { point: ChartPoint | null; scale: StatusLevel[] }) {
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

/**
 * The keyboard and screen reader path to each point's value. Mouse users have
 * the hover label, so the row stays visually hidden until a button has focus.
 */
function PointControls({ tip, scale, children }: { tip: ChartPoint | null; scale: StatusLevel[]; children: ReactNode }) {
  return (
    <div data-testid="point-controls" className="sr-only focus-within:not-sr-only">
      {children}
      <div role="status" className="mt-1 min-h-6 text-sm text-ink/80">
        <PointSummary point={tip} scale={scale} />
      </div>
    </div>
  )
}

function RatioChart({
  row,
  chartRows,
  points,
  columns,
  scale,
  target,
  animated,
  size,
  fyStart,
}: {
  row: ViewRow
  chartRows: ViewRow[]
  /** The scope row's points, for the status ribbon. */
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  target: number | null
  animated: boolean
  size: ChartSize
  fyStart: number
}) {
  const spec = sizeSpec(size, 120)
  const focus = size === 'focus'
  const gradientId = `area-${useId().replace(/[^\w-]/g, '')}`
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const series = useMemo(
    () => chartRows.map((r) => ({ row: r, points: buildPoints(r, columns, fyStart) })),
    [chartRows, columns, fyStart],
  )
  const single = series.length === 1
  const hoverSeries = useMemo(
    () => series.map(({ row: r, points: p }, s) => ({ name: r.subjectName, color: seriesColor(s, single), points: p })),
    [series, single],
  )
  const lastIndex = columns.length - 1
  const currentPoint = single ? series[0]!.points[lastIndex] : undefined
  const currentValue = currentPoint?.kind === 'value' ? currentPoint.value : null
  const padded = yDomain(series.flatMap((s) => s.points), target)
  const axis = focus ? valueAxis(row.format, padded, currentValue !== null ? [currentPoint!.display] : []) : null
  const domain = axis?.domain ?? padded
  const currentCell = row.cells.find((c) => cellKey(c) === columns[lastIndex]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const inset = { left: spec.margin.left, right: spec.margin.right + (axis?.width ?? 0) }
  const showRibbon = single || points.some((p) => p.kind !== 'missing')
  const labels = new Map(columns.map((c) => [c.key, c.label]))

  const data = columns.map((col, i) => {
    const entry: Record<string, string | number | null> = { i, label: col.label, key: col.key }
    for (const { row: r, points: p } of series) {
      entry[`plot_${r.subjectId}`] = p[i]!.kind === 'value' ? p[i]!.value : null
    }
    if (single) entry.plot = entry[`plot_${series[0]!.row.subjectId}`]!
    return entry
  })

  return (
    <div>
      <div
        data-testid="metric-chart"
        data-size={size}
        data-bands={rects.map((r) => `${r.status}:${r.y0}-${r.y1}`).join(' ')}
        aria-hidden="true"
        className={spec.className}
        style={spec.style}
      >
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <ComposedChart
            data={data}
            // The plot is hidden from assistive technology; the point buttons are the keyboard path.
            accessibilityLayer={false}
            margin={spec.margin}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.18} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            {focus && <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.05} />}
            <XAxis
              // Keyed by period: a band scale merges repeated labels, such as two Novembers in 24 months.
              dataKey="key"
              tickFormatter={(key: string) => labels.get(key) ?? ''}
              // One band per column, so points sit mid-band over their ribbon cells.
              scale="band"
              axisLine={false}
              tickLine={false}
              tick={tickStyle(spec)}
              height={spec.xAxisHeight}
            />
            {axis ? (
              <YAxis
                orientation="right"
                domain={axis.domain}
                ticks={axis.ticks}
                interval={0}
                axisLine={false}
                tickLine={false}
                tick={tickStyle(spec)}
                tickFormatter={axis.format}
                width={axis.width}
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
                  shape={(props: BandShapeProps) => <BandRect {...props} color={theme.color} />}
                  label={focus ? (props: LabelViewBox) => <BandPill viewBox={props.viewBox} theme={theme} /> : undefined}
                />
              )
            })}
            {target !== null && (
              <ReferenceLine
                className="goal-line"
                y={target}
                {...GUIDE}
                label={
                  focus
                    ? (props: LabelViewBox) => (
                        <GuidePill
                          viewBox={props.viewBox}
                          text={`Goal ${formatMetricValue(row.format, target)}`}
                          gap={rects.length > 0 ? BAND_PILL.width + 6 : 0}
                          avoid={currentValue}
                        />
                      )
                    : undefined
                }
              />
            )}
            {axis && currentValue !== null && (
              <ReferenceLine
                y={currentValue}
                stroke="none"
                label={(props: LabelViewBox) => <AxisPill viewBox={props.viewBox} text={currentPoint!.display} axisWidth={axis.width} />}
              />
            )}
            {hoverTooltip(columns, hoverSeries, scale, animated, spec.margin.top)}
            {single && (
              <Area
                type="monotoneX"
                dataKey="plot"
                stroke="none"
                fill={`url(#${gradientId})`}
                fillOpacity={1}
                activeDot={false}
                tooltipType="none"
                connectNulls={false}
                isAnimationActive={animated}
                {...ANIMATION}
              />
            )}
            {series.map(({ row: r }, s) => {
              const color = seriesColor(s, single)
              const dataKey = single ? 'plot' : `plot_${r.subjectId}`
              return (
                <Line
                  key={r.subjectId}
                  type="monotoneX"
                  dataKey={dataKey}
                  stroke={color}
                  strokeWidth={spec.stroke}
                  dot={(props: DotProps) => (
                    <CurrentDot {...props} key={`dot-${r.subjectId}-${props.index}`} dataKey={dataKey} last={lastIndex} r={spec.dot} color={color} />
                  )}
                  activeDot={(props: DotProps) => <ActiveDot cx={props.cx} cy={props.cy} r={spec.activeDot} color={color} />}
                  isAnimationActive={animated}
                  {...ANIMATION}
                  connectNulls={false}
                />
              )
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {showRibbon && <StatusRibbon points={points} scale={scale} size={size} inset={inset} />}
      {!single && (
        <ul data-testid="chart-legend" aria-hidden="true" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink/80">
          {series.map(({ row: r }, s) => (
            <li key={r.subjectId} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: seriesColor(s, single) }} />
              {r.subjectName}
            </li>
          ))}
        </ul>
      )}
      {!focus && currentPoint?.kind === 'value' && (
        <p data-testid="current-point-label" className="mt-1 text-xs text-ink/80">
          Current: {currentPoint.display}{' '}
          <StatusMarker theme={chartTheme(scale, currentPoint.status)} />
        </p>
      )}
      <PointControls tip={tip} scale={scale}>
        {series.map(({ row: r, points: p }) => (
          <Fragment key={r.subjectId}>
            {!single && <p className="mt-2 text-xs font-medium text-ink/80">{r.subjectName}</p>}
            <PointButtons points={p} onSelect={setTip} prefix={single ? undefined : `${r.subjectName} `} />
          </Fragment>
        ))}
      </PointControls>
    </div>
  )
}

interface BarsProps {
  points: ChartPoint[]
  columns: Column[]
  format: string
  scale: StatusLevel[]
  animated: boolean
  size: ChartSize
  /** Money plan: percent of plan, with a 100% line; n/a and missing periods have no bar. */
  plan: boolean
}

/** Discrete and money-plan bars: one accent color, status in the ribbon below. */
function BarsChart({ points, columns, format, scale, animated, size, plan }: BarsProps) {
  const spec = sizeSpec(size, 100)
  const focus = size === 'focus'
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverSeries = useMemo(() => [{ name: '', color: ACCENT, points }], [points])
  const data = points.map((p, i) => ({ ...p, i, h: p.kind === 'value' ? (p.value ?? 0) : plan ? null : 0 }))
  const padded = barDomain(points, plan)
  const axis = focus ? valueAxis(format, padded) : null
  const domain = axis?.domain ?? padded
  const inset = { left: spec.margin.left, right: spec.margin.right + (axis?.width ?? 0) }
  const labels = new Map(columns.map((c) => [c.key, c.label]))
  return (
    <div>
      <div data-testid="metric-chart" data-size={size} aria-hidden="true" className={spec.className} style={spec.style}>
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} accessibilityLayer={false} margin={spec.margin}>
            {focus && <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.05} />}
            <XAxis
              // Keyed by period, as in the line chart, so repeated labels stay separate columns.
              dataKey="key"
              tickFormatter={(key: string) => labels.get(key) ?? ''}
              axisLine={false}
              tickLine={false}
              tick={tickStyle(spec)}
              height={spec.xAxisHeight}
            />
            {axis ? (
              <YAxis
                orientation="right"
                domain={axis.domain}
                ticks={axis.ticks}
                interval={0}
                axisLine={false}
                tickLine={false}
                tick={tickStyle(spec)}
                tickFormatter={axis.format}
                width={axis.width}
              />
            ) : (
              <YAxis hide domain={domain} />
            )}
            {plan && (
              <ReferenceLine
                className="goal-line"
                y={100}
                {...GUIDE}
                ifOverflow="extendDomain"
                label={focus ? (props: LabelViewBox) => <GuidePill viewBox={props.viewBox} text="100%" gap={0} /> : undefined}
              />
            )}
            {hoverTooltip(columns, hoverSeries, scale, animated, spec.margin.top)}
            <Bar
              dataKey="h"
              fill={ACCENT}
              fillOpacity={0.85}
              radius={[3, 3, 0, 0]}
              maxBarSize={spec.maxBar}
              isAnimationActive={animated}
              {...ANIMATION}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <StatusRibbon points={points} scale={scale} size={size} inset={inset} />
      <PointControls tip={tip} scale={scale}>
        <PointButtons points={points} onSelect={setTip} />
      </PointControls>
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
            <span className="flex flex-wrap gap-0.5" data-testid={`uptime-strip-${child.subjectId}`}>
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

function LetteredChips({ points, scale }: { points: ChartPoint[]; scale: components['schemas']['StatusLevel'][] }) {
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
  fiscalYearStartMonth = 1,
}: MetricChartProps) {
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const lines = chartRows ?? [row]
  const points = useMemo(() => buildPoints(row, columns, fiscalYearStartMonth), [row, columns, fiscalYearStartMonth])
  const kind = isSparse(row.chartKind, points.map((p) => p.kind)) ? 'sparse' : row.chartKind
  const currentCell = row.cells.find((c) => cellKey(c) === currentColumnKey)
  const target = currentCell?.target ?? null
  const theme = chartTheme(scale, currentStatus)
  const change = headerChange(row, currentCell, fiscalYearStartMonth)
  const summary = `${row.metricName}: ${currentDisplay || 'no data'}, status ${currentStatus || 'none'}`

  return (
    <div>
      <p className="sr-only">{summary}</p>
      {scopeNote && <p className="text-xs text-ink/80">{scopeNote}</p>}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-testid="header-value" className={`${size === 'focus' ? 'text-[28px] leading-9' : 'text-xl'} font-semibold tabular-nums`}>
          {currentDisplay || '—'}
        </span>
        {currentStatus && <StatusMarker theme={theme} title={statusLabel(currentStatus)} />}
        {change && <ChangeLabel change={change} size={size} />}
        {ytdDisplay && <span className="text-sm text-ink/80">{ytdDisplay}</span>}
      </div>
      {kind === 'uptime' ? (
        <UptimeRows childRows={childRows} columns={columns} currentColumnKey={currentColumnKey} scale={scale} />
      ) : kind === 'sparse' ? (
        <LetteredChips points={points} scale={scale} />
      ) : kind === 'discrete' || kind === 'money_plan' ? (
        <BarsChart
          points={points}
          columns={columns}
          format={row.format}
          scale={scale}
          animated={animated}
          size={size}
          plan={kind === 'money_plan'}
        />
      ) : (
        <RatioChart
          row={row}
          chartRows={lines}
          points={points}
          columns={columns}
          scale={scale}
          target={target}
          animated={animated}
          size={size}
          fyStart={fiscalYearStartMonth}
        />
      )}
      {/* In focus, the dialog's own table link sits below its breakdown. */}
      {size !== 'focus' && (
        <p className="mt-2">
          <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
            View as table
          </Link>
        </p>
      )}
    </div>
  )
}
