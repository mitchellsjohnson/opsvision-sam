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

interface SparsePoint {
  kind: PointKind
  naReason: string
}

/**
 * The sparse context line: `5 months reported in the last 12; the rest are n/a`
 * when every other period is n/a for one reason, else the n/a count
 * (`7 months n/a`) and any periods with no data. `unit` names `n` periods.
 */
export function sparseContext(points: SparsePoint[], unit: (n: number) => string): string {
  const valued = points.filter((p) => p.kind === 'value').length
  const na = points.filter((p) => p.kind === 'na')
  const missing = points.filter((p) => p.kind === 'missing').length
  const head = `${valued} ${unit(valued)} reported in the last ${points.length}`
  const agree = new Set(na.map((p) => p.naReason)).size <= 1
  if (missing === 0 && agree && na.length > 0) return `${head}; the rest are n/a`
  const parts = [na.length > 0 && `${na.length} ${unit(na.length)} n/a`, missing > 0 && `${missing} no data`].filter(Boolean)
  return parts.length > 0 ? `${head}; ${parts.join(' · ')}` : head
}

/** What n/a means here, from the most common reason: `n/a: No major incident this month`; '' with none. */
export function sparseKey(points: SparsePoint[]): string {
  const counts = new Map<string, number>()
  for (const p of points) if (p.kind === 'na' && p.naReason) counts.set(p.naReason, (counts.get(p.naReason) ?? 0) + 1)
  let best = ''
  let most = 0
  for (const [reason, n] of counts) {
    if (n > most) {
      best = reason
      most = n
    }
  }
  return best ? `n/a: ${best}` : ''
}
