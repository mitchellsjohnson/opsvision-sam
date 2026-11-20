import clsx from 'clsx'
import type { components } from '../../../api/schema'
import { monthLabel, monthsOf, parsePeriod, periodLabel, type Period } from '../../../lib/period'
import { StatusChip } from '../../../ui/status'
import { useElementWidth } from '../../../ui/useElementWidth'
import type { Column } from '../columns'
import { cellKey } from '../viewHelpers'
import { dueByLabel, ghostSlot, nextPeriod } from './chartParts'
import { chartTheme } from './chartTheme'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']

/** Under this width the cards stack. */
const ROW_FROM = 360

/** `Jan–Jun`: the months a period covers, without the year. */
function monthsText(p: Period, fy: number): string {
  const months = monthsOf(p)
  const name = (m: Period) => monthLabel(m, fy).split(' ')[0] ?? ''
  return `${name(months[0]!)}–${name(months[months.length - 1]!)}`
}

/** `H1 FY26 · Jan–Jun`, `FY25 · Jan–Dec`. */
function cardLabel(p: Period, fy: number): string {
  return `${periodLabel(p, fy).replace(/FY\d{2}(\d{2})$/, 'FY$1')} · ${monthsText(p, fy)}`
}

/**
 * A twice-yearly or yearly metric on a tile (§5.2): its last two periods as
 * cards (period and months, value and chip), then the next period as a dashed
 * card that says when it is due, or that it is overdue. Without the selected
 * period there is no due card. Full screen keeps the line.
 */
export function PeriodCards({
  row,
  columns,
  selectedPeriod,
  scale,
  format,
  fy,
}: {
  row: ViewRow
  columns: Column[]
  selectedPeriod?: string
  scale: StatusLevel[]
  /** The metric's format, for a value without a display. */
  format: string
  fy: number
}) {
  const [measure, width] = useElementWidth<HTMLUListElement>()
  const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
  const ghost = ghostSlot(row, columns, selectedPeriod, fy)
  // A due or overdue last column is the due card; the cards before it are the reported ones.
  const reported = ghost && ghost.index < columns.length ? columns.slice(0, ghost.index) : columns
  const shown = reported.slice(-2)
  const last = parsePeriod(columns[columns.length - 1]?.period)
  const dueP = ghost && last ? (ghost.index < columns.length ? parsePeriod(columns[ghost.index]!.period) : nextPeriod(last)) : null
  const due =
    ghost && dueP
      ? { label: cardLabel(dueP, fy), text: `${ghost.overdue ? 'Overdue since' : 'Due by'} ${dueByLabel(dueP, fy)}`, overdue: ghost.overdue }
      : null
  const stacked = width > 0 && width < ROW_FROM
  const count = shown.length + (due ? 1 : 0)
  return (
    <ul ref={measure} data-testid="period-cards" className={clsx('grid gap-2', stacked || count < 2 ? 'grid-cols-1' : count === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
      {shown.map((col, i) => {
        const cell = cells.get(col.key)
        const latest = i === shown.length - 1
        const theme = cell?.status ? chartTheme(scale, cell.status) : null
        const value = cell?.display || (cell?.value != null ? String(cell.value) : '')
        return (
          <li key={col.key} data-testid="period-card" className="min-w-0 rounded-lg bg-ink/[0.035] px-3 py-2.5">
            <p className="truncate text-[11px] leading-4 text-ink/70">{parsePeriod(col.period) ? cardLabel(parsePeriod(col.period)!, fy) : col.fullLabel}</p>
            {value ? (
              <p className="mt-0.5 flex items-center gap-1.5">
                <span className={clsx('text-xl tabular-nums', latest ? 'font-semibold' : 'font-medium')} data-format={format}>
                  {value}
                </span>
                {cell?.status && (
                  <>
                    <span data-role="status-chip" aria-hidden="true" className="inline-flex">
                      <StatusChip status={cell.status} scale={scale} />
                    </span>
                    <span className="sr-only">{theme?.label || cell.status}</span>
                  </>
                )}
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink/70">{cell?.naReason ? `n/a: ${cell.naReason}` : 'Not reported'}</p>
            )}
          </li>
        )
      })}
      {due && (
        <li data-testid="period-card" className="min-w-0 rounded-lg border border-dashed border-ink/20 px-3 py-2.5">
          <p className="truncate text-[11px] leading-4 text-ink/70">{due.label}</p>
          <p className={clsx('mt-1 text-xs', due.overdue ? 'font-medium text-status-r' : 'text-ink/70')}>{due.text}</p>
        </li>
      )}
    </ul>
  )
}
