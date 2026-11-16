import { useSyncExternalStore, type ReactNode } from 'react'
import { ReferenceLine, usePlotArea, useYAxisScale } from 'recharts'
import type { components } from '../../../api/schema'
import { monthLabel, monthsOf, parsePeriod } from '../../../lib/period'
import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { chartTheme, LINE_COLORS, MOVE_CLASS, statusFill, type Move, type StatusTheme } from './chartTheme'
import type { ChartPoint } from './points'
import type { VersionMarker } from './versionMarkers'

export { ChartHoverCard, Hairline, hoverTooltip, type ChartHoverCardProps, type ChartSeries } from './chartHover'

type StatusLevel = components['schemas']['StatusLevel']

/**
 * The plot height in the full-screen dialog: at least half the viewport, and
 * the viewport less room for the dialog's title and controls above and the
 * status ribbon and range strip below (60vh at 1080px).
 */
export const FOCUS_CHART_HEIGHT = 'h-[max(50vh,calc(100vh_-_27rem))]'
/** The focus plot under 640px (§7): shorter, so the ribbon and range strip stay in view. */
export const PHONE_CHART_HEIGHT = 'h-[max(280px,45vh)]'
/** The focus value axis under 640px. */
export const PHONE_AXIS_WIDTH = 48

/** Tailwind's `sm`: below it is a phone. Without matchMedia, assume a wider screen. */
const SM_UP = '(min-width: 640px)'

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SM_UP)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !window.matchMedia(SM_UP).matches : false
}

/** True under 640px, where focus charts take their phone geometry. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
}

/** `tile` is the Overview card; `focus` fills the full-screen dialog. */
export type ChartSize = 'tile' | 'focus'

interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

