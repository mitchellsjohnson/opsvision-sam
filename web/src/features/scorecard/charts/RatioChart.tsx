import { Fragment, useId, useMemo, useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import { formatMetricValue } from '../format'
import { cellKey } from '../viewHelpers'
import { statusIntervals } from './bands'
import {
  ACCENT,
  ActiveDot,
  ANIMATION,
  AxisPill,
  BAND_PILL,
  BandPill,
  BandRect,
  CurrentDot,
  GUIDE,
  GuidePill,
  hoverTooltip,
  PointButtons,
  PointControls,
  seriesColor,
  sizeSpec,
  StatusMarker,
  StatusRibbon,
  tickStyle,
  valueAxis,
  yDomain,
  type BandShapeProps,
  type ChartSize,
  type DotProps,
  type LabelViewBox,
} from './chartParts'
import { chartTheme } from './chartTheme'
import { buildPoints, type ChartPoint } from './points'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

export function RatioChart({
  row,
  chartRows,
  points,
  columns,
  scale,
  target,
  animated,
  size,
  fyStart,
  framed = false,
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
  /** Inside a tile frame, whose value row already states the current value. */
  framed?: boolean
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
      {!focus && !framed && currentPoint?.kind === 'value' && (
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
