import { useId, useMemo, useState } from 'react'
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
  axisLabel,
  BAND_PILL,
  BandPill,
  BandRect,
  capPercent,
  coarseColumnsShown,
  CurrentDot,
  GUIDE,
  GuidePill,
  hoverTooltip,
  markerLines,
  markerNotes,
  monthSpan,
  percentMax,
  PeriodTick,
  PHONE_AXIS_WIDTH,
  PointButtons,
  PointControls,
  sizeSpec,
  StatusMarker,
  StatusRibbon,
  usePhone,
  ValueDot,
  valueAxis,
  ValueTick,
  yDomain,
  type BandShapeProps,
  type ChartSize,
  type DotProps,
  type LabelViewBox,
  type TickProps,
} from './chartParts'
import { chartTheme } from './chartTheme'
import type { ChartPoint } from './points'
import type { VersionMarker } from './versionMarkers'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

/** One series' line over its bands, goal and status ribbon (§7.1); several series go to `MultiSeriesChart`. */
export function RatioChart({
  row,
  points,
  columns,
  scale,
  target,
  animated,
  size,
  fyStart,
  framed = false,
  valuePoints = false,
  markers = [],
}: {
  row: ViewRow
  /** The row's points over `columns`: the line and the status ribbon. */
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  target: number | null
  animated: boolean
  size: ChartSize
  fyStart: number
  /** Inside a tile frame, whose value row already states the current value. */
  framed?: boolean
  /** Coarse and discrete metrics: a visible point and value on every period (§5.5). */
  valuePoints?: boolean
  /** Methodology changes within the columns (§7.2). */
  markers?: VersionMarker[]
}) {
  const focus = size === 'focus'
  const phone = usePhone() && focus
  const base = sizeSpec(size, 120, phone)
  // Room above the highest point for its value label.
  const spec = valuePoints ? { ...base, margin: { ...base.margin, top: base.margin.top + 14 } } : base
  const coarse = coarseColumnsShown(columns)
  // Eight quarters show Q3 twice: name each point by its full period then.
  const fullNames = coarse && new Set(columns.map((c) => c.label)).size < columns.length
  const gradientId = `area-${useId().replace(/[^\w-]/g, '')}`
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverColumns = useMemo(
    () => (coarse ? columns.map((c) => ({ ...c, fullLabel: monthSpan(c, fyStart) })) : columns),
    [coarse, columns, fyStart],
  )
  const hoverSeries = useMemo(() => [{ name: row.subjectName, color: ACCENT, points }], [row.subjectName, points])
  const lastIndex = columns.length - 1
  const currentPoint = points[lastIndex]
  const currentValue = currentPoint?.kind === 'value' ? currentPoint.value : null
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  const padded = capPercent(row.format, yDomain(points, target), values)
  const fitted = focus ? valueAxis(row.format, padded, currentValue !== null ? [currentPoint!.display] : [], percentMax(row.format, values)) : null
  const axis = fitted && phone ? { ...fitted, width: PHONE_AXIS_WIDTH } : fitted
  const domain = axis?.domain ?? padded
  const currentCell = row.cells.find((c) => cellKey(c) === columns[lastIndex]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const rects = statusIntervals(bands, domain)
  const inset = { left: spec.margin.left, right: spec.margin.right + (axis?.width ?? 0) }
  const labels = new Map(columns.map((c) => [c.key, axisLabel(c)]))

  const data = columns.map((col, i) => ({ i, label: col.label, key: col.key, plot: points[i]?.kind === 'value' ? points[i]!.value : null }))

  return (
    <div>
      <div
        data-testid="metric-chart"
        data-size={size}
        data-bands={rects.map((r) => `${r.status}:${r.y0}-${r.y1}`).join(' ')}
        data-domain-max={domain[1]}
        data-axis-width={axis?.width}
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
              // Phones label every other period themselves, so none is dropped at random.
              interval={phone ? 0 : undefined}
              tick={(props: TickProps) => <PeriodTick {...props} labels={labels} last={lastIndex} fontSize={spec.tick} every={phone ? 2 : 1} />}
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
                // 11px in the phone's 48px axis, so `100.0%` fits.
                tick={(props: TickProps) => <ValueTick {...props} format={axis.format} fontSize={phone ? 11 : spec.tick} avoid={currentValue} />}
                width={axis.width}
              />
            ) : (
              <YAxis hide domain={domain} allowDataOverflow />
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
            {markerLines(markers, columns)}
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
                label={(props: LabelViewBox) => (
                  <AxisPill viewBox={props.viewBox} text={currentPoint!.display} axisWidth={axis.width} fontSize={phone ? 11 : 12} />
                )}
              />
            )}
            {hoverTooltip(hoverColumns, hoverSeries, scale, animated, spec.margin.top, markerNotes(markers))}
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
            <Line
              type="monotoneX"
              dataKey="plot"
              stroke={ACCENT}
              strokeWidth={spec.stroke}
              dot={(props: DotProps) =>
                valuePoints ? (
                  <ValueDot
                    {...props}
                    key={`dot-${props.index}`}
                    dataKey="plot"
                    last={lastIndex}
                    color={ACCENT}
                    text={points[props.index ?? -1]?.display ?? null}
                  />
                ) : (
                  <CurrentDot {...props} key={`dot-${props.index}`} dataKey="plot" last={lastIndex} r={spec.dot} color={ACCENT} />
                )
              }
              activeDot={(props: DotProps) => <ActiveDot cx={props.cx} cy={props.cy} r={spec.activeDot} color={ACCENT} />}
              isAnimationActive={animated}
              {...ANIMATION}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <StatusRibbon points={points} scale={scale} size={size} inset={inset} phone={phone} />
      {!focus && !framed && currentPoint?.kind === 'value' && (
        <p data-testid="current-point-label" className="mt-1 text-xs text-ink/80">
          Current: {currentPoint.display}{' '}
          <StatusMarker theme={chartTheme(scale, currentPoint.status)} />
        </p>
      )}
      <PointControls tip={tip} scale={scale}>
        <PointButtons points={points} onSelect={setTip} full={fullNames} />
      </PointControls>
    </div>
  )
}
