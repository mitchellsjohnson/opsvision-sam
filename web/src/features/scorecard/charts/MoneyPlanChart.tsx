import { useMemo, useState } from 'react'
import { Bar, BarChart, ReferenceArea, ReferenceLine, ResponsiveContainer, usePlotArea, XAxis, YAxis } from 'recharts'
import type { components } from '../../../api/schema'
import { useElementWidth } from '../../../ui/useElementWidth'
import type { Column } from '../columns'
import { formatMetricValue } from '../format'
import { cellKey } from '../viewHelpers'
import { bandStatus, statusIntervals } from './bands'
import {
  ACCENT,
  ANIMATION,
  BandRect,
  hoverTooltip,
  PeriodTick,
  PointButtons,
  PointControls,
  sizeSpec,
  StatusRibbon,
  thresholdLines,
  tickStyle,
  usePhone,
  type BandShapeProps,
  type ChartSize,
  type LabelViewBox,
  type Threshold,
  type TickProps,
} from './chartParts'
import { barFill, chartTheme } from './chartTheme'
import { deviationText, moneyPlanContext, moneyPlanDomain, PLAN } from './moneyPlan'
import type { ChartPoint } from './points'

export { moneyPlanDomain } from './moneyPlan'

type Band = components['schemas']['Band']

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

/** Solid ink at 55%: the plan is the reference every bar starts from. */
const PLAN_LINE = { stroke: 'var(--color-ink)', strokeOpacity: 0.55, strokeWidth: 1 } as const

/** A month on the axis: every one with room, else every other counted back from the current one. */
function MonthTick({ thin, ...props }: TickProps & { labels: Map<string, string>; last: number; fontSize: number; thin: boolean | null }) {
  const narrow = useNarrow(thin, props.last + 1)
  return <PeriodTick {...props} every={narrow ? 2 : 1} />
}

interface Datum {
  i: number
  key: string
  /** From the plan to the value, low end first: a bar grows up when over plan and down when under. */
  range: [number, number] | null
}

interface BarShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  index?: number
}

/** A tile's right margin: room for `Plan` past the line's end, where no bar or deviation label reaches. */
const TILE_PLAN_ROOM = 28
/** Under this many pixels a month, labels thin out and `Plan` moves to the line's left end (§6). */
const NARROW_SLOT = 32

/** Whether a slot is narrow: from the measured width when known, else from the plot. */
function useNarrow(narrow: boolean | null, count: number): boolean {
  const plot = usePlotArea()
  if (narrow !== null) return narrow
  return plot ? plot.width / Math.max(count, 1) < NARROW_SLOT : false
}

/**
 * The plan's label: `Plan` past the line's right end on a tile, a pill on the
 * axis in focus. In narrow slots on a tile it sits at the line's left end, on
 * the side the first bar does not take.
 */
function PlanLabel({
  viewBox,
  focus,
  axisWidth,
  narrow,
  count,
  firstOver,
}: LabelViewBox & { focus: boolean; axisWidth: number; narrow: boolean | null; count: number; firstOver: boolean }) {
  const { x = 0, y = 0, width = 0 } = viewBox ?? {}
  const atStart = useNarrow(narrow, count)
  if (!focus) {
    return (
      <text
        data-role="plan-label"
        x={atStart ? x : x + width + 4}
        y={atStart ? (firstOver ? y + 10 : y - 4) : y}
        dy={atStart ? undefined : '0.35em'}
        textAnchor="start"
        fontSize={10}
        fontWeight={600}
        fill="var(--color-ink)"
        fillOpacity={0.7}
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        Plan
      </text>
    )
  }
  const h = 18
  const left = x + width + 2
  const w = Math.min(axisWidth - 4, 40)
  return (
    <g data-role="plan-pill">
      <rect x={left} y={y - h / 2} width={w} height={h} rx={3} fill="var(--color-ink)" fillOpacity={0.72} />
      <text x={left + w / 2} y={y} dy="0.35em" textAnchor="middle" fontSize={11} fontWeight={600} fill="#FFFFFF">
        Plan
      </text>
    </g>
  )
}

