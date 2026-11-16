import { useMemo } from 'react'
import { Link, type To } from 'react-router'
import type { components } from '../../../api/schema'
import { usePrefersReducedMotion } from '../../../ui/Sparkline'
import type { Column } from '../columns'
import { cellKey } from '../viewHelpers'
import { BarsChart } from './BarsChart'
import { ChangeLabel, StatusMarker, type ChartSize } from './chartParts'
import { chartTheme } from './chartTheme'
import { LetteredChips } from './LetteredChips'
import { buildPoints, headerChange } from './points'
import { RatioChart } from './RatioChart'
import { isSparse } from './sparse'
import { UptimeRows } from './UptimeRows'

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
  childRows?: ViewRow[]
  columns: Column[]
  currentColumnKey: string
  currentDisplay: string
  currentStatus: string
  statusLabel: (key: string) => string | undefined
  scale: components['schemas']['StatusLevel'][]
  tableTo: To
  scopeNote?: string
  ytdDisplay?: string | null
  size?: ChartSize
  /** Names the prior period in the change text. */
  fiscalYearStartMonth?: number
}

/** Renders the chart for one metric row and encodings required by the UX spec. */
export function MetricChart({
  row,
  chartRows,
  childRows = [],
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
}: MetricChartProps) {
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const lines = chartRows ?? [row]
  const points = useMemo(() => buildPoints(row, columns, fiscalYearStartMonth), [row, columns, fiscalYearStartMonth])
  const kind = isSparse(row.chartKind, points.map((p) => p.kind)) ? 'sparse' : row.chartKind
  const currentCell = row.cells.find((c) => cellKey(c) === currentColumnKey)
  const target = currentCell?.target ?? null
  const theme = chartTheme(scale, currentStatus)
  const change = headerChange(row, currentCell, fiscalYearStartMonth)
  const summary = `${row.metricName}: ${currentDisplay || 'no data'}, status ${currentStatus || 'none'}`

  return (
    <div>
      <p className="sr-only">{summary}</p>
      {scopeNote && <p className="text-xs text-ink/80">{scopeNote}</p>}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-testid="header-value" className={`${size === 'focus' ? 'text-[28px] leading-9' : 'text-xl'} font-semibold tabular-nums`}>
          {currentDisplay || '—'}
        </span>
        {currentStatus && <StatusMarker theme={theme} title={statusLabel(currentStatus)} />}
        {change && <ChangeLabel change={change} size={size} />}
        {ytdDisplay && <span className="text-sm text-ink/80">{ytdDisplay}</span>}
      </div>
      {kind === 'uptime' ? (
        <UptimeRows childRows={childRows} columns={columns} currentColumnKey={currentColumnKey} scale={scale} />
      ) : kind === 'sparse' ? (
        <LetteredChips points={points} scale={scale} />
      ) : kind === 'discrete' || kind === 'money_plan' ? (
        <BarsChart
          points={points}
          columns={columns}
          format={row.format}
          scale={scale}
          animated={animated}
          size={size}
          plan={kind === 'money_plan'}
        />
      ) : (
        <RatioChart
          row={row}
          chartRows={lines}
          points={points}
          columns={columns}
          scale={scale}
          target={target}
          animated={animated}
          size={size}
          fyStart={fiscalYearStartMonth}
        />
      )}
      {/* In focus, the dialog's own table link sits below its breakdown. */}
      {size !== 'focus' && (
        <p className="mt-2">
          <Link to={tableTo} className="text-sm font-medium text-accent-deep hover:underline">
            View as table
          </Link>
        </p>
      )}
    </div>
  )
}
