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
import { ChangeBars } from './ChangeBarsChart'
import { changeBarsFor, changeCaption, changeEdges, isChangeRow } from './changeBars'
import {
  ACCENT,
  ActiveDot,
  ANIMATION,
  AxisPill,
  axisLabel,
  BAND_PILL,
  bandEdges,
  BandPill,
  BandRect,
  capPercent,
  coarseColumnsShown,
  CurrentDot,
  GhostMark,
  ghostSlot,
  GUIDE,
  GuidePill,
  hoverTooltip,
  itemLabelIndices,
  markerLines,
  markerNotes,
  monthSpan,
  percentMax,
  PeriodTick,
  PHONE_AXIS_WIDTH,
  PointButtons,
  PointControls,
  PointLabels,
  sizeSpec,
  StatusMarker,
  StatusRibbon,
  thresholdLabelWidth,
  thresholdLines,
  usePhone,
  ValueDot,
  valueAxis,
  ValueTick,
  valuesDomain,
  withNearEdges,
  type BandShapeProps,
  type ChartSize,
  type DotProps,
  type LabelViewBox,
  type Threshold,
  type TickProps,
  type ValueLabel,
} from './chartParts'
import { chartTheme } from './chartTheme'
import type { ChartPoint } from './points'
import type { VersionMarker } from './versionMarkers'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']
type StatusLevel = Schemas['StatusLevel']

