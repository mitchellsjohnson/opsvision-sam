import { Link, type To } from 'react-router'
import type { components } from '../../api/schema'
import { parsePeriod, type Grain } from '../../lib/period'
import { Sparkline, type SparklinePoint } from '../../ui/Sparkline'
import { StatusBadge } from '../../ui/StatusBadge'
import type { Column } from './columns'
import { changeText, formatMetricValue, overrideSentence, withDirection } from './format'
import { cellKey, plainNumber, ratioParts } from './viewHelpers'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type Metric = Schemas['MethodologyVersion']['content']['metrics'][number]

const UNITS: Record<Grain, [string, string]> = {
  month: ['month', 'months'],
  quarter: ['quarter', 'quarters'],
  half: ['half', 'halves'],
  year: ['year', 'years'],
}

/** The cell of the selected (last) column, if the row has one. */
export function currentCell(row: ViewRow, columns: Column[]): Cell | undefined {
  const last = columns[columns.length - 1]
  return last ? row.cells.find((c) => cellKey(c) === last.key) : undefined
}

/** How a cell reads: a status, not applicable, or no data. */
export function cellOutcome(cell: Cell | undefined): 'status' | 'na' | 'missing' {
  if (cell && cell.naReason !== '') return 'na'
  if (cell && cell.status !== '') return 'status'
  return 'missing'
}

/** `Trend over 12 months: from 76% to 84%; goal 90%`; the goal clause is left out without a target. */
export function trendSummary(
  row: ViewRow,
  columns: Column[],
  cells: (Cell | undefined)[],
  target: number | null,
): string {
  const grain = parsePeriod(columns[columns.length - 1]?.period)?.grain ?? 'month'
  const [one, many] = UNITS[grain]
  const shown = cells.filter((c): c is Cell => c !== undefined && c.naReason === '' && c.display !== '')
  const first = shown[0]
  const last = shown[shown.length - 1]
  const span = `Trend over ${columns.length} ${columns.length === 1 ? one : many}`
  const body = first && last ? `: from ${first.display} to ${last.display}` : ': no data'
  const goal = target === null ? '' : `; goal ${formatMetricValue(row.format, target)}`
  return `${span}${body}${goal}`
}

export interface MetricTileProps {
  row: ViewRow
  columns: Column[]
  /** The metric's definition under the version the current cell used, when known. */
  metric: Metric | undefined
  fiscalYearStartMonth: number
  statusLabel: (key: string) => string | undefined
  /** The Table tab, at this metric. */
  to: To
}

/** One metric: current value and status, components, change, and a trend line with its goal. */
export function MetricTile({ row, columns, metric, fiscalYearStartMonth, statusLabel, to }: MetricTileProps) {
  const byKey = new Map(row.cells.map((c) => [cellKey(c), c]))
  const cells = columns.map((c) => byKey.get(c.key))
  const current = cells[cells.length - 1]
  const outcome = cellOutcome(current)

  // The goal in force now; failing that, the latest one the trend passed through.
  const target = [...cells].reverse().find((c) => c?.target !== null && c?.target !== undefined)?.target ?? null
  const points: SparklinePoint[] = columns.map((c, i) => {
    const cell = cells[i]
    return { label: c.label, value: cell && cell.naReason === '' ? cell.value : null }
  })

  const parts = current ? ratioParts(metric?.formula, current.components) : null
  const components = parts && current
    ? `${plainNumber(current.components[parts[0]] as number)} / ${plainNumber(current.components[parts[1]] as number)}`
    : null
  const change =
    current && outcome !== 'na'
      ? changeText({
          period: current.period,
          ytd: current.ytd,
          format: row.format,
          change: current.change,
          changeKind: current.changeKind,
          compare: metric?.rule.compare,
          fyStart: fiscalYearStartMonth,
        })
      : null
  const override = current?.override ? overrideSentence(current.override) : null

  return (
    <Link
      to={to}
      id={`tile-${row.metricKey}`}
      className="block h-full rounded-lg border border-ink/20 bg-white p-4 hover:border-accent hover:shadow-sm"
    >
      <h3 className="text-base font-semibold">{row.metricName}</h3>
      <p className="text-xs text-ink/80">{row.subjectName}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {outcome === 'na' ? (
          <span className="text-sm text-ink/80">{current?.naReason}</span>
        ) : outcome === 'missing' ? (
          <span role="img" aria-label="No data" className="text-2xl font-semibold text-ink/80">
            —
          </span>
        ) : (
          <>
            <span className="text-2xl font-semibold">{current?.display || '—'}</span>
            <StatusBadge status={current?.status} label={statusLabel(current?.status ?? '')} />
          </>
        )}
        {override && (
          <>
            <span title={override} className="font-semibold text-accent-deep">
              †
            </span>
            <span className="sr-only">{override}</span>
          </>
        )}
      </div>
      {components && <p className="mt-1 text-sm text-ink/80">{components}</p>}
      {change && <p className="mt-1 text-sm">{withDirection(change, row.direction)}</p>}
      <div className="mt-3">
        <Sparkline points={points} target={target} summary={trendSummary(row, columns, cells, target)} />
      </div>
    </Link>
  )
}
