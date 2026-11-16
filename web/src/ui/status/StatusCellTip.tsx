import { chartTheme } from '../../features/scorecard/charts/chartTheme'
import type { Column } from '../../features/scorecard/columns'
import type { BoardCell } from '../../features/scorecard/logic/statusBoard'
import { columnUnit } from '../../features/scorecard/logic/statusText'
import type { StatusLevel } from './StatusChip'

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

export interface StatusCellTipProps {
  column: Column
  cell: BoardCell
  /** Periods in a row with this status, ending here. */
  streak: number
  scale: StatusLevel[]
}

/** The hover label for one cell, in the chart hover label's language: bold value, period, status, change. */
export function StatusCellTip({ column, cell, streak, scale }: StatusCellTipProps) {
  const theme = cell.kind === 'status' ? chartTheme(scale, cell.status) : null
  const lead =
    cell.kind === 'na'
      ? 'n/a'
      : cell.kind === 'missing'
        ? 'No data'
        : cell.display || capitalize(cell.caption) || theme?.label || cell.status
  return (
    <div data-testid="board-tip" className="w-max max-w-64 rounded-md bg-ink px-2 py-1.5 text-[11px] leading-4 text-white shadow-md">
      <p className="text-sm font-semibold tabular-nums">{lead}</p>
      <p className="text-white/75">{column.fullLabel}</p>
      {cell.kind === 'na' && <p>{cell.naReason || 'Not applicable'}</p>}
      {cell.kind === 'unrated' && <p>Not rated</p>}
      {theme && (
        <p data-testid="tip-status">
          <span aria-hidden="true">{theme.shape}</span> {theme.label || theme.letter}
          {streak >= 2 && ` · ${streak} ${columnUnit(column, streak)}`}
        </p>
      )}
      {theme && cell.display && cell.caption && <p className="text-white/75">{capitalize(cell.caption)}</p>}
      {cell.change && <p className="text-white/75">{cell.change}</p>}
    </div>
  )
}
