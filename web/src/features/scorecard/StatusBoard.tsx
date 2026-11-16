import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { Fragment, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import type { components } from '../../api/schema'
import { parsePeriod, type Grain } from '../../lib/period'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme, MOVE_CLASS, statusFill } from './charts/chartTheme'
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

/** Diagonal hairlines: not applicable, quieter than any status and unlike the no-data dot. */
const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-ink) 18%, transparent) 0 1px, transparent 1px 5px)',
}

const CHIP = 'inline-flex h-4 w-7 shrink-0 items-center justify-center gap-px rounded-[3px] border text-[11px] font-semibold leading-none'
const ROW_HOVER = 'hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]'

function fillStyle(scale: StatusLevel[], status: string): CSSProperties {
  const fill = statusFill(scale, status)
  return { backgroundColor: fill.background, color: fill.letter, borderColor: fill.border ?? 'transparent' }
}

/** A status chip with its shape and letter, filled as the cells are: for the legend and the value column. */
function StatusChip({ status, scale }: { status: string; scale: StatusLevel[] }) {
  const theme = chartTheme(scale, status)
  return (
    <span className={CHIP} style={fillStyle(scale, status)}>
      <span aria-hidden="true">{theme.shape}</span>
      {theme.letter}
    </span>
  )
}

function NoDataDot() {
  return <span data-dot="" aria-hidden="true" className="size-1 rounded-full bg-ink/35" />
}

function Legend({ scale }: { scale: StatusLevel[] }) {
  return (
    <ul aria-label="Status key" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/80">
      {[...scale]
        .sort((a, b) => a.rank - b.rank)
        .map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex">
              <StatusChip status={s.key} scale={scale} />
            </span>
            {s.label}
          </li>
        ))}
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(CHIP, 'border-transparent')}>
          <NoDataDot />
        </span>
        No data
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(CHIP, 'border-ink/15 bg-white')} style={HATCH} />
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
      <span className="text-sm font-semibold tabular-nums">
        {row.current}
        {row.change?.move.arrow && <span className={clsx('ml-1 text-[11px]', MOVE_CLASS[row.change.move.tone])}>{row.change.move.arrow}</span>}
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
        <StatusChip status={last.status} scale={scale} />
        {row.caption && !compact && <span className="block truncate text-[11px] text-ink/70">{row.caption}</span>}
      </>
    )
  }
  return <span className={clsx('text-[11px] text-ink/70', !compact && 'block')}>{last?.kind === 'na' ? 'n/a' : 'No data'}</span>
}

/** Only the exceptions, as quiet text: `◆ 1 Red · ▲ 1 Yellow`; `All Green` when nothing is off; nothing when nothing reported. */
function RollUp({ rows, scale }: { rows: BoardRow[]; scale: StatusLevel[] }) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const last = row.cells[row.cells.length - 1]
    if (last?.kind === 'status') counts.set(last.status, (counts.get(last.status) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const ranked = [...scale].sort((a, b) => b.rank - a.rank)
  const best = ranked[ranked.length - 1]
  const exceptions = ranked.filter((s) => s !== best && counts.has(s.key))
  return (
    <span className="ml-2 text-[11px] font-normal text-ink/70">
      {exceptions.length === 0
        ? `All ${best?.label ?? ''}`
        : exceptions.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && ' · '}
              <span aria-hidden="true">{chartTheme(scale, s.key).shape}</span> {counts.get(s.key)} {s.label}
            </Fragment>
          ))}
    </span>
  )
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
 * one column per period, the selected period last. Exceptions carry the
 * color: the best status is a soft tint, the worst a solid fill. One tab
 * stop; arrow keys move between cells and Enter opens the metric.
 */
