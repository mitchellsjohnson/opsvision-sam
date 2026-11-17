import { useSyncExternalStore, type ReactNode } from 'react'
import { ReferenceLine, usePlotArea, useYAxisScale } from 'recharts'
import type { components } from '../../../api/schema'
import { lastMonth, monthLabel, monthsOf, parsePeriod, periodLabel, type Period } from '../../../lib/period'
import type { Column } from '../columns'
import { formatMetricValue, metricDecimals } from '../format'
import { coarseStatus } from '../logic/coarse'
import { bandStatus } from './bands'
import { chartTheme, LINE_COLORS, MOVE_CLASS, statusFill, type Move, type StatusTheme } from './chartTheme'
import type { ChartPoint } from './points'
import type { VersionMarker } from './versionMarkers'

export { ChartHoverCard, Hairline, hoverTooltip, type ChartHoverCardProps, type ChartSeries } from './chartHover'

type StatusLevel = components['schemas']['StatusLevel']
type Band = components['schemas']['Band']
type ViewRow = components['schemas']['ViewRow']

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

/** An axis tick this close to a threshold line is dropped, so its label never prints over the line's (§4). */
export const THRESHOLD_TICK_CLEARANCE = 12

/**
 * A value-axis tick; hidden when its centre line falls within 14px of the
 * current-value pill at `avoid`, or within 12px of a threshold line in `lines`.
 */
export function ValueTick({
  x = 0,
  y = 0,
  textAnchor,
  payload,
  format,
  fontSize,
  avoid,
  lines = [],
}: TickProps & { format: (v: number) => string; fontSize: number; avoid: number | null; lines?: number[] }) {
  const yScale = useYAxisScale()
  const value = Number(payload?.value)
  const pillY = avoid !== null ? yScale?.(avoid) : undefined
  if (pillY != null && Math.abs(pillY - Number(y)) < PILL_HALF + PILL_TICK_CLEARANCE) return <g />
  if (yScale && lines.some((l) => Math.abs((yScale(l) ?? Infinity) - Number(y)) < THRESHOLD_TICK_CLEARANCE)) return <g />
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
  return valuesDomain(
    points.map((p) => p.value).filter((v): v is number => v !== null),
    target,
  )
}

