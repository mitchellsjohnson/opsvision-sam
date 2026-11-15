import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { Link, type To } from 'react-router'
import {
  Area,
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
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { components } from '../../../api/schema'
import { usePrefersReducedMotion } from '../../../ui/Sparkline'
import type { Column } from '../columns'
import { changeText, formatMetricValue, overrideSentence } from '../format'
import { cellKey } from '../viewHelpers'
import { statusIntervals } from './bands'
import { chartTheme, LINE_COLORS, type StatusTheme } from './chartTheme'
import { isSparse, pointKind, type PointKind } from './sparse'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type CellT = Schemas['Cell']
type StatusLevel = Schemas['StatusLevel']

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
  /** Point radius; the current point's is `current`, ringed by `halo`. */
  dot: number
  current: number
  halo: number
  letter: number
  currentLetter: number
  /** Value labels above points; 0 for none. */
  value: number
  band: { width: number; height: number; font: number }
  maxBar: number
}

function sizeSpec(size: ChartSize, tileHeight: number): SizeSpec {
  return size === 'focus'
    ? {
        className: FOCUS_CHART_HEIGHT,
        style: undefined,
        height: '100%',
        initial: { width: 960, height: 480 },
        tick: 13,
        dot: 9,
        current: 12,
        halo: 6,
        letter: 11,
        currentLetter: 14,
        value: 12,
        band: { width: 24, height: 20, font: 12 },
        maxBar: 44,
      }
    : {
        className: '',
        style: { height: tileHeight },
        height: tileHeight,
        initial: { width: 300, height: tileHeight },
        tick: 10,
        dot: 6,
        current: 8,
        halo: 4,
        letter: 8,
        currentLetter: 10,
        value: 0,
        band: { width: 16, height: 14, font: 9 },
        maxBar: 18,
      }
}

const TICK_OPACITY = 0.6
const ANIMATION = { animationDuration: 600, animationEasing: 'ease-out' } as const

function tickStyle(spec: SizeSpec) {
  return { fontSize: spec.tick, fill: 'var(--color-ink)', fillOpacity: TICK_OPACITY }
}

function seriesColor(index: number): string {
  return LINE_COLORS[index % LINE_COLORS.length]!
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
  /** Names the prior period in the hover card's change text. */
  fiscalYearStartMonth?: number
}

export interface ChartPoint {
  key: string
  label: string
  fullLabel: string
  value: number | null
  display: string
  status: string
  naReason: string
  overrideReason: string
  /** The change as a phrase, e.g. `+2.1 pts vs Sep`; null when the cell has none. */
  change: string | null
  /** `Goal 90.0%`; null when the cell has no target. */
  goal: string | null
  kind: PointKind
}

function cellsByKey(row: ViewRow): Map<string, CellT> {
  return new Map(row.cells.map((c) => [cellKey(c), c]))
}

/** One point per column for a row, with everything the hover card and point buttons show. */
export function buildPoints(row: ViewRow, columns: Column[], fyStart: number): ChartPoint[] {
  const byKey = cellsByKey(row)
  return columns.map((col) => {
    const cell = byKey.get(col.key)
    const kind = pointKind(cell)
    return {
      key: col.key,
      label: col.label,
      fullLabel: col.fullLabel,
      value: kind === 'value' ? (cell?.value ?? null) : null,
      display: cell?.display ?? '',
      status: cell?.status ?? '',
      naReason: cell?.naReason ?? '',
      overrideReason: cell?.override ? overrideSentence(cell.override) : '',
      change: cell
        ? changeText({
            period: cell.period,
            ytd: cell.ytd,
            format: row.format,
            change: cell.change,
            changeKind: cell.changeKind,
            fyStart,
          })
        : null,
      goal: cell?.target != null ? `Goal ${formatMetricValue(row.format, cell.target)}` : null,
      kind,
    }
  })
}

function yDomain(points: ChartPoint[], target: number | null, extra: number[] = []): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  for (const v of extra) values.push(v)
  if (values.length === 0) return [0, 100]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

