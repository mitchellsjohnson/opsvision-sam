import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { components } from '../../api/schema'
import { parsePeriod, type Grain } from '../../lib/period'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme, MOVE_CLASS } from './charts/chartTheme'
import type { Column } from './columns'
import { boardLayout, cellName, fiscalGroups, streakAt, VALUE_WIDTH, type BoardCell, type BoardRow } from './logic/statusBoard'

type StatusLevel = components['schemas']['StatusLevel']

const UNITS: Record<Grain, [string, string]> = {
  month: ['month', 'months'],
  quarter: ['quarter', 'quarters'],
  half: ['half', 'halves'],
  year: ['year', 'years'],
}

function unitOf(column: Column | undefined, n: number): string {
  const grain = parsePeriod(column?.period)?.grain ?? 'month'
  return UNITS[grain][n === 1 ? 0 : 1]
}

/** Diagonal hairlines: not applicable, quieter than any status and unlike the dashed no-data slot. */
const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(29 36 51 / 0.18) 0 1px, transparent 1px 5px)',
}

const SWATCH = 'inline-flex shrink-0 items-center justify-center gap-px rounded-[3px] font-semibold leading-none'
const NA_CLASS = 'border border-ink/15 bg-white'
const MISSING_CLASS = 'border border-dashed border-ink/25'

function StatusSwatch({ status, scale, className }: { status: string; scale: StatusLevel[]; className: string }) {
  const theme = chartTheme(scale, status)
  return (
    <span className={clsx(SWATCH, className)} style={{ backgroundColor: theme.color, color: theme.onColor }}>
      <span aria-hidden="true" className="text-[0.7em]">
        {theme.shape}
      </span>
      {theme.letter}
    </span>
  )
}

function Legend({ scale }: { scale: StatusLevel[] }) {
  const chip = 'h-4 w-6 text-[9px]'
  return (
    <ul aria-label="Status key" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/80">
      {[...scale]
        .sort((a, b) => a.rank - b.rank)
        .map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex">
              <StatusSwatch status={s.key} scale={scale} className={chip} />
            </span>
            {s.label}
          </li>
        ))}
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(SWATCH, chip, MISSING_CLASS)} />
        No data
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(SWATCH, chip, NA_CLASS)} style={HATCH} />
        n/a
      </li>
    </ul>
  )
}

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
    cell.kind === 'na' ? 'n/a' : cell.kind === 'missing' ? 'No data' : cell.display || capitalize(cell.caption) || theme?.label || cell.status
  return (
    <div data-testid="board-tip" className="w-max max-w-64 rounded-md bg-ink px-2 py-1.5 text-[11px] leading-4 text-white shadow-md">
      <p className="text-[13px] font-semibold tabular-nums">{lead}</p>
      <p className="text-white/75">{column.fullLabel}</p>
      {cell.kind === 'na' && <p>{cell.naReason || 'Not applicable'}</p>}
      {theme && (
        <p data-testid="tip-status">
          {[theme.shape, theme.letter, theme.label].filter(Boolean).join(' ')}
          {streak >= 2 && ` · ${streak} ${unitOf(column, streak)}`}
        </p>
      )}
      {theme && cell.display && cell.caption && <p className="text-white/75">{capitalize(cell.caption)}</p>}
      {cell.change && <p className="text-white/75">{cell.change}</p>}
    </div>
  )
}

function CurrentValue({ row, scale, compact }: { row: BoardRow; scale: StatusLevel[]; compact: boolean }) {
  const last = row.cells[row.cells.length - 1]
  if (row.current && compact) {
    return (
      <span className="block text-xs font-semibold tabular-nums">
        {row.current}
        {row.change?.move.arrow && <span className={clsx('ml-1', MOVE_CLASS[row.change.move.tone])}>{row.change.move.arrow}</span>}
      </span>
    )
  }
  if (row.current) {
    return (
      <>
        <span className="block text-sm font-semibold tabular-nums">{row.current}</span>
        {row.caption ? (
          <span className="block truncate text-[11px] text-ink/70">{row.caption}</span>
        ) : row.change ? (
          <span
            title={row.change.text}
            data-tone={row.change.move.tone}
            className={clsx('block truncate text-[11px] font-medium tabular-nums', MOVE_CLASS[row.change.move.tone])}
          >
            {row.change.move.arrow && <span aria-hidden="true">{row.change.move.arrow} </span>}
            {row.change.text}
          </span>
        ) : null}
      </>
    )
  }
  if (last?.kind === 'status') {
    return (
      <>
        <StatusSwatch status={last.status} scale={scale} className="h-4 w-6 text-[9px]" />
        {row.caption && <span className="block truncate text-[11px] text-ink/70">{row.caption}</span>}
      </>
    )
  }
  return <span className="block text-xs text-ink/70">{last?.kind === 'na' ? 'n/a' : 'No data'}</span>
}