/** The values (and the target) with 15% of their span above and below. */
export function valuesDomain(shown: number[], target: number | null): [number, number] {
  const values = target !== null ? [...shown, target] : shown
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

/** A band edge drawn as a dashed line, with its label at the plot's right. */
export interface Threshold {
  value: number
  label: string
  color: string
}

/** The band edges strictly inside `domain`, highest first, each with the status a value on the edge gets. */
export function bandEdges(bands: Band[] | undefined, domain: [number, number]): { value: number; status: string }[] {
  const [lo, hi] = domain
  const values = [...new Set((bands ?? []).filter((b) => b.op !== '' && b.value > lo && b.value < hi).map((b) => b.value))]
  return values.sort((a, b) => b - a).map((value) => ({ value, status: bandStatus(bands ?? [], value) }))
}

/** A percent metric's band edges as far as this from the data are brought into view (§5.1). */
export const EDGE_REACH = 12

/**
 * `values` plus the nearest band edge above and below them when it lies
 * within 12 points, so a run between two thresholds reads as such. Only
 * percent formats: elsewhere 12 units mean nothing in particular.
 */
export function withNearEdges(values: number[], bands: Band[] | undefined, format: string): number[] {
  if (!format.startsWith('percent') || values.length === 0 || !bands?.length) return values
  const edges = bands.filter((b) => b.op !== '').map((b) => b.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const above = edges.filter((e) => e > max && e - max <= EDGE_REACH).sort((a, b) => a - b)[0]
  const below = edges.filter((e) => e < min && min - e <= EDGE_REACH).sort((a, b) => b - a)[0]
  return [...values, ...(above !== undefined ? [above] : []), ...(below !== undefined ? [below] : [])]
}

/** Room a threshold label takes right of the plot, 11px text. */
export function thresholdLabelWidth(thresholds: Threshold[]): number {
  return thresholds.length === 0 ? 0 : Math.ceil(Math.max(...thresholds.map((t) => t.label.length)) * 6.4) + 8
}

function ThresholdMark({ viewBox, threshold, labelled }: LabelViewBox & { threshold: Threshold; labelled: boolean }) {
  const { x = 0, y = 0, width = 0 } = viewBox ?? {}
  return (
    <g data-role="threshold-line" data-edge={threshold.value}>
      <line x1={x} x2={x + width} y1={y} y2={y} stroke={threshold.color} strokeOpacity={0.75} strokeDasharray="4 3" strokeWidth={1} />
      {labelled && (
        <text data-role="threshold-label" x={x + width + 4} y={y} dy="0.35em" textAnchor="start" fontSize={11} fill="var(--color-ink)" fillOpacity={TICK_OPACITY}>
          {threshold.label}
        </text>
      )}
    </g>
  )
}

/** One dashed line per band edge (§4, §5.1, §6), a direct child of the chart; labelled at the right when `labelled`. */
export function thresholdLines(thresholds: Threshold[], labelled = true) {
  return thresholds.map((t) => (
    <ReferenceLine
      key={`threshold-${t.value}`}
      y={t.value}
      stroke="none"
      label={(props: LabelViewBox) => <ThresholdMark viewBox={props.viewBox} threshold={t} labelled={labelled} />}
    />
  ))
}

/** The period after `p`, of the same grain. */
export function nextPeriod(p: Period): Period {
  if (p.grain === 'year') return { ...p, fy: p.fy + 1 }
  const perYear = { month: 12, quarter: 4, half: 2 }[p.grain]
  return p.index < perYear ? { ...p, index: p.index + 1 } : { ...p, fy: p.fy + 1, index: 1 }
}

/** `Jan 2027`: the month a coarse period is due by, the one after it closes. */
export function dueByLabel(p: Period, fyStart: number): string {
  return monthLabel(nextPeriod(lastMonth(p)), fyStart)
}

/** The next period's slot on a coarse chart (§5.1): which column it is and what it says. */
export interface GhostSlot {
  /** The column index; `columns.length` for a slot after the last column. */
  index: number
  /** The axis label of an added slot (`Q4 FY26`); '' when the slot is an existing column. */
  label: string
  /** `due Jan` or `overdue`. */
  text: string
  overdue: boolean
  /** The hover label's period line: `Q4 FY2026 · due by Jan 2027`. */
  fullLabel: string
}

/**
 * The ghost slot of a coarse row in the selected period, from `coarseStatus`:
 * the next period after a reported last column, or the last column itself
 * while it is due or overdue. Null when nothing is due or no period is selected.
 */
export function ghostSlot(row: ViewRow, columns: Column[], selectedPeriod: string | undefined, fyStart: number): GhostSlot | null {
  if (!selectedPeriod || !coarseColumnsShown(columns)) return null
  const last = parsePeriod(columns[columns.length - 1]?.period)
  if (!last) return null
  const s = coarseStatus(row, columns, selectedPeriod, fyStart)
  if (s.state === 'current') {
    const p = nextPeriod(last)
    const full = periodLabel(p, fyStart)
    return {
      index: columns.length,
      label: full.replace(/FY\d{2}(\d{2})$/, 'FY$1'),
      text: `due ${s.next.dueBy}`,
      overdue: false,
      fullLabel: `${full} · due by ${dueByLabel(p, fyStart)}`,
    }
  }
  if (s.state === 'due' || s.state === 'overdue') {
    const index = columns.length - 1
    const p = parsePeriod(columns[index]!.period)!
    const overdue = s.state === 'overdue'
    return {
      index,
      label: '',
      text: overdue ? 'overdue' : `due ${s.next.dueBy}`,
      overdue,
      fullLabel: `${periodLabel(p, fyStart)} · ${overdue ? 'overdue since' : 'due by'} ${dueByLabel(p, fyStart)}`,
    }
  }
  return null
}

/**
 * The ghost slot drawn in the plot: a dashed connector from the last value
 * to a dashed 4px ring at its height, and the slot's text above the ring.
 */
export function GhostMark({ ghost, slots, from, overdueColor }: { ghost: GhostSlot; slots: number; from: { index: number; value: number } | null; overdueColor: string }) {
  const plot = usePlotArea()
  const yScale = useYAxisScale()
  if (!plot || !yScale) return null
  const band = plot.width / Math.max(slots, 1)
  const x = plot.x + (ghost.index + 0.5) * band
  const y = from ? (yScale(from.value) ?? plot.y + plot.height / 2) : plot.y + plot.height / 2
  const x0 = from ? plot.x + (from.index + 0.5) * band : null
  return (
    <g data-role="ghost" pointerEvents="none">
      {x0 !== null && x0 < x - 6 && (
        <line x1={x0 + 5} x2={x - 5} y1={y} y2={y} stroke="var(--color-ink)" strokeOpacity={0.55} strokeDasharray="3 3" strokeWidth={1.25} />
      )}
      <circle cx={x} cy={y} r={4} fill="#FFFFFF" stroke="var(--color-ink)" strokeOpacity={0.55} strokeDasharray="2 2" strokeWidth={1.5} />
      <text
        data-role="ghost-label"
        x={x}
        y={y - 10}
        textAnchor="middle"
        fontSize={11}
        fontWeight={ghost.overdue ? 600 : 400}
        fill={ghost.overdue ? overdueColor : 'var(--color-ink)'}
        fillOpacity={ghost.overdue ? 1 : TICK_OPACITY}
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {ghost.text}
      </text>
    </g>
  )
}

/**
 * The points an item's line labels (§4): the current, then the lowest and
 * the largest move from its predecessor among the others (the current is
 * labelled anyway, so these add what it does not say). Current first.
 */
export function itemLabelIndices(points: ChartPoint[]): number[] {
  const valued = points.flatMap((p, i) => (p.kind === 'value' && p.value !== null ? [{ i, v: p.value }] : []))
  const last = points.length - 1
  const current = valued.find((x) => x.i === last)
  const others = valued.filter((x) => x.i !== last)
  const lowest = others.reduce<{ i: number; v: number } | null>((m, x) => (m === null || x.v < m.v ? x : m), null)
  let move: { i: number; d: number } | null = null
  for (const x of others) {
    const prior = points[x.i - 1]
    if (prior?.kind !== 'value' || prior.value === null) continue
    const d = Math.abs(x.v - prior.value)
    if (d > 0 && (move === null || d > move.d)) move = { i: x.i, d }
  }
  return [...new Set([current?.i, lowest?.i, move?.i].filter((i): i is number => i !== undefined))]
}

/** Labels this close (vertically, where they overlap across) collide; the later one is dropped. */
const LABEL_CLEARANCE = 14

/**
 * Value labels for chosen points, in priority order: the current one to the
 * left of its dot, the others above theirs; a label that would collide with
 * one already placed is dropped.
 */
export function PointLabels({ points, indices, slots, last }: { points: ChartPoint[]; indices: number[]; slots: number; last: number }) {
  const plot = usePlotArea()
  const yScale = useYAxisScale()
  if (!plot || !yScale) return null
  const band = plot.width / Math.max(slots, 1)
  const placed: { x0: number; x1: number; y: number }[] = []
  const out: ReactNode[] = []
  for (const i of indices) {
    const p = points[i]
    if (!p || p.value === null || !p.display) continue
    const cx = plot.x + (i + 0.5) * band
    const cy = yScale(p.value) ?? 0
    const w = p.display.length * 6.6
    const left = i === last
    const box = left ? { x0: cx - 8 - w, x1: cx - 8, y: cy } : { x0: cx - w / 2, x1: cx + w / 2, y: cy - 12 }
    if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && Math.abs(b.y - box.y) < LABEL_CLEARANCE)) continue
    placed.push(box)
    out.push(
      <text
        key={p.key}
        data-role="value-label"
        x={left ? cx - 8 : cx}
        y={left ? cy : cy - 9}
        dy={left ? '0.35em' : undefined}
        textAnchor={left ? 'end' : 'middle'}
        fontSize={11}
        fontWeight={600}
        fill="var(--color-ink)"
        fillOpacity={0.8}
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {p.display}
      </text>,
    )
  }
  return <g data-role="point-labels">{out}</g>
}

