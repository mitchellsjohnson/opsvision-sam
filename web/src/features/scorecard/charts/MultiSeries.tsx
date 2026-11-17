import { Fragment, useMemo, useState } from 'react'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  usePlotArea,
  useYAxisScale,
  XAxis,
  YAxis,
} from 'recharts'
import type { components } from '../../../api/schema'
import { StatusChip } from '../../../ui/status'
import { useElementWidth } from '../../../ui/useElementWidth'
import type { Column } from '../columns'
import { sinceText } from '../logic/statusText'
import { cellKey } from '../viewHelpers'
import { statusIntervals } from './bands'
import {
  ActiveDot,
  ANIMATION,
  axisLabel,
  BandRect,
  capPercent,
  CurrentDot,
  hoverTooltip,
  markerCaption,
  markerLines,
  markerNotes,
  PeriodTick,
  percentMax,
  PointButtons,
  PointControls,
  sizeSpec,
  StatusRibbon,
  usePhone,
  valueAxis,
  ValueTick,
  yDomain,
  type BandShapeProps,
  type ChartSize,
  type DotProps,
  type TickProps,
} from './chartParts'
import { chartTheme, statusFill } from './chartTheme'
import { drawOrder, frontSeries, lastValued, MULTIPLES_FROM, panelMonthLabels, pointCells, rangeText, spreadLabels, worstFirst } from './seriesLayout'
import { buildPoints, type ChartPoint } from './points'
import type { VersionMarker } from './versionMarkers'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']

interface Series {
  row: ViewRow
  points: ChartPoint[]
  color: string
}

/** Focus and context (§8): the series in front in the accent, the rest faded ink, so the focus color is the same on every tile. */
const FRONT = { color: 'var(--color-accent)', width: 2.5, dot: 4, opacity: 1 } as const
const CONTEXT = { color: 'var(--color-ink)', width: 1.5, dot: 3, opacity: 0.38 } as const
/** A context line's end dot: the line's faded ink, solid so the white ring stays crisp. */
const CONTEXT_DOT = 'color-mix(in srgb, var(--color-ink) 45%, white)'

interface MultiSeriesProps {
  rows: ViewRow[]
  columns: Column[]
  scale: StatusLevel[]
  animated: boolean
  size: ChartSize
  fyStart: number
  statusLabel: (key: string) => string
  markers?: VersionMarker[]
}

const PANEL_HEIGHT = 110
const CHIP = { width: 24, height: 14 }
const CHAR = { name: 6.4, value: 6.6 }

/** The band rule of a row's last column. */
function bandsOf(row: ViewRow, columns: Column[]) {
  const cell = row.cells.find((c) => cellKey(c) === columns[columns.length - 1]?.key)
  return cell?.rule?.type === 'bands' ? cell.rule.bands : undefined
}

/**
 * Several series with no total (§7.6). Overlaid lines labelled at their ends
 * (name, value, chip) on tiles, and in focus up to three series; from four in
 * focus, one small panel per series on a shared y-axis, worst first.
 */
export function MultiSeriesChart(props: MultiSeriesProps) {
  const { rows, columns, fyStart } = props
  const series = useMemo<Series[]>(
    () => rows.map((row) => ({ row, points: buildPoints(row, columns, fyStart), color: CONTEXT.color })),
    [rows, columns, fyStart],
  )
  return props.size === 'focus' && series.length >= MULTIPLES_FROM ? <SmallMultiples {...props} series={series} /> : <Overlaid {...props} series={series} />
}