export interface StatusBoardProps {
  /** `12-month status`, `8-quarter status`, ... */
  label: string
  columns: Column[]
  rows: BoardRow[]
  scale: StatusLevel[]
  /** Opens the metric's full-screen chart; `trigger` gets focus back on close. */
  onOpen: (metricKey: string, trigger: HTMLElement) => void
}

/**
 * Every metric's status over the trend window as a grid: one row per metric,
 * one column per period, the selected period last. One tab stop; arrow keys
 * move between cells and Enter opens the metric.
 */
export function StatusBoard({ label, columns, rows, scale, onOpen }: StatusBoardProps) {
  const headingId = useId()
  const noteId = useId()
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const tableRef = useRef<HTMLTableElement>(null)
  // Position as (row, periods back from the selected one), so a narrower board keeps the same period.
  const [active, setActive] = useState({ row: 0, back: 0 })
  const [hoverBack, setHoverBack] = useState<number | null>(null)
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  const layout = boardLayout(width, columns.length)
  const offset = columns.length - layout.count
  const shown = columns.slice(offset)
  const groups = fiscalGroups(shown)
  const fyStarts = new Set(groups.slice(1).map((g) => g.start))
  const reduced = layout.count < columns.length
  const lastIndex = shown.length - 1
  const activeRow = Math.min(active.row, Math.max(rows.length - 1, 0))
  const activeBack = Math.min(active.back, lastIndex)

  const categories: { id: string; name: string; rows: { row: BoardRow; index: number }[] }[] = []
  rows.forEach((row, index) => {
    const group = categories.find((c) => c.id === row.category.id)
    if (group) group.rows.push({ row, index })
    else categories.push({ id: row.category.id, name: row.category.name, rows: [{ row, index }] })
  })
  const grouped = categories.length > 1
  const ranked = [...scale].sort((a, b) => b.rank - a.rank)
  const colSpan = shown.length + 1 + (layout.valueColumn ? 1 : 0)

  const moveTo = (row: number, back: number) => {
    const next = { row: Math.max(0, Math.min(rows.length - 1, row)), back: Math.max(0, Math.min(lastIndex, back)) }
    setActive(next)
    tableRef.current?.querySelector<HTMLElement>(`[data-pos="${next.row}:${next.back}"]`)?.focus()
  }

  const onKeyDown = (row: number, back: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [row, back + 1],
      ArrowRight: [row, back - 1],
      ArrowUp: [row - 1, back],
      ArrowDown: [row + 1, back],
      Home: [row, lastIndex],
      End: [row, 0],
    }
    const to = moves[e.key]
    if (!to) return
    e.preventDefault()
    moveTo(to[0], to[1])
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 sm:rounded-lg sm:border sm:border-ink/20 sm:bg-white sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pr-20">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 id={headingId} className="text-base font-semibold text-accent-deep">
            {label}
          </h2>
          {reduced && (
            <span id={noteId} className="text-xs text-ink/70">
              Last {layout.count} of {columns.length} {unitOf(columns[0], columns.length)}
            </span>
          )}
        </div>
        <Legend scale={scale} />
      </div>
      <div ref={measure} className="min-w-0">
        <table
          ref={tableRef}
          role="grid"
          aria-labelledby={headingId}
          aria-describedby={reduced ? noteId : undefined}
          className="mt-3 w-full table-fixed border-separate border-spacing-0 text-sm"
          onMouseLeave={() => setHoverBack(null)}
        >
          <colgroup>
            <col />
            {shown.map((c) => (
              <col key={c.key} style={layout.cellWidth ? { width: layout.cellWidth } : undefined} />
            ))}
            {layout.valueColumn && <col style={{ width: VALUE_WIDTH }} />}
          </colgroup>
          <thead>
            {groups.length > 0 && (
              <tr>
                <td />
                {groups.map((g) => (
                  <th
                    key={g.fy}
                    scope="colgroup"
                    colSpan={g.span}
                    data-fy-start={g.start > 0 ? '' : undefined}
                    className={clsx(
                      'truncate pb-0.5 pl-1 text-left text-[10px] font-semibold uppercase tracking-wide text-ink/60',
                      g.start > 0 && 'border-l border-ink/20',
                    )}
                  >
                    {g.label}
                  </th>
                ))}
                {layout.valueColumn && <td />}
              </tr>
            )}
            <tr>
              <th scope="col" className="pb-1.5 pr-3 text-left text-xs font-medium text-ink/70">
                Metric
              </th>
              {shown.map((c, i) => {
                const back = lastIndex - i
                const selected = back === 0
                return (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.fullLabel}
                    data-selected={selected ? '' : undefined}
                    data-fy-start={fyStarts.has(i) ? '' : undefined}
                    className={clsx(
                      'relative px-px pb-1.5 text-center text-xs tabular-nums',
                      selected
                        ? 'bg-accent/[0.07] font-semibold text-accent-deep'
                        : hoverBack === back
                          ? 'font-semibold text-ink'
                          : 'font-medium text-ink/70',
                      fyStarts.has(i) && 'border-l border-ink/20',
                    )}
                  >
                    {c.label}
                    {selected && <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
                  </th>
                )
              })}
              {layout.valueColumn && (
                <th scope="col" className="pb-1.5 pl-3 text-right text-xs font-medium text-ink/70">
                  Current
                </th>
              )}
            </tr>
          </thead>
          {categories.map((category) => {
            const counts = new Map<string, number>()
            for (const { row } of category.rows) {
              const last = row.cells[row.cells.length - 1]
              if (last?.kind === 'status') counts.set(last.status, (counts.get(last.status) ?? 0) + 1)
            }
            return (
              <tbody key={category.id}>
                {grouped && (
                  <tr>
                    <th scope="rowgroup" colSpan={colSpan} className="border-b border-ink/10 pb-1 pt-3 text-left">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/70">{category.name}</span>
                      {ranked
                        .filter((s) => counts.has(s.key))
                        .map((s) => (
                          <span key={s.key} className="ml-2 inline-flex items-center gap-1 align-middle text-[11px] font-medium tabular-nums text-ink/80">
                            <span aria-hidden="true" className="inline-flex">
                              <StatusSwatch status={s.key} scale={scale} className="h-3.5 w-5 text-[8px]" />
                            </span>
                            {counts.get(s.key)}
                            <span className="sr-only"> {s.label}</span>
                          </span>
                        ))}
                    </th>
                  </tr>
                )}
                {category.rows.map(({ row, index }) => {
                  const cells = row.cells.slice(offset)
                  return (
                    <tr key={row.key} data-testid={`ribbon-${row.key}`} className="hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]">
                      <th scope="row" title={row.name} className="py-1 pr-3 text-left align-middle font-medium">
                        <span className="line-clamp-2 break-words">{row.name}</span>
                        {!layout.valueColumn && (
                          <span aria-hidden="true" className="mt-0.5 block">
                            <CurrentValue row={row} scale={scale} compact />
                          </span>
                        )}
                      </th>
                      {cells.map((cell, i) => {
                        const back = lastIndex - i
                        const column = shown[i]!
                        const tabbable = index === activeRow && back === activeBack
                        const theme = cell.kind === 'status' ? chartTheme(scale, cell.status) : null
                        return (
                          <td
                            key={cell.key}
                            className={clsx('px-px py-1 align-middle', back === 0 && 'bg-accent/[0.07]', fyStarts.has(i) && 'border-l border-ink/20')}
                          >
                            <Tooltip.Root delayDuration={150}>
                              <Tooltip.Trigger asChild>
                                <button
                                  type="button"
                                  data-pos={`${index}:${back}`}
                                  data-kind={cell.kind}
                                  tabIndex={tabbable ? 0 : -1}
                                  aria-label={cellName(row.name, column, cell, statusLabel)}
                                  className={clsx(
                                    SWATCH,
                                    'h-6 w-full text-[11px] transition-shadow hover:ring-2 hover:ring-ink/45',
                                    cell.kind === 'na' && NA_CLASS,
                                    cell.kind === 'missing' && MISSING_CLASS,
                                  )}
                                  style={theme ? { backgroundColor: theme.color, color: theme.onColor } : cell.kind === 'na' ? HATCH : undefined}
                                  onFocus={() => setActive({ row: index, back })}
                                  onMouseEnter={() => setHoverBack(back)}
                                  onKeyDown={onKeyDown(index, back)}
                                  onClick={(e) => onOpen(row.key, e.currentTarget)}
                                >
                                  {theme && (
                                    <>
                                      <span aria-hidden="true" className="text-[8px]">
                                        {theme.shape}
                                      </span>
                                      {theme.letter}
                                    </>
                                  )}
                                </button>
                              </Tooltip.Trigger>
                              <Tooltip.Portal>
                                <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className="z-50">
                                  <StatusCellTip column={column} cell={cell} streak={streakAt(row.cells, offset + i)} scale={scale} />
                                </Tooltip.Content>
                              </Tooltip.Portal>
                            </Tooltip.Root>
                          </td>
                        )
                      })}
                      {layout.valueColumn && (
                        <td className="py-1 pl-3 text-right align-middle">
                          <CurrentValue row={row} scale={scale} compact={false} />
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            )
          })}
        </table>
      </div>
    </section>
  )
}
