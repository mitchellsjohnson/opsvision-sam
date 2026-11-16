import { useMemo, useState } from 'react'
import { Bar, BarChart, ReferenceArea, ReferenceLine, ResponsiveContainer, usePlotArea, XAxis, YAxis } from 'recharts'
import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import { formatMetricValue } from '../format'
import { cellKey } from '../viewHelpers'
import { statusIntervals } from './bands'
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
  tickStyle,
  usePhone,
  type BandShapeProps,
  type ChartSize,
  type LabelViewBox,
  type TickProps,
} from './chartParts'
import { barFill, chartTheme } from './chartTheme'
import { deviationText, moneyPlanContext, moneyPlanDomain, PLAN } from './moneyPlan'
import type { ChartPoint } from './points'

export { moneyPlanDomain } from './moneyPlan'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

/** Solid ink at 55%: the plan is the reference every bar starts from. */
const PLAN_LINE = { stroke: 'var(--color-ink)', strokeOpacity: 0.55, strokeWidth: 1 } as const

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

/** The plan's label: `Plan` past the line's right end on a tile, a pill on the axis in focus. */
function PlanLabel({ viewBox, focus, axisWidth }: LabelViewBox & { focus: boolean; axisWidth: number }) {
  const { x = 0, y = 0, width = 0 } = viewBox ?? {}
  if (!focus) {
    return (
      <text
        data-role="plan-label"
        x={x + width + 4}
        y={y}
        dy="0.35em"
        textAnchor="start"
        fontSize={10}
        fontWeight={600}
        fill="var(--color-ink)"
        fillOpacity={0.7}
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
 * When the labels are wider than a column, every other one is shown (every
 * third, and so on), counted back from the current period, which always has one.
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
}: BarShapeProps & { point: ChartPoint | undefined; text: string; count: number; widest: number; scale: StatusLevel[] }) {
  const plot = usePlotArea()
  if (!point || point.kind !== 'value' || point.value === null) return <g />
  const over = point.value > PLAN
  const { fill, stroke } = barFill(scale, point.status)
  const column = plot ? plot.width / Math.max(count, 1) : Infinity
  const step = Math.max(1, Math.ceil((widest * 6.6 + 4) / column))
  const labelled = (count - 1 - index) % step === 0
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

/**
 * Spend against plan: a bar per period from a solid 100% line, up when over
 * plan and down when under, filled by status tier with its deviation at the
 * bar's end, over the band zones; the status ribbon below (§7.4).
 */
export function MoneyPlanChart({
  row,
  points,
  columns,
  scale,
  animated,
  size,
}: {
  row: ViewRow
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  animated: boolean
  size: ChartSize
}) {
  const focus = size === 'focus'
  const phone = usePhone() && focus
  const base = sizeSpec(size, 120, phone)
  // Room above and below the plot for the deviation labels at the bar ends.
  const spec = {
    ...base,
    margin: { ...base.margin, top: base.margin.top + 10, bottom: 12, right: focus ? base.margin.right : TILE_PLAN_ROOM },
  }
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverSeries = useMemo(() => [{ name: '', color: ACCENT, points }], [points])
  const values = points.flatMap((p) => (p.kind === 'value' && p.value !== null ? [p.value] : []))
  const domain = moneyPlanDomain(values)
  const currentCell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const edges = [...new Set((bands ?? []).filter((b) => b.op !== '' && b.value > domain[0] && b.value < domain[1] && b.value !== PLAN).map((b) => b.value))].sort(
    (a, b) => a - b,
  )
  const tickText = (v: number) => formatMetricValue(row.format, v)
  const axisWidth = focus ? Math.max(44, Math.ceil(Math.max(4, ...edges.map((e) => tickText(e).length)) * 7.2) + 14) : 0
  const inset = { left: spec.margin.left, right: spec.margin.right + axisWidth }
  const labels = new Map(columns.map((c) => [c.key, c.label]))
  const data: Datum[] = points.map((p, i) => ({
    i,
    key: p.key,
    range: p.kind === 'value' && p.value !== null ? [Math.min(PLAN, p.value), Math.max(PLAN, p.value)] : null,
  }))

  const deviations = points.map((p) => (p.kind === 'value' && p.value !== null ? deviationText(p.value, row.format) : ''))
  const widest = Math.max(0, ...deviations.map((d) => d.length))
  const shape = (props: BarShapeProps) => (
    <PlanBar {...props} point={points[props.index ?? -1]} text={deviations[props.index ?? -1] ?? ''} count={points.length} widest={widest} scale={scale} />
  )

  return (
    <div>
      {values.length > 0 && (
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
              // Phones label every other period, counted back from the current one, as the line chart does.
              interval={phone ? 0 : undefined}
              tick={
                phone
                  ? (props: TickProps) => <PeriodTick {...props} labels={labels} last={columns.length - 1} fontSize={spec.tick} every={2} />
                  : tickStyle(spec)
              }
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
            {hoverTooltip(columns, hoverSeries, scale, animated, spec.margin.top)}
            <Bar dataKey="range" maxBarSize={spec.maxBar} shape={shape} isAnimationActive={animated} {...ANIMATION} />
            <ReferenceLine
              className="plan-line"
              y={PLAN}
              {...PLAN_LINE}
              label={(props: LabelViewBox) => <PlanLabel viewBox={props.viewBox} focus={focus} axisWidth={axisWidth} />}
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