/** The level line above change bars on a tile (§9): just the trend, no axis. */
const CHANGE_TILE_HEIGHT = 48
/** A change-bar tile's right gutter: `worse`, `+5%`, `better`. */
const CHANGE_GUTTER = 40

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
  curve,
  selectedPeriod,
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
  /**
   * Straight segments with labelled threshold lines, or the approved monthly
   * curve. Coarse and item rows default to `linear`, the rest to `monotone`.
   */
  curve?: 'monotone' | 'linear'
  /** The month the user picked: places the next coarse period's slot (§5.1). */
  selectedPeriod?: string
}) {
  const focus = size === 'focus'
  const phone = usePhone() && focus
  const coarse = coarseColumnsShown(columns)
  const item = row.subjectKind === 'item'
  const linear = (curve ?? (coarse || item ? 'linear' : 'monotone')) === 'linear'
  const change = isChangeRow(row, columns)
  // A change tile draws a short level line; its bars say what set each status.
  const changeTile = change && !focus
  const base = sizeSpec(size, changeTile ? CHANGE_TILE_HEIGHT : 120, phone)
  const lastIndex = columns.length - 1
  const currentPoint = points[lastIndex]
  const currentValue = currentPoint?.kind === 'value' ? currentPoint.value : null
  // Item lines label the current, the lowest and the largest move; coarse and discrete label every point.
  const labelled = item && linear ? itemLabelIndices(points) : []
  const pointLabels = valuePoints || labelled.length > 0 || changeTile
  const ghost = coarse ? ghostSlot(row, columns, selectedPeriod, fyStart) : null
  const slots = ghost && ghost.index === columns.length ? columns.length + 1 : columns.length
  // Eight quarters show Q3 twice: name each point by its full period then.
  const fullNames = coarse && new Set(columns.map((c) => c.label)).size < columns.length
  const gradientId = `area-${useId().replace(/[^\w-]/g, '')}`
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const hoverColumns = useMemo(() => {
    const shown = coarse ? columns.map((c) => ({ ...c, fullLabel: monthSpan(c, fyStart) })) : columns
    if (!ghost) return shown
    const slot = { key: `ghost-${ghost.index}`, label: ghost.label, fullLabel: ghost.fullLabel, period: '', ytd: false }
    return ghost.index === columns.length ? [...shown, slot] : shown.map((c, i) => (i === ghost.index ? { ...c, fullLabel: ghost.fullLabel } : c))
  }, [coarse, columns, fyStart, ghost])
  const hoverSeries = useMemo(() => [{ name: row.subjectName, color: ACCENT, points }], [row.subjectName, points])
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  const currentCell = row.cells.find((c) => cellKey(c) === columns[lastIndex]?.key)
  const bands = currentCell?.rule?.type === 'bands' ? currentCell.rule.bands : undefined
  const reach = linear ? withNearEdges(values, bands, row.format) : values
  const padded = capPercent(row.format, valuesDomain(reach, target), values)

  // The threshold labels' text is known before the domain is: every edge the padded domain holds.
  const thresholdText = (edge: number, status: string) => {
    const shown = formatMetricValue(row.format, edge)
    if (!item) return shown
    const theme = chartTheme(scale, status)
    return phone ? `${theme.letter} ${shown.replace(/%$/, '')}` : `${theme.label || theme.letter} ${shown}`
  }
  const edgesOf = (domain: [number, number]): Threshold[] =>
    linear ? bandEdges(bands, domain).map((e) => ({ value: e.value, label: thresholdText(e.value, e.status), color: chartTheme(scale, e.status).color })) : []
  const draft = edgesOf(padded)
  // The current value has a label at its point when points are labelled, so the axis pill would repeat it.
  const pill = focus && !pointLabels && currentValue !== null
  const fitted = focus
    ? valueAxis(row.format, padded, [...(pill ? [currentPoint!.display] : []), ...draft.map((t) => t.label)], percentMax(row.format, values))
    : null
  const axis = fitted && phone ? { ...fitted, width: Math.max(PHONE_AXIS_WIDTH, thresholdLabelWidth(draft)) } : fitted
  const domain = axis?.domain ?? padded
  const thresholds = edgesOf(domain)
  const rects = statusIntervals(bands, domain)
  const tileRoom = changeTile ? CHANGE_GUTTER : !focus ? thresholdLabelWidth(thresholds) : 0
  const spec = {
    ...base,
    margin: {
      ...base.margin,
      // Room above the highest point for its value label.
      top: base.margin.top + (pointLabels ? 14 : 0),
      right: base.margin.right + tileRoom,
    },
  }
  const inset = { left: spec.margin.left, right: spec.margin.right + (axis?.width ?? 0) }
  const labels = new Map(columns.map((c) => [c.key, axisLabel(c)]))
  if (ghost && ghost.index === columns.length) labels.set(`ghost-${ghost.index}`, ghost.label)

  const data = columns.map((col, i) => ({ i, label: col.label, key: col.key, plot: points[i]?.kind === 'value' ? points[i]!.value : null }))
  if (ghost && ghost.index === columns.length) data.push({ i: columns.length, label: ghost.label, key: `ghost-${ghost.index}`, plot: null })
  const valueLabels: ValueLabel[] = valuePoints
    ? points.flatMap((p, index) => (p.kind === 'value' && p.value !== null && p.display ? [{ index, value: p.value, text: p.display }] : []))
    : []
  const lastValued = (() => {
    const before = ghost ? ghost.index : columns.length
    for (let i = Math.min(before, columns.length) - 1; i >= 0; i--) {
      if (points[i]?.kind === 'value' && points[i]!.value !== null) return { index: i, value: points[i]!.value! }
    }
    return null
  })()
  const type = linear ? 'linear' : 'monotoneX'
  const dots = valuePoints || (linear && item) || changeTile
  const dotText = (index: number) => {
    if (valuePoints && !(linear && item)) return points[index]?.display ?? null
    if (changeTile && index === lastIndex) return points[index]?.display ?? null
    return null
  }
  const lines = thresholds.map((t) => t.value)
  const changeBars = change ? changeBarsFor(row, columns) : []
  const { edges: changeEdgeList, red } = change ? changeEdges(row, columns) : { edges: [], red: null }

  return (
    <div>
      <div
        data-testid="metric-chart"
        data-size={size}
        data-bands={rects.map((r) => `${r.status}:${r.y0}-${r.y1}`).join(' ')}
        data-domain-min={domain[0]}
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
              // A change tile names its months under the ribbon instead.
              hide={changeTile}
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
                tick={(props: TickProps) => (
                  <ValueTick {...props} format={axis.format} fontSize={phone ? 11 : spec.tick} avoid={pill ? currentValue : null} lines={lines} />
                )}
                width={axis.width}
              />
            ) : (
              // The domain holds every value; letting data overflow would clip the points and their labels to the plot.
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
                  // Labelled threshold lines name the bands; the letter pills would repeat them.
                  label={focus && thresholds.length === 0 ? (props: LabelViewBox) => <BandPill viewBox={props.viewBox} theme={theme} /> : undefined}
                />
              )
            })}
            {thresholdLines(thresholds)}
            {markerLines(markers, columns, { text: focus, values: valueLabels })}
            {/* A goal on a threshold line is that line; elsewhere it keeps its own. */}
            {target !== null && !lines.includes(target) && (
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
                          gap={rects.length > 0 && thresholds.length === 0 ? BAND_PILL.width + 6 : 0}
                          avoid={pill ? currentValue : null}
                        />
                      )
                    : undefined
                }
              />
            )}
            {axis && pill && (
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
              type={type}
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
              type={type}
              dataKey="plot"
              stroke={ACCENT}
              strokeWidth={spec.stroke}
              dot={(props: DotProps) =>
                changeTile && props.index !== lastIndex ? (
                  <g key={`dot-${props.index}`} />
                ) : dots ? (
                  <ValueDot {...props} key={`dot-${props.index}`} dataKey="plot" last={lastIndex} color={ACCENT} text={dotText(props.index ?? -1)} />
                ) : (
                  <CurrentDot {...props} key={`dot-${props.index}`} dataKey="plot" last={lastIndex} r={spec.dot} color={ACCENT} />
                )
              }
              activeDot={(props: DotProps) => <ActiveDot cx={props.cx} cy={props.cy} r={spec.activeDot} color={ACCENT} />}
              isAnimationActive={animated}
              {...ANIMATION}
              connectNulls={false}
            />
            {labelled.length > 0 && <PointLabels points={points} indices={labelled} slots={slots} last={lastIndex} />}
            {ghost && <GhostMark ghost={ghost} slots={slots} from={lastValued} overdueColor={chartTheme(scale, worstKey(scale)).color} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {change && (
        <ChangeBars
          bars={changeBars}
          scale={scale}
          size={size}
          inset={inset}
          edges={changeEdgeList}
          red={red}
          caption={changeCaption(currentCell?.rule?.compare, columns[0])}
        />
      )}
      <StatusRibbon points={points} scale={scale} size={size} inset={inset} phone={phone} ghost={ghost?.index ?? null} />
      {changeTile && (
        <div aria-hidden="true" className="mt-0.5 flex gap-px text-[11px] leading-4" style={{ marginLeft: inset.left, marginRight: inset.right }}>
          {columns.map((c, i) => (
            <span
              key={c.key}
              data-role="month-initial"
              className={`min-w-0 flex-1 text-center ${i === lastIndex ? 'font-semibold text-accent-deep' : 'text-ink/70'}`}
            >
              {c.label.charAt(0)}
            </span>
          ))}
        </div>
      )}
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

/** The scale's worst status: its color marks an overdue period. */
function worstKey(scale: StatusLevel[]): string {
  return [...scale].sort((a, b) => b.rank - a.rank)[0]?.key ?? 'R'
}