function moneyDomain(points: ChartPoint[]): [number, number] {
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

/** A filled status pill: shape, letter and the scale's name, so status never rests on color. */
function StatusPill({ theme }: { theme: StatusTheme }) {
  return (
    <span
      data-testid="hover-status"
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none"
      style={{ backgroundColor: theme.color, color: theme.onColor }}
    >
      {[theme.shape, theme.letter, theme.label].filter(Boolean).join(' ')}
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

function HoverPoint({ point, theme }: { point: ChartPoint; theme: StatusTheme }) {
  return (
    <>
      {point.kind === 'na' ? (
        <p>{`n/a: ${point.naReason || 'Not applicable'}`}</p>
      ) : point.kind === 'missing' ? (
        <p className="text-ink/70">No data</p>
      ) : (
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold tabular-nums">{point.display || '—'}</span>
          {point.status && <StatusPill theme={theme} />}
        </p>
      )}
      {point.overrideReason && <p>{`† ${point.overrideReason}`}</p>}
      {point.change && <p className="text-ink/70">{point.change}</p>}
      {point.goal && <p className="text-ink/70">{point.goal}</p>}
    </>
  )
}

/** The hover card for one period: its full label, then each series' value, status, change and goal. */
export function ChartHoverCard({ active, payload, columns, series, scale }: ChartHoverCardProps) {
  const datum = payload?.[0]?.payload as { i?: unknown } | undefined
  const i = typeof datum?.i === 'number' ? datum.i : -1
  const column = columns[i]
  if (!active || !column) return null
  const multi = series.length > 1
  return (
    <div data-testid="chart-hover" className="w-max max-w-64 rounded-lg bg-white px-3 py-2 text-xs text-ink shadow-md ring-1 ring-ink/10">
      <p className="font-semibold">{column.fullLabel}</p>
      <ul className="mt-1 space-y-1.5">
        {series.map((s, idx) => {
          const point = s.points[i]
          if (!point) return null
          return (
            <li key={idx} className="space-y-0.5">
              {multi && (
                <p className="flex items-center gap-1.5 font-medium">
                  <span data-swatch="" className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: s.color }} />
                  {s.name}
                </p>
              )}
              <HoverPoint point={point} theme={chartTheme(scale, point.status)} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function hoverTooltip(columns: Column[], series: ChartSeries[], scale: StatusLevel[], animated: boolean, bars: boolean) {
  return (
    <Tooltip
      content={(props) => <ChartHoverCard active={props.active} payload={props.payload} columns={columns} series={series} scale={scale} />}
      // Keep n/a and missing periods, so they still say why there is no value.
      filterNull={false}
      cursor={
        bars
          ? { fill: 'var(--color-ink)', fillOpacity: 0.06 }
          : { stroke: 'var(--color-ink)', strokeOpacity: 0.3, strokeWidth: 1 }
      }
      // It may run below a small tile, but flips sideways rather than leave the plot's width.
      allowEscapeViewBox={{ x: false, y: true }}
      wrapperStyle={{ zIndex: 30, outline: 'none' }}
      isAnimationActive={animated}
    />
  )
}

interface DotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: Record<string, unknown>
}

/**
 * A line point filled with its status color and lettered inside, so status
 * never rests on color. The current point is larger and haloed; value labels
 * sit above when `valueSize` is set.
 */
function StatusDot({
  cx,
  cy,
  index,
  payload,
  statusKey,
  displayKey,
  scale,
  color,
  spec,
  current,
  valueSize,
}: DotProps & {
  statusKey: string
  displayKey: string
  scale: StatusLevel[]
  color: string
  spec: SizeSpec
  current: boolean
  valueSize: number
}) {
  const key = `dot-${statusKey}-${index}`
  const status = typeof payload?.[statusKey] === 'string' ? (payload[statusKey] as string) : ''
  const display = typeof payload?.[displayKey] === 'string' ? (payload[displayKey] as string) : ''
  if (cx == null || cy == null || (!status && !display)) return <g key={key} />
  const theme = chartTheme(scale, status)
  const fill = status ? theme.color : color
  const r = current ? spec.current : status ? spec.dot : spec.dot * 0.6
  const top = cy - r - (current ? spec.halo : 0)
  return (
    <g key={key} data-status-dot={status || undefined} data-current={current}>
      {current && <circle className="point-halo" cx={cx} cy={cy} r={r + spec.halo} fill={fill} fillOpacity={0.18} />}
      <circle cx={cx} cy={cy} r={r} fill={fill} stroke="#FFFFFF" strokeWidth={1.5} />
      {status && (
        <text
          className="point-letter"
          x={cx}
          y={cy}
          dy="0.35em"
          textAnchor="middle"
          fontSize={current ? spec.currentLetter : spec.letter}
          fontWeight={700}
          fill={theme.onColor}
        >
          {status}
        </text>
      )}
      {valueSize > 0 && display && (
        <text
          data-role="value-label"
          x={cx}
          y={top - 6}
          textAnchor="middle"
          fontSize={valueSize}
          fontWeight={current ? 700 : 600}
          fill="var(--color-ink)"
          fillOpacity={current ? 1 : 0.75}
          stroke="#FFFFFF"
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {display}
        </text>
      )}
    </g>
  )
}

function ActiveRing({ cx, cy, r, color }: { cx?: number; cy?: number; r: number; color: string }) {
  if (cx == null || cy == null) return null
  return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={2} />
}

interface BandLabelProps {
  viewBox?: { x?: number; y?: number; width?: number; height?: number }
}

interface BandShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A band's tint, widened by `inset` each side to cover the x-axis padding the points sit inside. */
function BandRect({ x = 0, y = 0, width = 0, height = 0, inset, color }: BandShapeProps & { inset: number; color: string }) {
  return (
    <rect
      x={x - inset}
      y={y}
      width={Math.max(width + 2 * inset, 0)}
      height={Math.max(height, 0)}
      fill={color}
      fillOpacity={0.12}
      stroke={color}
      strokeOpacity={0.35}
      strokeWidth={1}
    />
  )
}

/** A band's letter as a small pill in the gutter right of the plot. */
function BandPill({ viewBox, theme, spec, inset }: BandLabelProps & { theme: StatusTheme; spec: SizeSpec; inset: number }) {
  const { x = 0, y = 0, width = 0, height = 0 } = viewBox ?? {}
  const { width: w, height: h, font } = spec.band
  const left = x + width + inset + 4
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
 * the hover card, so the row stays visually hidden until a button has focus.
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
  columns,
  scale,
  target,
  animated,
  size,
  fyStart,
}: {
  row: ViewRow
  chartRows: ViewRow[]
  columns: Column[]
  scale: StatusLevel[]
  target: number | null
  animated: boolean
  size: ChartSize
  fyStart: number
}) {
  const spec = sizeSpec(size, 120)
  const xPad = spec.current + spec.halo
  const gradientId = `area-${useId().replace(/[^\w-]/g, '')}`
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const series = useMemo(
    () => chartRows.map((r) => ({ row: r, points: buildPoints(r, columns, fyStart) })),
    [chartRows, columns, fyStart],
  )
  const single = series.length === 1
  const hoverSeries = useMemo(
    () => series.map(({ row: r, points }, s) => ({ name: r.subjectName, color: seriesColor(s), points })),
    [series],
  )
  const flatPoints = series.flatMap((s) => s.points)
  const domain = yDomain(flatPoints, target)
  const currentCell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const lastIndex = columns.length - 1
  const currentPoint = single ? series[0]!.points[lastIndex] : undefined

  const data = columns.map((col, i) => {
    const entry: Record<string, string | number | null> = { i, label: col.label, key: col.key }
    for (const { row: r, points } of series) {
      const p = points[i]!
      entry[`plot_${r.subjectId}`] = p.kind === 'value' ? p.value : null
      entry[`status_${r.subjectId}`] = p.kind === 'value' ? p.status : ''
      entry[`display_${r.subjectId}`] = p.kind === 'value' && p.value !== null ? p.display : ''
    }
    if (single) {
      const r = series[0]!.row
      entry.plot = entry[`plot_${r.subjectId}`]!
      entry.status = entry[`status_${r.subjectId}`]!
      entry.display = entry[`display_${r.subjectId}`]!
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
        className={spec.className}
        style={spec.style}
      >
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <ComposedChart
            data={data}
            // The plot is hidden from assistive technology; the point buttons are the keyboard path.
            accessibilityLayer={false}
            margin={size === 'focus' ? { top: 32, right: 40, bottom: 8, left: 8 } : { top: 16, right: 24, bottom: 4, left: 8 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.06} />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={tickStyle(spec)}
              padding={{ left: xPad, right: xPad }}
            />
            {size === 'focus' ? (
              <YAxis
                domain={domain}
                axisLine={false}
                tickLine={false}
                tick={tickStyle(spec)}
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
                  shape={(props: BandShapeProps) => <BandRect {...props} inset={xPad} color={theme.color} />}
                  label={(props: BandLabelProps) => <BandPill viewBox={props.viewBox} theme={theme} spec={spec} inset={xPad} />}
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
            {hoverTooltip(columns, hoverSeries, scale, animated, false)}
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
              const color = seriesColor(s)
              const suffix = single ? '' : `_${r.subjectId}`
              return (
                <Line
                  key={r.subjectId}
                  type="monotoneX"
                  dataKey={`plot${suffix}`}
                  stroke={color}
                  strokeWidth={single ? 2.5 : 2}
                  dot={(props: DotProps) => (
                    <StatusDot
                      {...props}
                      key={`dot-${r.subjectId}-${props.index}`}
                      statusKey={`status${suffix}`}
                      displayKey={`display${suffix}`}
                      scale={scale}
                      color={color}
                      spec={spec}
                      current={props.index === lastIndex}
                      valueSize={single || props.index === lastIndex ? spec.value : 0}
                    />
                  )}
                  activeDot={(props: DotProps) => (
                    <ActiveRing cx={props.cx} cy={props.cy} color={color} r={(props.index === lastIndex ? spec.current + spec.halo : spec.dot) + 3} />
                  )}
                  isAnimationActive={animated}
                  {...ANIMATION}
                  connectNulls={false}
                />
              )
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {!single && (
        <ul data-testid="chart-legend" aria-hidden="true" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink/80">
          {series.map(({ row: r }, s) => (
            <li key={r.subjectId} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: seriesColor(s) }} />
              {r.subjectName}
            </li>
          ))}
        </ul>
      )}
      {currentPoint?.kind === 'value' && (
        <p data-testid="current-point-label" className="text-xs text-ink/80">
          Current: {currentPoint.display}{' '}
          <StatusMarker theme={chartTheme(scale, currentPoint.status)} />
        </p>
      )}
      <PointControls tip={tip} scale={scale}>
        {series.map(({ row: r, points }) => (
          <Fragment key={r.subjectId}>
            {!single && <p className="mt-2 text-xs font-medium text-ink/80">{r.subjectName}</p>}
            <PointButtons points={points} onSelect={setTip} prefix={single ? undefined : `${r.subjectName} `} />
          </Fragment>
        ))}
      </PointControls>
    </div>
  )
}

interface BarChartProps {
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  animated: boolean
  size: ChartSize
}

function DiscreteChart({ points, columns, scale, animated, size }: BarChartProps) {
  const spec = sizeSpec(size, 100)
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverSeries = useMemo(() => [{ name: '', color: seriesColor(0), points }], [points])
  const data = points.map((p, i) => ({ ...p, i, h: p.kind === 'value' ? p.value ?? 0 : 0, letter: p.kind === 'value' ? p.status : '' }))
  return (
    <div>
      <div data-testid="metric-chart" data-size={size} aria-hidden="true" className={spec.className} style={spec.style}>
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} accessibilityLayer={false} margin={{ top: 14, right: 4, bottom: 4, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.06} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={tickStyle(spec)} />
            <YAxis hide />
            {hoverTooltip(columns, hoverSeries, scale, animated, true)}
            <Bar dataKey="h" radius={[4, 4, 0, 0]} maxBarSize={spec.maxBar} isAnimationActive={animated} {...ANIMATION}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'var(--color-ink)'} fillOpacity={p.kind === 'value' ? 1 : 0.1} />
              ))}
              <LabelList dataKey="letter" position="top" fontSize={spec.tick} fontWeight={600} fill="var(--color-ink)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <PointControls tip={tip} scale={scale}>
        <PointButtons points={points} onSelect={setTip} />
      </PointControls>
    </div>
  )
}

function MoneyPlanChart({ points, columns, scale, animated, size }: BarChartProps) {
  const spec = sizeSpec(size, 100)
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverSeries = useMemo(() => [{ name: '', color: seriesColor(0), points }], [points])
  const data = points.map((p, i) => ({ ...p, i, h: p.kind === 'value' ? p.value ?? 0 : null, letter: p.kind === 'value' ? p.status : '' }))
  const domain = moneyDomain(points)
  return (
    <div>
      <div data-testid="metric-chart" data-size={size} aria-hidden="true" className={spec.className} style={spec.style}>
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} accessibilityLayer={false} margin={{ top: 14, right: 4, bottom: 4, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.06} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={tickStyle(spec)} />
            <YAxis hide domain={domain} />
            <ReferenceLine y={100} stroke="var(--color-ink)" strokeWidth={1} ifOverflow="extendDomain" label={{ value: '100%', fontSize: spec.tick }} />
            {hoverTooltip(columns, hoverSeries, scale, animated, true)}
            <Bar dataKey="h" radius={[4, 4, 0, 0]} maxBarSize={spec.maxBar} isAnimationActive={animated} {...ANIMATION}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.kind === 'value' ? chartTheme(scale, p.status).color : 'transparent'} />
              ))}
              <LabelList dataKey="letter" position="top" fontSize={spec.tick} fontWeight={600} fill="var(--color-ink)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
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
        <DiscreteChart points={points} columns={columns} scale={scale} animated={animated} size={size} />
      ) : kind === 'money_plan' ? (
        <MoneyPlanChart points={points} columns={columns} scale={scale} animated={animated} size={size} />
      ) : (
        <RatioChart
          row={row}
          chartRows={lines}
          columns={columns}
          scale={scale}
          target={target}
          animated={animated}
          size={size}
          fyStart={fiscalYearStartMonth}
        />
      )}
      <p className="mt-2">
        <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
          View as table
        </Link>
      </p>
    </div>
  )
}
