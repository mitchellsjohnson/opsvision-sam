import type { components } from '../../../api/schema'
import { parsePeriod, prev } from '../../../lib/period'
import type { Column } from '../columns'
import { changeText, metricDecimals, overrideSentence } from '../format'
import { cellKey } from '../viewHelpers'
import { valueMove, type Move } from './chartTheme'
import { pointKind, type PointKind } from './sparse'

type ViewRow = components['schemas']['ViewRow']
type CellT = components['schemas']['Cell']

export interface ChartPoint {
  key: string
  label: string
  fullLabel: string
  value: number | null
  display: string
  status: string
  naReason: string
  overrideReason: string
  /** The change as a phrase, e.g. `+2.1 pts vs Sep`; null when the cell has none. */
  change: string | null
  kind: PointKind
}

function cellsByKey(row: ViewRow): Map<string, CellT> {
  return new Map(row.cells.map((c) => [cellKey(c), c]))
}

function cellChange(row: ViewRow, cell: CellT, fyStart: number): string | null {
  return changeText({
    period: cell.period,
    ytd: cell.ytd,
    format: row.format,
    change: cell.change,
    changeKind: cell.changeKind,
    compare: cell.rule?.type === 'change' ? cell.rule.compare : undefined,
    fyStart,
  })
}

/** One point per column for a row, with everything the hover label and point buttons show. */
export function buildPoints(row: ViewRow, columns: Column[], fyStart: number): ChartPoint[] {
  const byKey = cellsByKey(row)
  return columns.map((col) => {
    const cell = byKey.get(col.key)
    const kind = pointKind(cell)
    return {
      key: col.key,
      label: col.label,
      fullLabel: col.fullLabel,
      value: kind === 'value' ? (cell?.value ?? null) : null,
      display: cell?.display ?? '',
      status: cell?.status ?? '',
      naReason: cell?.naReason ?? '',
      overrideReason: cell?.override ? overrideSentence(cell.override) : '',
      change: cell ? cellChange(row, cell, fyStart) : null,
      kind,
    }
  })
}

/** The current period's change and which way it moved the value, judged by the metric's direction. */
/** `vs H2 FY25`: a half's change names the half it compares with in full, since there are so few (§5.2). */
export function halfChange(change: { text: string; move: Move } | null, counted: string): { text: string; move: Move } | null {
  const p = parsePeriod(counted)
  if (!change || p?.grain !== 'half') return change
  const before = prev(p)
  return { ...change, text: change.text.replace(/ vs H\d$/, ` vs H${before.index} FY${String(before.fy).slice(-2)}`) }
}

export function headerChange(row: ViewRow, cell: CellT | undefined, fyStart: number): { text: string; move: Move } | null {
  if (!cell || cell.change === null) return null
  const text = cellChange(row, cell, fyStart)
  if (!text) return null
  const improvement = cell.changeKind === 'improvement_pct'
  // changeText's rounding: tenths for an improvement, the format's decimals for a delta.
  const shown = improvement ? Math.round(cell.change * 10) / 10 : Number(cell.change.toFixed(metricDecimals(row.format)))
  // An improvement counts a move in the good direction as positive, whichever way the value went.
  const delta = improvement && row.direction === 'lower_better' ? -shown : shown
  return { text, move: valueMove(delta || 0, row.direction) }
}
