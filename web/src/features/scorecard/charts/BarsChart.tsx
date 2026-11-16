import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import {
  ACCENT,
  ANIMATION,
  barDomain,
  GUIDE,
  GuidePill,
  hoverTooltip,
  PointButtons,
  PointControls,
  sizeSpec,
  StatusRibbon,
  tickStyle,
  valueAxis,
  type ChartSize,
  type LabelViewBox,
} from './chartParts'
import type { ChartPoint } from './points'

type StatusLevel = components['schemas']['StatusLevel']

export interface BarsProps {
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
export function BarsChart({ points, columns, format, scale, animated, size, plan }: BarsProps) {
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
