import type { ReactNode } from 'react'
import { useYAxisScale } from 'recharts'
import type { components } from '../../../api/schema'
import { monthLabel, monthsOf, parsePeriod } from '../../../lib/period'
import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { chartTheme, LINE_COLORS, MOVE_CLASS, statusFill, type Move, type StatusTheme } from './chartTheme'
import type { ChartPoint } from './points'

export { ChartHoverCard, Hairline, hoverTooltip, type ChartHoverCardProps, type ChartSeries } from './chartHover'

type StatusLevel = components['schemas']['StatusLevel']

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

export function sizeSpec(size: ChartSize, tileHeight: number): SizeSpec {
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

export const ACCENT = 'var(--color-accent)'
export const TICK_OPACITY = 0.55
export const ANIMATION = { animationDuration: 600, animationEasing: 'ease-out' } as const
/** The goal and 100% lines: dotted, ink at 40%. */
export const GUIDE = { stroke: 'var(--color-ink)', strokeOpacity: 0.4, strokeDasharray: '2 3', strokeWidth: 1 } as const

export function tickStyle(spec: SizeSpec) {
  return { fontSize: spec.tick, fill: 'var(--color-ink)', fillOpacity: TICK_OPACITY }
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
 * e.g. the current-value pill).
 */
export function valueAxis(format: string, [lo, hi]: [number, number], extra: string[] = []): ValueAxis {
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

/** The current value in an accent pill on the right axis, at the line's last point. */
export function AxisPill({ viewBox, text, axisWidth }: LabelViewBox & { text: string; axisWidth: number }) {
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
export function StatusRibbon({ points, scale, size, inset }: { points: ChartPoint[]; scale: StatusLevel[]; size: ChartSize; inset: { left: number; right: number } }) {
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
