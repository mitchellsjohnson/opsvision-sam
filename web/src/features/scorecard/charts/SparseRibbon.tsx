import clsx from 'clsx'
import { useState } from 'react'
import type { components } from '../../../api/schema'
import { StatusCell, StatusChip } from '../../../ui/status'
import { useElementWidth } from '../../../ui/useElementWidth'
import type { Column } from '../columns'
import { changeText, metricDecimals } from '../format'
import { columnUnit } from '../logic/statusText'
import type { BoardCell } from '../logic/statusBoard'
import { cellKey } from '../viewHelpers'
import { pointLabel, PointButtons, PointControls, usePhone, type ChartSize } from './chartParts'
import { chartTheme, MOVE_CLASS, valueMove, type Move } from './chartTheme'
import type { ChartParts } from './MetricChart'
import { headerChange, type ChartPoint } from './points'
import { sparseContext, sparseKey } from './sparse'

type StatusLevel = components['schemas']['StatusLevel']
type ViewRow = components['schemas']['ViewRow']

function boardCell(p: ChartPoint): BoardCell {
  const kind = p.kind === 'value' ? (p.status ? 'status' : 'unrated') : p.kind
  return { key: p.key, kind, status: p.status, display: p.display, naReason: p.naReason, change: p.change, caption: '' }
}

/**
 * Each valued point's change since the last valued one before it, which the
 * n/a periods between may put several back (`-15 pts vs Mar`), with its arrow
 * and tone by the metric's direction; the cell's own change when it has one,
 * and null for the first.
 */
export function changesSinceReported(valued: ChartPoint[], row: ViewRow, fyStart: number): ({ text: string; move: Move } | null)[] {
  const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
  return valued.map((p, i) => {
    if (p.change) return headerChange(row, cells.get(p.key), fyStart)
    const prior = valued[i - 1]
    if (!prior || p.value === null || prior.value === null) return null
    const delta = p.value - prior.value
    const text = changeText({ period: '', ytd: false, format: row.format, change: delta, changeKind: 'delta', fyStart })
    if (!text) return null
    // With no period, the phrase is `vs prior period`; name the period compared with instead.
    return {
      text: text.replace(/vs prior period$/, `vs ${prior.label}`),
      move: valueMove(Number(delta.toFixed(metricDecimals(row.format))) || 0, row.direction),
    }
  })
}

/** A change for the table: a true minus sign, and on phones no unit (`▼ −20 vs Aug`). */
function tableChange(text: string, phone: boolean): string {
  const signed = text.replace(/^-/, '−')
  return phone ? signed.replace(/ pts\b/, '') : signed
}

/**
 * The line under the focus table: `n/a in 7 months (Nov, Jan, …): {reason}`
 * when every n/a month shares its reason, else the count alone (each month's
 * reason is in its cell's title).
 */
export function naLine(points: ChartPoint[], unit: (n: number) => string): string {
  const na = points.filter((p) => p.kind === 'na')
  if (na.length === 0) return ''
  const reasons = new Set(na.map((p) => p.naReason))
  const head = `n/a in ${na.length} ${unit(na.length)}`
  const [reason] = reasons
  return reasons.size === 1 && reason ? `${head} (${na.map((p) => p.label).join(', ')}): ${reason}` : head
}

/**
 * A metric with more n/a than values: one board cell per period, the value
 * above each valued one and the period below, with a context line and what
 * n/a means. Focus adds a full-width table of the valued periods, newest
 * first, with the ratio's parts when the caller passes them (§7).
 */