/** The lines' end labels, drawn inside the chart so they sit at each line's last value. */
function EndLabels({
  series,
  labelWidth,
  statusLabel,
  scale,
  front,
  onHover,
}: {
  series: Series[]
  labelWidth: { name: number; value: number }
  statusLabel: (key: string) => string
  scale: StatusLevel[]
  front: string | null
  onHover: (id: string | null) => void
}) {
  const yScale = useYAxisScale()
  const plot = usePlotArea()
  if (!yScale || !plot) return null
  const ends = series.map((s) => ({ s, last: lastValued(s.points) })).filter((e) => e.last !== null)
  const ys = spreadLabels(
    ends.map((e) => yScale(e.last!.point.value!) ?? plot.y),
    plot.y + CHIP.height / 2,
    plot.y + plot.height - CHIP.height / 2,
  )
  const x = plot.x + plot.width + 8
  return (
    <g data-role="end-labels">
      {ends.map(({ s, last }, k) => {
        const y = ys[k]!
        const p = last!.point
        const theme = chartTheme(scale, p.status)
        const fill = statusFill(scale, p.status)
        const chipX = x + labelWidth.name + 6 + labelWidth.value + 6
        return (
          <g key={s.row.subjectId} data-role="end-label" onMouseEnter={() => onHover(s.row.subjectId)} onMouseLeave={() => onHover(null)}>
            <title>{`${s.row.subjectName}: ${p.display}${p.status ? `, ${statusLabel(p.status)}` : ''}`}</title>
            <text
              data-role="end-name"
              x={x}
              y={y}
              dy="0.35em"
              fontSize={11}
              fontWeight={600}
              fill={s.row.subjectId === front ? FRONT.color : 'var(--color-ink)'}
              fillOpacity={s.row.subjectId === front ? 1 : 0.7}
            >
              {s.row.subjectName}
            </text>
            <text data-role="end-value" x={x + labelWidth.name + 6} y={y} dy="0.35em" fontSize={11} fontWeight={600} fill="var(--color-ink)" className="tabular-nums">
              {p.display}
            </text>
            {p.status && (
              <g data-role="end-chip">
                <rect
                  x={chipX}
                  y={y - CHIP.height / 2}
                  width={CHIP.width}
                  height={CHIP.height}
                  rx={3}
                  fill={fill.background}
                  stroke={fill.border ?? 'none'}
                />
                <text x={chipX + CHIP.width / 2} y={y} dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} fill={fill.letter}>
                  {theme.shape}
                  {theme.letter}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </g>
  )
}

/** The end labels under a narrow plot: each line's swatch, name, last value and chip, top line first. */
function SeriesKey({ series, scale, front }: { series: Series[]; scale: StatusLevel[]; front: string | null }) {
  const ordered = [...series].sort(
    (a, b) => (lastValued(b.points)?.point.value ?? 0) - (lastValued(a.points)?.point.value ?? 0) || a.row.subjectName.localeCompare(b.row.subjectName),
  )
  return (
    <ul data-testid="series-key" aria-hidden="true" className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-1">
      {ordered.map((s) => {
        const p = lastValued(s.points)!.point
        const inFront = s.row.subjectId === front
        return (
          <li key={s.row.subjectId} className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 font-semibold">
            <span className={`h-0.5 w-3 shrink-0 rounded-full ${inFront ? 'bg-accent' : 'bg-ink/40'}`} />
            <span className={`min-w-0 truncate ${inFront ? 'text-accent' : 'text-ink/70'}`}>{s.row.subjectName}</span>
            <span className="text-ink tabular-nums">{p.display}</span>
            {p.status && <StatusChip status={p.status} scale={scale} />}
          </li>
        )
      })}
    </ul>
  )
}

function Overlaid({ series, columns, scale, animated, size, statusLabel, markers = [] }: MultiSeriesProps & { series: Series[] }) {
  const focus = size === 'focus'
  const phone = usePhone() && focus
  const spec = sizeSpec(size, 140, phone)
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const format = series[0]?.row.format ?? 'number0'
  const all = series.flatMap((s) => s.points)
  const values = all.map((p) => p.value).filter((v): v is number => v !== null)
  const padded = capPercent(format, yDomain(all, null), values)
  const axis = focus ? valueAxis(format, padded, [], percentMax(format, values)) : null
  const domain = axis?.domain ?? padded
  // One set of bands reads for every line only when they all share it.
  const rules = series.map((s) => JSON.stringify(bandsOf(s.row, columns) ?? null))
  const rects = rules.every((r) => r === rules[0]) && series[0] ? statusIntervals(bandsOf(series[0].row, columns), domain) : []
  const last = columns.length - 1
  const labels = new Map(columns.map((c) => [c.key, axisLabel(c)]))
  const shown = series.filter((s) => lastValued(s.points))
  const labelWidth = {
    name: Math.ceil(Math.max(0, ...shown.map((s) => s.row.subjectName.length)) * CHAR.name),
    value: Math.ceil(Math.max(0, ...shown.map((s) => lastValued(s.points)!.point.display.length)) * CHAR.value),
  }
  const endWidth = 8 + labelWidth.name + 6 + labelWidth.value + 6 + CHIP.width + 2
  const [measure, width] = useElementWidth<HTMLDivElement>()
  // Labels that would take over 40% of a narrow tile go under the plot instead.
  const below = width > 0 && endWidth > width * 0.4
  const margin = { ...spec.margin, top: Math.max(spec.margin.top, 10), right: below ? spec.margin.right : endWidth }
  const front = frontSeries(
    series.map((s) => s.row),
    columns[last]?.key ?? '',
    scale,
    hovered,
  )
  const styleOf = (s: Series) => (s.row.subjectId === front ? FRONT : CONTEXT)
  const byId = new Map(series.map((s) => [s.row.subjectId, s]))
  const painted = drawOrder(
    series.map((s) => s.row.subjectId),
    front,
  ).map((id) => byId.get(id)!)
  const hoverSeries = series.map((s) => ({ name: s.row.subjectName, color: styleOf(s).color, points: s.points }))
  const data = columns.map((col, i) => {
    const entry: Record<string, string | number | null> = { i, key: col.key }
    for (const s of series) entry[`plot_${s.row.subjectId}`] = s.points[i]!.kind === 'value' ? s.points[i]!.value : null
    return entry
  })
  return (
    <div ref={measure}>
      <div
        data-testid="metric-chart"
        data-size={size}
        data-series={series.length}
        data-domain-max={domain[1]}
        aria-hidden="true"
        className={spec.className}
        style={spec.style}
      >
        <ResponsiveContainer width="100%" height={spec.height} initialDimension={spec.initial}>
          <ComposedChart data={data} accessibilityLayer={false} margin={margin}>
            {focus && <CartesianGrid vertical={false} stroke="var(--color-ink)" strokeOpacity={0.05} />}
            <XAxis
              dataKey="key"
              tickFormatter={(key: string) => labels.get(key) ?? ''}
              scale="band"
              axisLine={false}
              tickLine={false}
              interval={phone ? 0 : undefined}
              tick={(p: TickProps) => <PeriodTick {...p} labels={labels} last={last} fontSize={spec.tick} every={phone ? 2 : 1} />}
              height={spec.xAxisHeight}
            />
            {axis ? (
              <YAxis
                orientation="left"
                domain={axis.domain}
                ticks={axis.ticks}
                interval={0}
                axisLine={false}
                tickLine={false}
                tick={(p: TickProps) => <ValueTick {...p} textAnchor="end" format={axis.format} fontSize={spec.tick} avoid={null} />}
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
                />
              )
            })}
            {markerLines(markers, columns, { text: focus })}
            {hoverTooltip(columns, hoverSeries, scale, animated, margin.top, markerNotes(markers))}
            {painted.map((s) => {
              const dataKey = `plot_${s.row.subjectId}`
              const style = styleOf(s)
              return (
                <Line
                  key={s.row.subjectId}
                  className={`series-${s.row.subjectId}`}
                  type="linear"
                  dataKey={dataKey}
                  stroke={style.color}
                  strokeOpacity={style.opacity}
                  strokeWidth={style.width}
                  dot={(p: DotProps) => (
                    <CurrentDot {...p} key={`dot-${s.row.subjectId}-${p.index}`} dataKey={dataKey} last={last} r={style.dot} color={style === FRONT ? FRONT.color : CONTEXT_DOT} />
                  )}
                  activeDot={(p: DotProps) => <ActiveDot cx={p.cx} cy={p.cy} r={spec.activeDot} color={style.color} />}
                  isAnimationActive={animated}
                  {...ANIMATION}
                  connectNulls={false}
                />
              )
            })}
            {!below && <EndLabels series={series} labelWidth={labelWidth} statusLabel={statusLabel} scale={scale} front={front} onHover={setHovered} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {below && <SeriesKey series={shown} scale={scale} front={front} />}
      <PointControls tip={tip} scale={scale}>
        {series.map((s) => (
          <Fragment key={s.row.subjectId}>
            <p className="mt-2 text-xs font-medium text-ink/80">{s.row.subjectName}</p>
            <PointButtons points={s.points} onSelect={setTip} prefix={`${s.row.subjectName} `} />
          </Fragment>
        ))}
      </PointControls>
    </div>
  )
}

function SmallMultiples({ series, columns, scale, animated, statusLabel, markers = [] }: MultiSeriesProps & { series: Series[] }) {
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const spec = sizeSpec('tile', PANEL_HEIGHT)
  const last = columns.length - 1
  const columnKey = columns[last]?.key ?? ''
  const format = series[0]?.row.format ?? 'number0'
  const all = series.flatMap((s) => s.points)
  const values = all.map((p) => p.value).filter((v): v is number => v !== null)
  const padded = capPercent(format, yDomain(all, null), values)
  const fitted = valueAxis(format, padded, [], percentMax(format, values))
  // Three ticks are plenty in a 110px panel.
  const ticks = fitted.ticks.length > 3 ? fitted.ticks.filter((_, i) => i % 2 === 0) : fitted.ticks
  const axis = { ...fitted, ticks, width: Math.max(36, fitted.width - 8) }
  const ordered = worstFirst(series, columnKey, scale)
  // Room above and below for the outer ticks' text.
  const margin = { ...spec.margin, top: 8, right: 4, bottom: 8 }
  const inset = { left: margin.left, right: margin.right + axis.width }
  const columnsCount = series.length <= 4 ? 2 : 3
  return (
    <div>
      <div
        data-testid="small-multiples"
        className="grid gap-x-4 gap-y-4"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(max(min(100%, 280px), calc((100% - ${(columnsCount - 1) * 16}px) / ${columnsCount})), 1fr))` }}
      >
        {ordered.map((s) => {
          const end = lastValued(s.points)
          const current = s.points[last]
          const since = sinceText(pointCells(s.points), last, columns, statusLabel)
          const rects = statusIntervals(bandsOf(s.row, columns), axis.domain)
          const data = columns.map((col, i) => ({ i, key: col.key, plot: s.points[i]!.kind === 'value' ? s.points[i]!.value : null }))
          return (
            <div key={s.row.subjectId} data-testid="series-panel" className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span data-role="panel-name" className="text-sm font-semibold">
                  {s.row.subjectName}
                </span>
                <span className="text-sm font-semibold tabular-nums">{current?.kind === 'value' ? current.display : end ? end.point.display : '—'}</span>
                {current?.kind === 'value' && current.status && (
                  <span role="img" aria-label={statusLabel(current.status)} className="inline-flex self-center">
                    <StatusChip status={current.status} scale={scale} />
                  </span>
                )}
                {since && <span className="text-[11px] leading-4 text-ink/70">{since}</span>}
              </p>
              <div data-testid="metric-chart" data-size="panel" aria-hidden="true" className="mt-1 h-[110px]">
                <ResponsiveContainer width="100%" height={PANEL_HEIGHT} initialDimension={{ width: 300, height: PANEL_HEIGHT }}>
                  <ComposedChart data={data} accessibilityLayer={false} margin={margin}>
                    <XAxis dataKey="key" scale="band" hide />
                    <YAxis
                      orientation="right"
                      domain={axis.domain}
                      ticks={axis.ticks}
                      interval={0}
                      axisLine={false}
                      tickLine={false}
                      tick={(p: TickProps) => <ValueTick {...p} format={axis.format} fontSize={11} avoid={null} />}
                      width={axis.width}
                    />
                    {rects.map((r, i) => {
                      const theme = chartTheme(scale, r.status)
                      return (
                        <ReferenceArea
                          key={`band-${i}`}
                          y1={r.y0}
                          y2={r.y1}
                          shape={(props: BandShapeProps) => <BandRect {...props} color={theme.color} opacity={0.07} />}
                        />
                      )
                    })}
                    {markerLines(markers, columns)}
                    {hoverTooltip(columns, [{ name: s.row.subjectName, color: FRONT.color, points: s.points }], scale, animated, margin.top, markerNotes(markers))}
                    <Line
                      type="linear"
                      dataKey="plot"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      dot={(p: DotProps) => <CurrentDot {...p} key={`dot-${p.index}`} dataKey="plot" last={last} r={3} color="var(--color-accent)" />}
                      activeDot={(p: DotProps) => <ActiveDot cx={p.cx} cy={p.cy} r={3.5} color="var(--color-accent)" />}
                      isAnimationActive={animated}
                      {...ANIMATION}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <StatusRibbon points={s.points} scale={scale} size="tile" inset={inset} />
              <PanelMonths columns={columns} inset={inset} />
            </div>
          )
        })}
      </div>
      <p data-testid="multiples-caption" className="mt-2 text-[11px] leading-4 text-ink/70">
        {[`Shared y-axis ${rangeText(axis.format(axis.domain[0]), axis.format(axis.domain[1]))}`, 'worst first', markerCaption(markers, columns)]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <PointControls tip={tip} scale={scale}>
        {ordered.map((s) => (
          <Fragment key={s.row.subjectId}>
            <p className="mt-2 text-xs font-medium text-ink/80">{s.row.subjectName}</p>
            <PointButtons points={s.points} onSelect={setTip} prefix={`${s.row.subjectName} `} />
          </Fragment>
        ))}
      </PointControls>
    </div>
  )
}

/** Under a panel's ribbon, its months (§8): `Nov` from 360px, `N` below; the selected (last) month in the accent. */
function PanelMonths({ columns, inset }: { columns: Column[]; inset: { left: number; right: number } }) {
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const labels = panelMonthLabels(columns, width)
  const last = columns.length - 1
  return (
    <div ref={measure} aria-hidden="true" className="mt-0.5 flex gap-px text-[11px] leading-4" style={{ marginLeft: inset.left, marginRight: inset.right }}>
      {labels.map((label, i) => (
        <span
          key={columns[i]!.key}
          data-role="panel-month"
          className={`min-w-0 flex-1 overflow-hidden text-center whitespace-nowrap ${i === last ? 'font-semibold text-accent-deep' : 'text-ink/70'}`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}