/**
 * One period's bar, filled by its tier, with its deviation past the bar's end.
 * In narrow slots only the current period and the largest deviation keep a
 * label; otherwise, when the labels are wider than a column, every other one
 * is shown (every third, and so on), counted back from the current period.
 */
function PlanBar({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  index = -1,
  point,
  text,
  count,
  widest,
  scale,
  narrow,
  largest,
}: BarShapeProps & {
  point: ChartPoint | undefined
  text: string
  count: number
  widest: number
  scale: StatusLevel[]
  narrow: boolean | null
  /** The index of the largest deviation. */
  largest: number
}) {
  const plot = usePlotArea()
  const thin = useNarrow(narrow, count)
  if (!point || point.kind !== 'value' || point.value === null) return <g />
  const over = point.value > PLAN
  const { fill, stroke } = barFill(scale, point.status)
  const column = plot ? plot.width / Math.max(count, 1) : Infinity
  const step = Math.max(1, Math.ceil((widest * 6.6 + 4) / column))
  const labelled = thin ? index === count - 1 || index === largest : (count - 1 - index) % step === 0
  return (
    <g>
      <rect
        data-bar=""
        data-key={point.key}
        data-status={point.status}
        x={x + 0.5}
        y={y}
        width={Math.max(width - 1, 0)}
        height={Math.max(height, 0)}
        fill={fill}
        stroke={stroke}
        strokeWidth={1}
      />
      {labelled && (
        <text
          data-role="deviation"
          x={x + width / 2}
          y={over ? y - 4 : y + height + 11}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--color-ink)"
          fillOpacity={0.8}
        >
          {text}
        </text>
      )}
    </g>
  )
}

/** The status an edge starts: the worse of the two either side of it, by rank. */
function startsAt(bands: Band[], edge: number, scale: StatusLevel[]): string {
  const rank = (k: string) => scale.find((s) => s.key === k)?.rank ?? -Infinity
  const below = bandStatus(bands, edge - 1e-9)
  const above = bandStatus(bands, edge + 1e-9)
  return rank(above) >= rank(below) ? above : below
}

/**
 * Spend against plan: a bar per period from a solid 100% line, up when over
 * plan and down when under, filled by status tier with its deviation at the
 * bar's end, over the band zones and dashed threshold lines; the status
 * ribbon below (§6, §7.4). Inside a tile frame the value row states the
 * over-plan count (`overPlanPhrase`), so the chart's context line is left out.
 */
