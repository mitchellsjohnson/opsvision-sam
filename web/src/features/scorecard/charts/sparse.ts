import type { components } from '../../../api/schema'

type Cell = components['schemas']['Cell']

export type PointKind = 'value' | 'na' | 'missing'

/** A cell as a chart point: a value (or a status alone), not applicable, or missing. */
export function pointKind(cell: Pick<Cell, 'value' | 'status' | 'naReason'> | undefined): PointKind {
  if (!cell) return 'missing'
  if (cell.naReason !== '') return 'na'
  if (cell.value == null && cell.status === '') return 'missing'
  return 'value'
}

/**
 * Whether a metric's points are too sparse for a line or bars: at least four
 * columns, with more not applicable than valued. The app then draws lettered
 * results and the exports a table. Discrete kinds already show each period.
 */
export function isSparse(chartKind: string, kinds: PointKind[]): boolean {
  if (chartKind === 'discrete') return false
  if (kinds.length < 4) return false
  let na = 0
  let valued = 0
  for (const k of kinds) {
    if (k === 'na') na++
    else if (k === 'value') valued++
  }
  return na > valued
}