export function SparseRibbon({
  points,
  columns,
  scale,
  size,
  statusLabel,
  row,
  fyStart,
  parts,
}: {
  points: ChartPoint[]
  columns: Column[]
  scale: StatusLevel[]
  size: ChartSize
  statusLabel: (key: string) => string | undefined
  /** The metric's row: its format and direction, and each cell's own change, for the focus table's changes. */
  row: ViewRow
  fyStart: number
  /** The ratio's measures: a parts column (`4 of 5 on time`). */
  parts?: ChartParts
}) {
  const focus = size === 'focus'
  const phone = usePhone()
  const [tip, setTip] = useState<ChartPoint | null>(null)
  const [ribbonRef, ribbonWidth] = useElementWidth<HTMLDivElement>()
  // Under about 26px a column, every other period is labelled, counted back from the current one.
  const narrow = ribbonWidth > 0 && ribbonWidth / Math.max(points.length, 1) < 26
  const unit = (n: number) => columnUnit(columns[0], n)
  const key = sparseKey(points)
  const last = points.length - 1
  const valued = points.filter((p) => p.kind === 'value')
  const changes = changesSinceReported(valued, row, fyStart)
  const showChange = valued.length > 1 && changes.some((c) => c !== null)
  const nameOf = (status: string) => statusLabel(status) || chartTheme(scale, status).label || status
  const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
  const partsOf = (p: ChartPoint) => {
    const c = cells.get(p.key)?.components
    const num = parts ? c?.[parts.numerator] : undefined
    const den = parts ? c?.[parts.denominator] : undefined
    return num === undefined || den === undefined ? '' : `${num.toLocaleString('en-US')} of ${den.toLocaleString('en-US')}`
  }
  const partsNoun = parts ? parts.valueLabel.toLowerCase() : ''
  const table = focus && valued.length > 0
  const na = table ? naLine(points, unit) : ''
  // Newest first; each row keeps its change against the report before it.
  const rows = valued.map((p, i) => ({ p, change: changes[i] ?? null, first: i === 0 })).reverse()
  const cellClass = 'py-2 pr-4'

  return (
    <div>
      <p data-testid="chart-context" className="text-xs text-ink/70">
        {sparseContext(points, unit)}
      </p>
      <div
        ref={ribbonRef}
        data-testid="sparse-ribbon"
        aria-hidden="true"
        className="mt-2 grid gap-px"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
      >
        {/* Labels are centred and free to overflow their column: a valued period's neighbours are mostly n/a, and the card's padding takes the ends. */}
        {points.map((p, i) => (
          <div key={p.key} title={pointLabel(p, '', true)} className="flex min-w-0 flex-col items-stretch gap-0.5">
            <span
              data-role={p.kind === 'value' ? 'value-label' : undefined}
              className="flex h-4 justify-center whitespace-nowrap text-[11px] font-semibold leading-4 tabular-nums text-ink/80"
            >
              {p.kind === 'value' ? p.display : ''}
            </span>
            <StatusCell cell={boardCell(p)} name="" scale={scale} size={focus ? 'md' : 'sm'} decorative />
            <span
              data-role="month-label"
              className={clsx(
                'flex justify-center whitespace-nowrap text-[11px] leading-4',
                i === last ? 'font-semibold text-accent-deep' : 'text-ink/70',
                narrow && (last - i) % 2 === 1 && 'invisible',
              )}
            >
              {p.label}
            </span>
          </div>
        ))}
      </div>
      {/* In focus, the line under the table names the n/a months and their reason. */}
      {key && !na && <p className="mt-2 border-t border-ink/10 pt-2 text-xs text-ink/70">{key}</p>}
      {table && (
        <>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs text-ink/70">
              <tr className="border-b border-ink/15">
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  Month
                </th>
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  {parts?.valueLabel ?? 'Value'}
                </th>
                {parts && !phone && (
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {parts.denominatorLabel}
                  </th>
                )}
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  Status
                </th>
                {showChange && (
                  <th scope="col" className="py-1.5 font-medium">
                    {phone ? 'Change' : 'Change vs previous report'}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, change, first }) => {
                const shownParts = partsOf(p)
                return (
                  <tr key={p.key} className="border-b border-ink/10">
                    <th scope="row" className={`${cellClass} font-normal`}>
                      {p.fullLabel}
                    </th>
                    <td className={`${cellClass} font-semibold tabular-nums`}>
                      {p.display || '—'}
                      {phone && shownParts && <span className="font-normal">{` · ${shownParts}`}</span>}
                    </td>
                    {parts && !phone && <td className={`${cellClass} tabular-nums`}>{shownParts ? `${shownParts} ${partsNoun}` : '—'}</td>}
                    <td className={cellClass}>
                      {p.status ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span data-role="status-chip" aria-hidden="true">
                            <StatusChip status={p.status} scale={scale} />
                          </span>
                          <span>{nameOf(p.status)}</span>
                        </span>
                      ) : (
                        'Not rated'
                      )}
                    </td>
                    {showChange && (
                      <td className="py-2 tabular-nums">
                        {change ? (
                          <span data-tone={change.move.tone} className={clsx('font-medium', MOVE_CLASS[change.move.tone])}>
                            {change.move.arrow && <span aria-hidden="true">{change.move.arrow} </span>}
                            {tableChange(change.text, phone)}
                          </span>
                        ) : (
                          <span className="text-ink/70">{first ? 'First in the window' : '—'}</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {na && <p className="mt-2 text-xs text-ink/70">{na}</p>}
        </>
      )}
      <PointControls tip={tip} scale={scale}>
        <PointButtons points={points} onSelect={setTip} naText={(p) => p.naReason || 'Not applicable'} />
      </PointControls>
    </div>
  )
}
