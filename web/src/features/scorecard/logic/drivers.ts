import type { components } from '../../../api/schema'
import { cellKey } from '../viewHelpers'
import { cellReported, type StatusScaleEntry } from './statusAtScope'

type Cell = components['schemas']['Cell']
type ViewRow = components['schemas']['ViewRow']
type Direction = components['schemas']['Direction']

export interface RankedChild {
  row: ViewRow
  cell: Cell
  /** The status's rank in the scale; -1 when the cell has no status. */
  rank: number
}

export interface WorstChildren {
  ranked: RankedChild[]
  worst: { row: ViewRow; cell: Cell } | null
  /** How many children share the worst status; 0 when none has a status. */
  worstCount: number
  /** Children that reported in the column. */
  total: number
}

/** Missing values sort last; otherwise the worse value by direction comes first. */
function worseValueFirst(a: number | null, b: number | null, direction: Direction): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return direction === 'lower_better' ? b - a : a - b
}

/**
 * The children that reported in a column, worst first: highest status rank,
 * then the worse value by direction, then name.
 */
export function worstChildren(
  children: ViewRow[],
  columnKey: string,
  scale: StatusScaleEntry[],
  direction: Direction,
): WorstChildren {
  const rankOf = new Map(scale.map((s) => [s.key, s.rank]))
  const ranked = children
    .flatMap((row): RankedChild[] => {
      const cell = row.cells.find((c) => cellKey(c) === columnKey)
      return cell && cellReported(cell) ? [{ row, cell, rank: rankOf.get(cell.status) ?? -1 }] : []
    })
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        worseValueFirst(a.cell.value, b.cell.value, direction) ||
        a.row.subjectName.localeCompare(b.row.subjectName),
    )
  const first = ranked[0]
  return {
    ranked,
    worst: first ? { row: first.row, cell: first.cell } : null,
    worstCount: first && first.rank >= 0 ? ranked.filter((r) => r.rank === first.rank).length : 0,
    total: ranked.length,
  }
}