export function StatusBoard({ label, columns, rows, scale, onOpen }: StatusBoardProps) {
  const headingId = useId()
  const noteId = useId()
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const tableRef = useRef<HTMLTableElement>(null)
  const hoveredHeader = useRef<HTMLElement | null>(null)
  // The cell whose dialog is open: its tooltip stays shut when focus comes back on close.
  const reopening = useRef<string | null>(null)
  // Position as (row, periods back from the selected one), so a narrower board keeps the same period.
  const [active, setActive] = useState({ row: 0, back: 0 })
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  const layout = boardLayout(width, columns.length)
  const inline = layout.valueColumn
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
  // Inline: name, cells, value. Stacked: a zero-width row-header column, then the cells.
  const colSpan = shown.length + (inline ? 2 : 1)

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

  // The hovered column's header, marked in the DOM so hovering never re-renders the board.
  const markColumn = (back: number | null) => {
    hoveredHeader.current?.removeAttribute('data-hover')
    const th = back === null ? null : (tableRef.current?.querySelector<HTMLElement>(`th[data-back="${back}"]`) ?? null)
    th?.setAttribute('data-hover', '')
    hoveredHeader.current = th
  }

  const onCellFocus = (row: number, back: number) => (e: FocusEvent<HTMLButtonElement>) => {
    setActive({ row, back })
    if (reopening.current === `${row}:${back}`) {
      reopening.current = null
      // Stops Radix opening the tooltip on the focus the dialog hands back.
      e.preventDefault()
    }
  }

  const renderCells = (row: BoardRow, index: number) =>
    row.cells.slice(offset).map((cell, i) => {
      const back = lastIndex - i
      const column = shown[i]!
      const fill = cell.kind === 'status' ? statusFill(scale, cell.status) : null
      return (
        <td key={cell.key} className={clsx('px-0.5 py-1 align-middle', fyStarts.has(i) && 'border-l border-ink/20')}>
          <Tooltip.Root delayDuration={150}>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                data-pos={`${index}:${back}`}
                data-kind={cell.kind}
                data-tier={fill?.tier}
                tabIndex={index === activeRow && back === activeBack ? 0 : -1}
                aria-label={cellName(row.name, column, cell, statusLabel, back === 0)}
                className={clsx(
                  'flex h-6 w-full items-center justify-center rounded-[3px] border border-transparent text-[11px] font-semibold leading-none',
                  'transition-shadow hover:ring-2 hover:ring-ink/40',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink focus-visible:inset-ring-1 focus-visible:inset-ring-white',
                  cell.kind === 'na' && 'border-ink/15 bg-white',
                  cell.kind === 'unrated' && 'bg-ink/[0.06]',
                )}
                style={fill ? { backgroundColor: fill.background, color: fill.letter, borderColor: fill.border ?? 'transparent' } : cell.kind === 'na' ? HATCH : undefined}
                onFocus={onCellFocus(index, back)}
                onMouseEnter={() => markColumn(back)}
                onKeyDown={onKeyDown(index, back)}
                onClick={(e) => {
                  reopening.current = `${index}:${back}`
                  onOpen(row.key, e.currentTarget)
                }}
              >
                {fill && chartTheme(scale, cell.status).letter}
                {cell.kind === 'missing' && <NoDataDot />}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className="z-50">
                <StatusCellTip column={column} cell={cell} streak={streakAt(row.cells, offset + i)} scale={scale} />
                <Tooltip.Arrow width={10} height={5} className="fill-ink" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </td>
      )
    })

  return (
    <section aria-labelledby={headingId} className="min-w-0 sm:rounded-lg sm:border sm:border-ink/20 sm:bg-white sm:p-4">
      {/* The tile's drag and menu buttons sit over the top-right corner; LayoutGrid publishes their width. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2" style={{ paddingRight: 'var(--tile-toolbar, 0px)' }}>
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
      <div ref={measure} className="mt-3 min-w-0">
        <div className={clsx('relative isolate', inline ? 'w-full' : 'w-fit')}>
          {layout.cellWidth && (
            <div
              data-testid="current-band"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 -z-10 rounded-sm bg-accent/10"
              style={{ width: layout.cellWidth, right: inline ? VALUE_WIDTH : 0 }}
            />
          )}
          <table
            ref={tableRef}
            role="grid"
            aria-labelledby={headingId}
            aria-describedby={reduced ? noteId : undefined}
            className={clsx('table-fixed border-separate border-spacing-0 text-sm', inline && 'w-full')}
            style={!inline && layout.cellWidth ? { width: layout.count * layout.cellWidth } : undefined}
            onMouseLeave={() => markColumn(null)}
          >
            <colgroup>
              {inline ? <col /> : <col style={{ width: 0 }} />}
              {shown.map((c) => (
                <col key={c.key} style={layout.cellWidth ? { width: layout.cellWidth } : undefined} />
              ))}
              {inline && <col style={{ width: VALUE_WIDTH }} />}
            </colgroup>
            <thead>
              {groups.length > 0 && (
                <tr>
                  <td className={inline ? undefined : 'p-0'} />
                  {groups.map((g) => (
                    <th
                      key={g.fy}
                      scope="colgroup"
                      colSpan={g.span}
                      data-fy-start={g.start > 0 ? '' : undefined}
                      className={clsx(
                        'truncate pb-0.5 pl-1 text-left text-[11px] font-semibold uppercase tracking-wide text-ink/70',
                        g.start > 0 && 'border-l border-ink/20',
                      )}
                    >
                      {g.label}
                    </th>
                  ))}
                  {inline && <td />}
                </tr>
              )}
              <tr>
                {inline ? (
                  <th scope="col" className="pb-1.5 pr-3 text-left text-xs font-medium text-ink/70">
                    Metric
                  </th>
                ) : (
                  <td className="p-0" />
                )}
                {shown.map((c, i) => {
                  const back = lastIndex - i
                  const selected = back === 0
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.fullLabel}
                      data-back={back}
                      data-selected={selected ? '' : undefined}
                      data-fy-start={fyStarts.has(i) ? '' : undefined}
                      className={clsx(
                        'relative px-0.5 pb-1.5 text-center text-xs tabular-nums',
                        selected
                          ? 'font-semibold text-accent-deep'
                          : 'font-medium text-ink/70 data-[hover]:font-semibold data-[hover]:text-ink',
                        fyStarts.has(i) && 'border-l border-ink/20',
                      )}
                    >
                      {c.label}
                      {selected && <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
                    </th>
                  )
                })}
                {inline && (
                  <th scope="col" className="pb-1.5 pl-3 text-right text-xs font-medium text-ink/70">
                    Current
                  </th>
                )}
              </tr>
            </thead>
            {categories.map((category) => (
              <tbody key={category.id}>
                {grouped && (
                  <tr>
                    <th scope="rowgroup" colSpan={colSpan} className="border-b border-ink/10 pb-1 pt-3 text-left">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/70">{category.name}</span>
                      <RollUp rows={category.rows.map((r) => r.row)} scale={scale} />
                    </th>
                  </tr>
                )}
                {category.rows.map(({ row, index }) => {
                  const muted = row.cells.slice(offset).every((c) => c.kind === 'missing')
                  if (inline) {
                    return (
                      <tr key={row.key} data-testid={`ribbon-${row.key}`} className={ROW_HOVER}>
                        <th scope="row" title={row.name} className={clsx('py-1 pr-3 text-left align-middle font-medium', muted && 'text-ink/70')}>
                          <span className="line-clamp-2 break-words">{row.name}</span>
                        </th>
                        {renderCells(row, index)}
                        <td className="py-1 pl-3 text-right align-middle">
                          <CurrentValue row={row} scale={scale} compact={false} />
                        </td>
                      </tr>
                    )
                  }
                  return (
                    <Fragment key={row.key}>
                      <tr
                        data-testid={`name-row-${row.key}`}
                        aria-hidden="true"
                        className="[&:has(+tr:focus-within)]:bg-ink/[0.035] [&:has(+tr:hover)]:bg-ink/[0.035]"
                      >
                        <td colSpan={colSpan} className="px-0.5 pt-2">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className={clsx('min-w-0 break-words font-medium', muted && 'text-ink/70')}>{row.name}</span>
                            <span className="shrink-0">
                              <CurrentValue row={row} scale={scale} compact />
                            </span>
                          </span>
                        </td>
                      </tr>
                      <tr data-testid={`ribbon-${row.key}`} className={clsx(ROW_HOVER, '[tr:hover+&]:bg-ink/[0.035]')}>
                        <th scope="row" className="w-0 max-w-0 overflow-hidden p-0">
                          <span className="sr-only">{row.name}</span>
                        </th>
                        {renderCells(row, index)}
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </section>
  )
}