export interface SizeSpec {
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

export function sizeSpec(size: ChartSize, tileHeight: number, phone = false): SizeSpec {
  return size === 'focus'
    ? {
        className: phone ? PHONE_CHART_HEIGHT : FOCUS_CHART_HEIGHT,
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

export const ACCENT = 'var(--color-accent)'
/** Tick text at ink/70, the lightest text allowed (§3.2). */
export const TICK_OPACITY = 0.7
export const ANIMATION = { animationDuration: 600, animationEasing: 'ease-out' } as const
/** The goal and 100% lines: dotted, ink at 40%. */
export const GUIDE = { stroke: 'var(--color-ink)', strokeOpacity: 0.4, strokeDasharray: '2 3', strokeWidth: 1 } as const

export function tickStyle(spec: SizeSpec) {
  return { fontSize: spec.tick, fill: 'var(--color-ink)', fillOpacity: TICK_OPACITY }
}

/** What Recharts passes a custom tick. */
export interface TickProps {
  x?: number | string
  y?: number | string
  textAnchor?: string
  payload?: { value?: unknown; index?: number }
}

type Anchor = 'start' | 'middle' | 'end'

/**
 * A period on the x axis. The current (last) column is bold at full ink, as
 * the board's selected column is; with `every` 2, only every other label
 * shows, counted back from the current one.
 */
export function PeriodTick({ x = 0, y = 0, payload, labels, last, fontSize, every = 1 }: TickProps & { labels: Map<string, string>; last: number; fontSize: number; every?: number }) {
  const index = payload?.index ?? 0
  if ((last - index) % every !== 0) return <g />
  const current = index === last
  return (
    <text
      className="recharts-cartesian-axis-tick-value"
      x={x}
      y={y}
      dy="0.71em"
      textAnchor="middle"
      fontSize={fontSize}
      fontWeight={current ? 600 : 400}
      fill="var(--color-ink)"
      fillOpacity={current ? 1 : TICK_OPACITY}
    >
      {labels.get(String(payload?.value ?? '')) ?? ''}
    </text>
  )
}

/** Room kept clear above and below the current-value pill for tick labels (§7.1). */
export const PILL_TICK_CLEARANCE = 14
const PILL_HEIGHT = 18
const PILL_HALF = PILL_HEIGHT / 2

/** A value-axis tick; hidden when its centre line falls within 14px of the current-value pill at `avoid`. */
export function ValueTick({ x = 0, y = 0, textAnchor, payload, format, fontSize, avoid }: TickProps & { format: (v: number) => string; fontSize: number; avoid: number | null }) {
  const yScale = useYAxisScale()
  const value = Number(payload?.value)
  const pillY = avoid !== null ? yScale?.(avoid) : undefined
  if (pillY != null && Math.abs(pillY - Number(y)) < PILL_HALF + PILL_TICK_CLEARANCE) return <g />
  return (
    <text
      className="recharts-cartesian-axis-tick-value"
      x={x}
      y={y}
      dy="0.355em"
      textAnchor={(textAnchor as Anchor | undefined) ?? 'start'}
      fontSize={fontSize}
      fill="var(--color-ink)"
      fillOpacity={TICK_OPACITY}
    >
      {format(value)}
    </text>
  )
}

/** The highest a value axis may run: 100 for a percentage no value goes past (§7.1), else unbounded. */
export function percentMax(format: string, values: number[]): number {
  return format.startsWith('percent') && !values.some((v) => v > 100) ? 100 : Infinity
}

/** A domain stopped at `percentMax`. */
export function capPercent(format: string, domain: [number, number], values: number[]): [number, number] {
  return [domain[0], Math.min(domain[1], percentMax(format, values))]
}

export function seriesColor(index: number, single: boolean): string {
  return single ? ACCENT : LINE_COLORS[index % LINE_COLORS.length]!
}

export function yDomain(points: ChartPoint[], target: number | null): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  if (values.length === 0) return [0, 100]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

export interface ValueAxis {
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
 * e.g. the current-value pill). The domain never runs past `max`.
 */
export function valueAxis(format: string, [lo, hi]: [number, number], extra: string[] = [], max = Infinity): ValueAxis {
  const decimals = metricDecimals(format)
  const step = niceStep(Math.max((hi - lo) / 4, 10 ** -decimals))
  const start = Math.floor(lo / step) * step
  const end = Math.min(Math.max(Math.ceil(Number((hi / step).toFixed(9))) * step, start + step), max)
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.min(Number(v.toFixed(10)), end))
  // Ticks carry only the decimals their step needs: 80%, not 80.0%; 99.5%, not 99.50%.
  const stepDecimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  const tickFormat = /^(percent|number)[1-9]$/.test(format) ? format.replace(/\d$/, String(Math.min(decimals, stepDecimals))) : format
  const fmt = (v: number) => formatMetricValue(tickFormat, v)
  const chars = Math.max(...ticks.map((t) => fmt(t).length), ...extra.map((s) => s.length))
  return { domain: [start, end], ticks, format: fmt, width: Math.max(44, Math.ceil(chars * 7.2) + 14) }
}

export function StatusMarker({ theme, title }: { theme: StatusTheme; title?: string }) {
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
export function ChangeLabel({ change, size }: { change: { text: string; move: Move }; size: ChartSize }) {
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

export interface DotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: Record<string, unknown>
}

/** The line's only resting dot: on the current (last) point. */
export function CurrentDot({ cx, cy, index, payload, dataKey, last, r, color }: DotProps & { dataKey: string; last: number; r: number; color: string }) {
  const key = `dot-${dataKey}-${index}`
  if (index !== last || cx == null || cy == null || payload?.[dataKey] == null) return <g key={key} />
  return <circle key={key} data-current-dot="" cx={cx} cy={cy} r={r} fill={color} stroke="#FFFFFF" strokeWidth={2} />
}

/**
 * Coarse and discrete charts: a visible dot on every period (`r` 3, the
 * current one 4) with its value above it. Only the current dot carries
 * `data-current-dot`; `label` is off for all but a single series.
 */
export function ValueDot({
  cx,
  cy,
  index,
  payload,
  dataKey,
  last,
  color,
  text,
}: DotProps & { dataKey: string; last: number; color: string; text: string | null }) {
  const key = `dot-${dataKey}-${index}`
  if (cx == null || cy == null || payload?.[dataKey] == null) return <g key={key} />
  const current = index === last
  const r = current ? 4 : 3
  return (
    <g key={key}>
      <circle data-point="" data-current-dot={current ? '' : undefined} cx={cx} cy={cy} r={r} fill={color} stroke="#FFFFFF" strokeWidth={1.5} />
      {text && (
        <text
          data-role="value-label"
          x={cx}
          y={cy - r - 6}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--color-ink)"
          fillOpacity={0.8}
          stroke="#FFFFFF"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {text}
        </text>
      )}
    </g>
  )
}

export function ActiveDot({ cx, cy, r, color }: { cx?: number; cy?: number; r: number; color: string }) {
  if (cx == null || cy == null) return null
  return <circle data-role="active-dot" cx={cx} cy={cy} r={r} fill={color} stroke="#FFFFFF" strokeWidth={2} />
}

export interface LabelViewBox {
  viewBox?: { x?: number; y?: number; width?: number; height?: number }
}

export interface BandShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A band's faint tint, without a border. */
export function BandRect({ x = 0, y = 0, width = 0, height = 0, color, opacity = 0.06 }: BandShapeProps & { color: string; opacity?: number }) {
  return (
    <rect data-role="band" x={x} y={y} width={Math.max(width, 0)} height={Math.max(height, 0)} fill={color} fillOpacity={opacity} stroke="none" />
  )
}

export const BAND_PILL = { width: 16, height: 14, font: 9 }

/** A band's letter as a tiny pill at the plot's right edge. */
export function BandPill({ viewBox, theme }: LabelViewBox & { theme: StatusTheme }) {
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
export function GuidePill({ viewBox, text, gap, avoid = null }: LabelViewBox & { text: string; gap: number; avoid?: number | null }) {
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

/** A methodology change: a dashed ink/55 line on the column's left edge, its 10px ink/70 label at the top, and the hover text as a title. */
function MarkerLabel({ viewBox, marker, columns, prev, next }: LabelViewBox & { marker: VersionMarker; columns: number; prev?: number; next?: number }) {
  const plot = usePlotArea()
  const { x = 0, y = 0, height = 0 } = viewBox ?? {}
  const column = plot ? plot.width / Math.max(columns, 1) : Infinity
  const width = marker.label.length * 5.6 + 8
  // Flip to the line's left when the label would run past the plot's right edge.
  const flip = (plot ? plot.x + plot.width : Infinity) - x < width
  // The text goes when it would run into the neighbouring marker's line; the line and title stay.
  const room = flip ? (prev === undefined ? Infinity : (marker.index - prev) * column) : next === undefined ? Infinity : (next - marker.index) * column
  return (
    <g data-role="version-marker">
      <title>{marker.title}</title>
      <line x1={x} x2={x} y1={y} y2={y + height} stroke="var(--color-ink)" strokeOpacity={0.55} strokeDasharray="3 3" strokeWidth={1} />
      {room >= width && (
        <text
          x={flip ? x - 4 : x + 4}
          y={y + 10}
          textAnchor={flip ? 'end' : 'start'}
          fontSize={10}
          fill="var(--color-ink)"
          fillOpacity={0.7}
          stroke="#FFFFFF"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {marker.label}
        </text>
      )}
    </g>
  )
}

/** The hover label's extra line per marked column. */
export function markerNotes(markers: VersionMarker[]): Record<number, string> {
  return Object.fromEntries(markers.map((m) => [m.index, m.title]))
}

/** One reference line per methodology change, on the boundary before its column (§7.2); a direct child of the chart. */
export function markerLines(markers: VersionMarker[], columns: Column[]) {
  const shown = markers.filter((m) => columns[m.index]).sort((a, b) => a.index - b.index)
  return shown.map((m, k) => (
    <ReferenceLine
      key={`marker-${columns[m.index]!.key}`}
      x={columns[m.index]!.key}
      position="start"
      stroke="none"
      label={(props: LabelViewBox) => (
        <MarkerLabel viewBox={props.viewBox} marker={m} columns={columns.length} prev={shown[k - 1]?.index} next={shown[k + 1]?.index} />
      )}
    />
  ))
}

/** The current value in an accent pill on the right axis, at the line's last point. */
export function AxisPill({ viewBox, text, axisWidth, fontSize = 12 }: LabelViewBox & { text: string; axisWidth: number; fontSize?: number }) {
  const { x = 0, y = 0, width = 0 } = viewBox ?? {}
  const h = PILL_HEIGHT
  const left = x + width + 2
  const w = axisWidth - 4
  return (
    <g data-role="current-pill">
      <rect x={left} y={y - h / 2} width={w} height={h} rx={3} fill={ACCENT} />
      <text x={left + w / 2} y={y} dy="0.35em" textAnchor="middle" fontSize={fontSize} fontWeight={600} fill="#FFFFFF">
        {text}
      </text>
    </g>
  )
}

/**
 * Each period's status under the plot, one cell per column with the plot's
 * left and right offsets so cells sit under their columns. Lettered, so status
 * never rests on color; the point buttons give the same to assistive technology.
 * Tiles and phones: 18px cells with the letter only; desktop focus adds the shape.
 */
export function StatusRibbon({
  points,
  scale,
  size,
  inset,
  phone = false,
}: {
  points: ChartPoint[]
  scale: StatusLevel[]
  size: ChartSize
  inset: { left: number; right: number }
  phone?: boolean
}) {
  const focus = size === 'focus' && !phone
  const cell = 'flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden rounded-sm'
  return (
    <div
      data-testid="status-ribbon"
      aria-hidden="true"
      className={`mt-1 flex gap-px font-semibold leading-none ${focus ? 'h-[22px] text-xs' : 'h-[18px] text-[11px]'}`}
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

/** `Oct: 84.3%`; with `full`, the unambiguous period (`Q3 FY2026: 83%`), as eight quarters repeat `Q3`. */
export function pointLabel(p: ChartPoint, prefix = '', full = false): string {
  const label = full ? p.fullLabel : p.label
  if (p.kind === 'na') return `${prefix}${label}: n/a: ${p.naReason || 'Not applicable'}`
  if (p.kind === 'missing') return `${prefix}${label}: no data`
  return `${prefix}${label}: ${p.display}${p.overrideReason ? ' †' : ''}`
}

export interface PointButtonsProps {
  points: ChartPoint[]
  onSelect: (p: ChartPoint) => void
  prefix?: string
  /** Name each button by the full period. */
  full?: boolean
  /** The visible text of an n/a button; `n/a` when absent. */
  naText?: (p: ChartPoint) => string
}

export function PointButtons({ points, onSelect, prefix, full = false, naText }: PointButtonsProps) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {points.map((p) => (
        <button
          key={p.key}
          type="button"
          className="rounded border border-ink/20 px-1.5 py-0.5 text-xs hover:bg-cream"
          onClick={() => onSelect(p)}
          aria-label={pointLabel(p, prefix, full)}
        >
          {p.kind === 'na' ? (naText?.(p) ?? 'n/a') : p.kind === 'missing' ? 'no data' : p.display || '—'}
          {p.overrideReason && <span aria-hidden="true"> †</span>}
          {p.kind === 'value' && p.status && <span className="sr-only">, status {p.status}</span>}
        </button>
      ))}
    </div>
  )
}

export function PointSummary({ point, scale }: { point: ChartPoint | null; scale: StatusLevel[] }) {
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

/** Whether the columns are quarters, halves or years rather than months. */
export function coarseColumnsShown(columns: Column[]): boolean {
  const grain = parsePeriod(columns[0]?.period)?.grain
  return grain !== undefined && grain !== 'month'
}

/** A coarse period on an axis: `Q3 FY26`, `H1 FY26`, `FY26`; months keep their label. */
export function axisLabel(column: Column): string {
  if (!coarseColumnsShown([column])) return column.label
  return column.fullLabel.replace(/FY\d{2}(\d{2})$/, 'FY$1')
}

/** The months a coarse period covers, for the hover label: `Jul–Sep 2026`, `Nov 2025–Apr 2026`. */
export function monthSpan(column: Column, fyStart: number): string {
  const p = parsePeriod(column.period)
  if (!p || p.grain === 'month') return column.fullLabel
  const months = monthsOf(p)
  const first = monthLabel(months[0]!, fyStart)
  const last = monthLabel(months[months.length - 1]!, fyStart)
  const [firstName, firstYear] = first.split(' ')
  return firstYear === last.split(' ')[1] ? `${firstName}–${last}` : `${first}–${last}`
}

/**
 * The keyboard and screen reader path to each point's value. Mouse users have
 * the hover label, so the row stays visually hidden until a button has focus.
 */
export function PointControls({ tip, scale, children }: { tip: ChartPoint | null; scale: StatusLevel[]; children: ReactNode }) {
  return (
    <div data-testid="point-controls" className="sr-only focus-within:not-sr-only">
      {children}
      <div role="status" className="mt-1 min-h-6 text-sm text-ink/80">
        <PointSummary point={tip} scale={scale} />
      </div>
    </div>
  )
}