export function MoneyPlanChart({
  row,
  points,
  columns,
  scale,
  animated,
  size,
  framed = false,
}: {
  row: ViewRow
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  animated: boolean
  size: ChartSize
  framed?: boolean
}) {
  const focus = size === 'focus'
  const phone = usePhone() && focus
  const base = sizeSpec(size, 120, phone)
  const [measure, measured] = useElementWidth<HTMLDivElement>()
  // Measured, the slot decides the margin as well; unmeasured, each label decides from the plot.
  const wideRight = focus ? base.margin.right : TILE_PLAN_ROOM
  const narrow = measured > 0 ? (measured - base.margin.left - wideRight) / Math.max(columns.length, 1) < NARROW_SLOT : null
  // Room above and below the plot for the deviation labels at the bar ends.
  const spec = {
    ...base,
    margin: { ...base.margin, top: base.margin.top + 10, bottom: 12, right: !focus && narrow ? base.margin.right : wideRight },
  }
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverSeries = useMemo(() => [{ name: '', color: ACCENT, points }], [points])
  const values = points.flatMap((p) => (p.kind === 'value' && p.value !== null ? [p.value] : []))
  const [under, over] = moneyPlanDomain(values.map((v) => v - PLAN))
  const domain: [number, number] = [PLAN + under, PLAN + over]
  const currentCell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const edges = [...new Set((bands ?? []).filter((b) => b.op !== '' && b.value > domain[0] && b.value < domain[1] && b.value !== PLAN).map((b) => b.value))].sort(
    (a, b) => a - b,
  )
  const thresholds: Threshold[] = edges.map((e) => {
    const status = startsAt(bands ?? [], e, scale)
    return { value: e, label: chartTheme(scale, status).letter, color: chartTheme(scale, status).color }
  })
  const tickText = (v: number) => `${formatMetricValue(row.format, v)} ${thresholds.find((t) => t.value === v)?.label ?? ''}`.trim()
  const axisWidth = focus ? Math.max(44, Math.ceil(Math.max(4, ...edges.map((e) => tickText(e).length)) * 7.2) + 14) : 0
  const inset = { left: spec.margin.left, right: spec.margin.right + axisWidth }
  const labels = new Map(columns.map((c) => [c.key, c.label]))
  const largest = points.reduce((best, p, i) => {
    if (p.kind !== 'value' || p.value === null) return best
    const b = points[best]
    return best < 0 || !b || b.value === null || Math.abs(p.value - PLAN) > Math.abs(b.value - PLAN) ? i : best
  }, -1)
  const first = points.find((p) => p.kind === 'value' && p.value !== null)
  const firstOver = first !== undefined && first.value! > PLAN
  const data: Datum[] = points.map((p, i) => ({
    i,
    key: p.key,
    range: p.kind === 'value' && p.value !== null ? [Math.min(PLAN, p.value), Math.max(PLAN, p.value)] : null,
  }))

  const deviations = points.map((p) => (p.kind === 'value' && p.value !== null ? deviationText(p.value, row.format) : ''))
  const widest = Math.max(0, ...deviations.map((d) => d.length))
  const shape = (props: BarShapeProps) => (
    <PlanBar
      {...props}
      point={points[props.index ?? -1]}
      text={deviations[props.index ?? -1] ?? ''}
      count={points.length}
      widest={widest}
      scale={scale}
      narrow={narrow}
      largest={largest}
    />
  )

  return (
    <div ref={measure}>
      {values.length > 0 && !framed && (
        <p data-testid="chart-context" className="mb-1 text-xs text-ink/70">
          {moneyPlanContext(points, columns)}
        </p>
      )}
      <div
        data-testid="metric-chart"
        data-size={size}
        data-domain={domain.join('-')}
        aria-hidden="true"
        className={spec.className}
        style={spec.style}
      >
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <BarChart data={data} accessibilityLayer={false} margin={spec.margin}>
            <XAxis
              // Keyed by period, as in the line chart, so repeated labels stay separate columns.
              dataKey="key"
              tickFormatter={(key: string) => labels.get(key) ?? ''}
              axisLine={false}
              tickLine={false}
              // Phones and narrow slots label every other period, counted back from the current one, as the line chart does.
              interval={0}
              tick={(props: TickProps) => <MonthTick {...props} labels={labels} last={columns.length - 1} fontSize={spec.tick} thin={phone || narrow} />}
              height={spec.xAxisHeight}
            />
            {focus ? (
              <YAxis
                orientation="right"
                domain={domain}
                ticks={edges}
                tick={edges.length > 0 ? tickStyle(spec) : false}
                interval={0}
                axisLine={false}
                tickLine={false}
                tickFormatter={tickText}
                width={axisWidth}
              />
            ) : (
              <YAxis hide domain={domain} />
            )}
            {rects.map((r, i) => (
              <ReferenceArea
                key={`band-${i}`}
                y1={r.y0}
                y2={r.y1}
                shape={(props: BandShapeProps) => <BandRect {...props} color={chartTheme(scale, r.status).color} opacity={0.07} />}
              />
            ))}
            {thresholdLines(thresholds, false)}
            {hoverTooltip(columns, hoverSeries, scale, animated, spec.margin.top)}
            <Bar dataKey="range" maxBarSize={spec.maxBar} shape={shape} isAnimationActive={animated} {...ANIMATION} />
            <ReferenceLine
              className="plan-line"
              y={PLAN}
              {...PLAN_LINE}
              label={(props: LabelViewBox) => (
                <PlanLabel viewBox={props.viewBox} focus={focus} axisWidth={axisWidth} narrow={narrow} count={columns.length} firstOver={firstOver} />
              )}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <StatusRibbon points={points} scale={scale} size={size} inset={inset} phone={phone} />
      <PointControls tip={tip} scale={scale}>
        <PointButtons points={points} onSelect={setTip} />
      </PointControls>
    </div>
  )
}