/** A point's value label (`ValueDot`), which marker text must not cover. */
export interface ValueLabel {
  index: number
  value: number
  text: string
}

/** The box `ValueDot` draws a label in: 11px semibold text, its baseline 6px above the dot. */
function valueLabelBox(label: ValueLabel, cx: number, cy: number, last: number) {
  const r = label.index === last ? 4 : 3
  const half = (label.text.length * 6.6) / 2
  const baseline = cy - r - 6
  return { x0: cx - half, x1: cx + half, y0: baseline - 10, y1: baseline + 3 }
}

/**
 * A methodology change: a dashed ink/55 line on the column's left edge and
 * the hover text as a title; with `text`, its 10px ink/70 label at the top of
 * the plot, or the bottom when a value label is in the way, or none.
 */
function MarkerLabel({
  viewBox,
  marker,
  columns,
  prev,
  next,
  text,
  values,
}: LabelViewBox & { marker: VersionMarker; columns: number; prev?: number; next?: number; text: boolean; values: ValueLabel[] }) {
  const plot = usePlotArea()
  const yScale = useYAxisScale()
  const { x = 0, y = 0, height = 0 } = viewBox ?? {}
  const column = plot ? plot.width / Math.max(columns, 1) : Infinity
  const width = marker.label.length * 5.6 + 8
  // Flip to the line's left when the label would run past the plot's right edge.
  const flip = (plot ? plot.x + plot.width : Infinity) - x < width
  // The text goes when it would run into the neighbouring marker's line; the line and title stay.
  const room = flip ? (prev === undefined ? Infinity : (marker.index - prev) * column) : next === undefined ? Infinity : (next - marker.index) * column
  const x0 = flip ? x - 4 - width : x + 4
  const x1 = x0 + width
  const boxes = plot && yScale ? values.map((v) => valueLabelBox(v, plot.x + (v.index + 0.5) * column, yScale(v.value) ?? 0, columns - 1)) : []
  const clear = (baseline: number) => boxes.every((b) => b.x1 <= x0 || b.x0 >= x1 || b.y1 <= baseline - 9 || b.y0 >= baseline + 3)
  const baseline = !text || room < width ? null : [y + 10, y + height - 4].find(clear) ?? null
  return (
    <g data-role="version-marker">
      <title>{marker.title}</title>
      <line x1={x} x2={x} y1={y} y2={y + height} stroke="var(--color-ink)" strokeOpacity={0.55} strokeDasharray="3 3" strokeWidth={1} />
      {/* A wider transparent stroke, so the 1px line's title is easy to hover. */}
      <line x1={x} x2={x} y1={y} y2={y + height} stroke="transparent" strokeWidth={8} />
      {baseline !== null && (
        <text
          x={flip ? x - 4 : x + 4}
          y={baseline}
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

/**
 * One reference line per methodology change, on the boundary before its
 * column (§7.2); a direct child of the chart. Text only with `text` (focus),
 * kept off `values`' labels; tiles draw the line and its hover title alone.
 */
export function markerLines(markers: VersionMarker[], columns: Column[], { text = false, values = [] }: { text?: boolean; values?: ValueLabel[] } = {}) {
  const shown = markers.filter((m) => columns[m.index]).sort((a, b) => a.index - b.index)
  return shown.map((m, k) => (
    <ReferenceLine
      key={`marker-${columns[m.index]!.key}`}
      x={columns[m.index]!.key}
      position="start"
      stroke="none"
      label={(props: LabelViewBox) => (
        <MarkerLabel
          viewBox={props.viewBox}
          marker={m}
          columns={columns.length}
          prev={shown[k - 1]?.index}
          next={shown[k + 1]?.index}
          text={text}
          values={values}
        />
      )}
    />
  ))
}

/** Under small multiples, which draw marker lines without text: `dashed line: methodology changed from Jul 2026`. */
export function markerCaption(markers: VersionMarker[], columns: Column[]): string {
  const when = markers.flatMap((m) => (columns[m.index] ? [columns[m.index]!.fullLabel] : []))
  if (when.length === 0) return ''
  return `${when.length === 1 ? 'dashed line' : 'dashed lines'}: methodology changed from ${when.join(', ')}`
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
  ghost = null,
}: {
  points: ChartPoint[]
  scale: StatusLevel[]
  size: ChartSize
  inset: { left: number; right: number }
  phone?: boolean
  /** The next period's slot: a dashed empty cell at this index (`points.length` appends one). */
  ghost?: number | null
}) {
  const focus = size === 'focus' && !phone
  const cell = 'flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden rounded-sm'
  const dashed = <span key="ghost" data-status="ghost" className={`${cell} border border-dashed border-ink/25`} />
  return (
    <div
      data-testid="status-ribbon"
      aria-hidden="true"
      className={`mt-1 flex gap-px font-semibold leading-none ${focus ? 'h-[22px] text-xs' : 'h-[18px] text-[11px]'}`}
      style={{ marginLeft: inset.left, marginRight: inset.right }}
    >
      {points.map((p, i) => {
        if (i === ghost && p.kind !== 'value') return dashed
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
      {ghost === points.length && dashed}
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
