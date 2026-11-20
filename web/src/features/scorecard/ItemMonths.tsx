import { ChevronDown, ChevronUp } from 'lucide-react'
import { useId, useState } from 'react'
import type { components } from '../../api/schema'
import { formatPeriod, parsePeriod, prev } from '../../lib/period'
import { StatusChip, type StatusLevel } from '../../ui/status'
import { MOVE_CLASS, valueMove, type Move } from './charts/chartTheme'
import type { Column } from './columns'
import { metricDecimals } from './format'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

export interface ItemMonthsProps {
  /** The item's row; its cells hold the shown periods and, when the view has it, the one before. */
  row: ViewRow
  /** The shown periods, oldest first. */
  columns: Column[]
  scale: StatusLevel[]
  format: string
  /** The value column's header: the metric name's unit word (`Uptime`). */
  valueLabel: string
  /** Open state, for a caller that keeps it across items; the disclosure keeps its own when absent. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const valued = (c: Cell | undefined): c is Cell & { value: number } => !!c && c.naReason === '' && c.value != null

/**
 * `▼ −0.36` and the unit ` pts`, or `0.00` and ` pts`: the change from the prior period, in the format's
 * decimals; null when either side has no value.
 */
function monthChange(
  value: number | null,
  prior: number | null,
  format: string,
  direction: string,
): { amount: string; unit: string; move: Move } | null {
  if (value === null || prior === null) return null
  const decimals = metricDecimals(format)
  const delta = Number((value - prior).toFixed(decimals))
  const move = valueMove(delta, direction)
  const n = Math.abs(delta).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : ''
  const arrow = move.arrow ? `${move.arrow} ` : ''
  if (format === 'money_k') return { amount: `${arrow}${sign}$${n}k`, unit: '', move }
  const unit = format.startsWith('percent') ? ' pts' : format === 'days0' ? (Math.abs(delta) === 1 ? ' day' : ' days') : ''
  return { amount: `${arrow}${sign}${n}`, unit, move }
}

/**
 * The drill-in's exact figures (§4): a `Monthly values` disclosure, shut by
 * default, over a table of every shown period, newest first: the period,
 * the value, the status in words and the change from the period before.
 */
export function ItemMonths({ row, columns, scale, format, valueLabel, open: openProp, onOpenChange }: ItemMonthsProps) {
  const tableId = useId()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const toggle = () => {
    if (openProp === undefined) setOwnOpen(!open)
    onOpenChange?.(!open)
  }
  const byPeriod = new Map(row.cells.filter((c) => !c.ytd).map((c) => [c.period, c]))
  const valueOf = (period: string | undefined) => {
    const c = period ? byPeriod.get(period) : undefined
    return valued(c) ? c.value : null
  }
  const priorOf = (period: string) => {
    const p = parsePeriod(period)
    return p ? formatPeriod(prev(p)) : undefined
  }
  const label = (key: string) => scale.find((s) => s.key === key)?.label ?? key

  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? tableId : undefined}
        onClick={toggle}
        className="inline-flex h-8 items-center gap-1 rounded-md border border-ink/20 bg-white px-3 text-sm font-medium text-ink hover:bg-ink/5"
      >
        Monthly values
        {open ? <ChevronUp aria-hidden="true" className="size-4 text-ink/70" /> : <ChevronDown aria-hidden="true" className="size-4 text-ink/70" />}
      </button>
      {open && (
        <div className="mt-2 max-w-[640px] rounded-lg border border-ink/15 bg-white px-3 py-1">
          <table id={tableId} aria-label="Monthly values" className="w-full max-w-[640px] text-sm">
            <thead>
              <tr className="h-8 border-b border-ink/10 text-left text-xs text-ink/70">
                <th scope="col" className="font-medium">
                  Month
                </th>
                <th scope="col" className="font-medium">
                  {valueLabel}
                </th>
                <th scope="col" className="font-medium">
                  Status
                </th>
                <th scope="col" className="font-medium">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {[...columns].reverse().map((col) => {
                const cell = byPeriod.get(col.period)
                const value = valueOf(col.period)
                const change = monthChange(value, valueOf(priorOf(col.period)), format, row.direction)
                return (
                  <tr key={col.key} className="h-8 border-b border-ink/10 last:border-b-0">
                    <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap sm:pr-3">
                      {col.fullLabel}
                    </th>
                    <td className={`pr-2 tabular-nums sm:pr-3 ${value === null ? 'text-ink/70' : 'font-semibold'}`}>{value === null ? '—' : cell!.display}</td>
                    <td className="pr-2 sm:pr-3">
                      {cell?.naReason ? (
                        <span className="text-ink/70">n/a</span>
                      ) : cell?.status ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span data-role="status-chip" aria-hidden="true" className="inline-flex">
                            <StatusChip status={cell.status} scale={scale} />
                          </span>
                          {label(cell.status)}
                        </span>
                      ) : (
                        <span className="text-ink/70">No data</span>
                      )}
                    </td>
                    <td className="tabular-nums whitespace-nowrap">
                      {change ? (
                        <span data-tone={change.move.tone} className={MOVE_CLASS[change.move.tone]}>
                          {change.amount}
                          {/* Phones keep the four columns inside the card by dropping the unit the header implies. */}
                          {change.unit && <span className="max-sm:sr-only">{change.unit}</span>}
                        </span>
                      ) : (
                        <span className="text-ink/70">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
