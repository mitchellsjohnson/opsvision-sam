import { useMemo } from 'react'
import { Link, type To } from 'react-router'
import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import { usePrefersReducedMotion } from '../../../ui/Sparkline'
import { FREQUENCY_GRAIN, type Column } from '../columns'
import { cellKey } from '../viewHelpers'
import { ChangeLabel, StatusMarker, type ChartSize } from './chartParts'
import { chartTheme } from './chartTheme'
import { moneyPlanSummary } from './moneyPlan'
import { MoneyPlanChart } from './MoneyPlanChart'
import { MultiSeriesChart } from './MultiSeries'
import { buildPoints, headerChange } from './points'
import { RatioChart } from './RatioChart'
import { isSparse } from './sparse'
import { SparseRibbon } from './SparseRibbon'
import type { VersionMarker } from './versionMarkers'

export { buildPoints, type ChartPoint } from './points'
export {
  ChartHoverCard,
  FOCUS_CHART_HEIGHT,
  type ChartHoverCardProps,
  type ChartSeries,
  type ChartSize,
} from './chartParts'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']

export interface MetricChartProps {
  row: ViewRow
  /** When the scope cell is missing, one trend line per child row. */
  chartRows?: ViewRow[]
  columns: Column[]
  currentColumnKey: string
  currentDisplay: string
  currentStatus: string
  statusLabel: (key: string) => string | undefined
  scale: components['schemas']['StatusLevel'][]
  /** The tile's table link; none when absent. */
  tableTo?: To
  scopeNote?: string
  ytdDisplay?: string | null
  size?: ChartSize
  /** Names the prior period in the change text. */
  fiscalYearStartMonth?: number
  /** Inside a tile frame: the frame shows the value row, so only the chart region renders. */
  framed?: boolean
  /** The chart's own value row; off where the surface draws one (the dialog). */
  header?: boolean
  /** Methodology changes within the columns (`useVersionMarkers`); none when restated. */
  markers?: VersionMarker[]
}

/** Renders the chart for one metric row and encodings required by the UX spec. */
export function MetricChart({
  row,
  chartRows,
  columns,
  currentColumnKey,
  currentDisplay,
  currentStatus,
  statusLabel,
  scale,
  tableTo,
  scopeNote,
  ytdDisplay,
  size = 'tile',
  fiscalYearStartMonth = 1,
  framed = false,
  header = true,
  markers = [],
}: MetricChartProps) {
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const lines = chartRows ?? [row]
  // One line: the scope's, or the one child reported in its place.
  const lineRow = lines.length === 1 ? lines[0]! : row
  const points = useMemo(() => buildPoints(row, columns, fiscalYearStartMonth), [row, columns, fiscalYearStartMonth])
  const linePoints = useMemo(
    () => (lineRow === row ? points : buildPoints(lineRow, columns, fiscalYearStartMonth)),
    [lineRow, row, points, columns, fiscalYearStartMonth],
  )
  const kind = isSparse(row.chartKind, points.map((p) => p.kind)) ? 'sparse' : row.chartKind
  // A quarterly, biannual or annual metric charted at its own grain (§5.5); the columns already are that grain.
  const shownGrain = parsePeriod(columns[0]?.period)?.grain ?? 'month'
  const coarse = shownGrain !== 'month' && FREQUENCY_GRAIN[row.frequency] === shownGrain
  const currentCell = row.cells.find((c) => cellKey(c) === currentColumnKey)
  const lineCell = lineRow.cells.find((c) => cellKey(c) === currentColumnKey)
  const target = (currentCell ?? lineCell)?.target ?? null
  const theme = chartTheme(scale, currentStatus)
  const change = headerChange(row, currentCell, fiscalYearStartMonth)
  const nameOf = (key: string) => statusLabel(key) || chartTheme(scale, key).label || key
  const summary = [
    kind === 'money_plan'
      ? moneyPlanSummary(row.metricName, points, columns, nameOf)
      : `${row.metricName}: ${currentDisplay || 'no data'}, status ${currentStatus || 'none'}`,
    ...markers.map((m) => m.title),
  ].join('. ')

  return (
    <div>
      <p className="sr-only">{summary}</p>
      {!framed && (
        <>
          {scopeNote && <p className="text-xs text-ink/80">{scopeNote}</p>}
          {header && (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span data-testid="header-value" className={`${size === 'focus' ? 'text-[28px] leading-9' : 'text-xl'} font-semibold tabular-nums`}>
                {currentDisplay || '—'}
              </span>
              {currentStatus && <StatusMarker theme={theme} title={statusLabel(currentStatus)} />}
              {change && <ChangeLabel change={change} size={size} />}
              {ytdDisplay && <span className="text-sm text-ink/80">{ytdDisplay}</span>}
            </div>
          )}
        </>
      )}
      {kind === 'sparse' ? (
        <SparseRibbon points={points} columns={columns} scale={scale} size={size} statusLabel={statusLabel} row={row} fyStart={fiscalYearStartMonth} />
      ) : kind === 'money_plan' ? (
        <MoneyPlanChart row={row} points={points} columns={columns} scale={scale} animated={animated} size={size} />
      ) : lines.length > 1 ? (
        <MultiSeriesChart
          rows={lines}
          columns={columns}
          scale={scale}
          animated={animated}
          size={size}
          fyStart={fiscalYearStartMonth}
          statusLabel={nameOf}
          markers={markers}
        />
      ) : (
        <RatioChart
          row={lineRow}
          points={linePoints}
          columns={columns}
          scale={scale}
          target={target}
          animated={animated}
          size={size}
          fyStart={fiscalYearStartMonth}
          framed={framed}
          valuePoints={kind === 'discrete' || coarse}
          markers={markers}
        />
      )}
      {/* In focus, the dialog's own table link sits below its breakdown. */}
      {size !== 'focus' && !framed && tableTo && (
        <p className="mt-2">
          <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
            View as table
          </Link>
        </p>
      )}
    </div>
  )
}
