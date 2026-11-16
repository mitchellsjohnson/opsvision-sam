import clsx from 'clsx'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { components } from '../../api/schema'
import { StatusCell, StatusChip, type StatusLevel } from '../../ui/status'
import { MOVE_CLASS } from './charts/chartTheme'
import { headerChange } from './charts/points'
import { pointKind } from './charts/sparse'
import type { Column } from './columns'
import { formatMetricValue } from './format'
import { worstChildren } from './logic/drivers'
import type { NounForms } from './logic/nouns'
import { cellReported } from './logic/statusAtScope'
import type { BoardCell } from './logic/statusBoard'
import { columnUnit } from './logic/statusText'
import { cellKey } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']
type Direction = components['schemas']['Direction']

type SortKey = 'name' | 'value' | 'change'

export interface BreakdownProps {
  /** The metric's head row (the scope row when there is one): format and goal. */
  head: ViewRow
  children: ViewRow[]
  /** The ribbon's columns; the last one is the selected period. */
  columns: Column[]
  columnKey: string
  scale: StatusLevel[]
  direction: Direction
  noun: NounForms
  onScope: (subjectId: string) => void
  /** Opens an item's trend; without it, item names are plain text. */
  onOpenItem?: (subjectId: string) => void
}

function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function cellAt(row: ViewRow, key: string): Cell | undefined {
  return row.cells.find((c) => cellKey(c) === key)
}

function ribbonCell(row: ViewRow, col: Column): BoardCell {
  const c = cellAt(row, col.key)
  const kind = pointKind(c)
  return {
    key: col.key,
    kind: c?.status ? 'status' : kind === 'na' ? 'na' : kind === 'value' ? 'unrated' : 'missing',
    status: c?.status ?? '',
    display: c?.display ?? '',
    naReason: c?.naReason ?? '',
    change: null,
    caption: '',
  }
}

/** The change amount without its `vs Sep`, which the column header says once. */
function changeAmount(row: ViewRow, cell: Cell | undefined) {
  const change = headerChange(row, cell, 1)
  if (!change) return null
  const against = / vs (.+)$/.exec(change.text)?.[1] ?? ''
  return { ...change, amount: change.text.replace(/ vs .+$/, ''), against }
}

function SortHeader({
  label,
  sortKey,
  sort,
  ariaSort,
  onSort,
  className,
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; reversed: boolean }
  ariaSort: 'ascending' | 'descending' | 'none'
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort.key === sortKey
  const Icon = ariaSort === 'descending' ? ChevronDown : ChevronUp
  return (
    <th scope="col" aria-sort={ariaSort} className={className}>
      <button
        type="button"
        className={clsx('inline-flex items-center gap-0.5 rounded hover:text-ink', active && 'font-semibold text-ink')}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <Icon aria-hidden="true" className={clsx('size-3', !active && 'invisible')} />
      </button>
    </th>
  )
}

const HEAD = 'border-b border-ink/15 px-1 py-1.5 text-xs font-medium text-ink/70'
const CELL = 'border-b border-ink/10 px-1 py-1.5 align-middle'

/**
 * The metric by org unit or item for the selected period (§7.1): a table,
 * worst first, with a 12-period ribbon, value and chip, change, and a bar
 * against the goal for percent metrics with one. Org rows scope the
 * dashboard; item rows open the item.
 */
export function Breakdown({ head, children, columns, columnKey, scale, direction, noun, onScope, onOpenItem }: BreakdownProps) {
  const [sort, setSort] = useState<{ key: SortKey; reversed: boolean }>({ key: 'value', reversed: false })
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label ?? key

  const reported = worstChildren(children, columnKey, scale, direction).ranked.map((r) => r.row)
  const quiet = children
    .filter((r) => !cellReported(cellAt(r, columnKey)))
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
  let rows: ViewRow[]
  if (sort.key === 'name') {
    rows = [...children].sort((a, b) => a.subjectName.localeCompare(b.subjectName))
    if (sort.reversed) rows.reverse()
  } else if (sort.key === 'change') {
    const change = (r: ViewRow) => cellAt(r, columnKey)?.change ?? null
    rows = [...reported].sort((a, b) => {
      const x = change(a)
      const y = change(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      return sort.reversed ? y - x : x - y
    })
    rows.push(...quiet)
  } else {
    rows = sort.reversed ? [...reported].reverse() : reported
    rows = [...rows, ...quiet]
  }

  const onSort = (key: SortKey) =>
    setSort((was) => (was.key === key ? { key, reversed: !was.reversed } : { key, reversed: false }))
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => {
    if (sort.key !== key) return 'none'
    // Worst first is the low values when higher is better.
    const ascending = key === 'value' ? direction !== 'lower_better' : true
    return ascending !== sort.reversed ? 'ascending' : 'descending'
  }

  const index = columns.findIndex((c) => c.key === columnKey)
  const selected = columns[index]
  const goal = cellAt(head, columnKey)?.target ?? null
  const showGoal = head.format.startsWith('percent') && goal !== null
  const firstChange = children.map((r) => changeAmount(r, cellAt(r, columnKey))).find((c) => c !== null)
  const compareAll = firstChange && /average|baseline/.test(firstChange.against)
  const against = (!compareAll && columns[index - 1]?.label) || firstChange?.against || 'prior'

  const items = children.some((r) => r.subjectKind === 'item')
  const hint = !items
    ? `Worst first · choose a ${noun.one} to scope the dashboard to it`
    : onOpenItem
      ? `Worst first · choose a ${noun.one} to see its trend`
      : 'Worst first'

  const nameOf = (row: ViewRow): ReactNode => {
    const action = row.subjectKind === 'item' ? onOpenItem : onScope
    if (!action) return <span className="line-clamp-2 font-medium">{row.subjectName}</span>
    return (
      <button
        type="button"
        className="line-clamp-2 rounded text-left font-medium hover:text-accent-deep hover:underline"
        onClick={() => action(row.subjectId)}
      >
        {row.subjectName}
      </button>
    )
  }

  return (
    <section aria-label="Org breakdown" className="mt-6">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold text-accent-deep">By {noun.one}</h3>
        <p className="text-xs text-ink/70">{hint}</p>
      </div>
      <table className="w-full border-separate border-spacing-0 text-sm sm:table-fixed">
        <colgroup>
          <col className="sm:w-[28%]" />
          <col className="hidden sm:table-column sm:w-[30%]" />
          <col className="sm:w-[16%]" />
          <col className="sm:w-[14%]" />
          {showGoal && <col className="hidden sm:table-column sm:w-[12%]" />}
        </colgroup>
        <thead>
          <tr>
            <SortHeader
              label={capitalized(noun.one)}
              sortKey="name"
              sort={sort}
              ariaSort={ariaSort('name')}
              onSort={onSort}
              className={clsx(HEAD, 'text-left')}
            />
            <th scope="col" className={clsx(HEAD, 'hidden text-left sm:table-cell')}>
              Last {columns.length} {columnUnit(columns[0], columns.length)}
            </th>
            <SortHeader
              label={selected?.label ?? ''}
              sortKey="value"
              sort={sort}
              ariaSort={ariaSort('value')}
              onSort={onSort}
              className={clsx(HEAD, 'text-right')}
            />
            <SortHeader
              label={`vs ${against}`}
              sortKey="change"
              sort={sort}
              ariaSort={ariaSort('change')}
              onSort={onSort}
              className={clsx(HEAD, 'text-right')}
            />
            {showGoal && (
              <th scope="col" className={clsx(HEAD, 'hidden pl-4 text-left sm:table-cell')}>
                vs goal {formatMetricValue(head.format, goal)}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cell = cellAt(row, columnKey)
            const shown = cellReported(cell)
            const change = shown ? changeAmount(row, cell) : null
            const target = cell?.target ?? goal
            return (
              <tr key={row.subjectId} className="hover:bg-ink/[0.035]">
                <th scope="row" className={clsx(CELL, 'text-left')}>
                  {nameOf(row)}
                </th>
                <td className={clsx(CELL, 'hidden sm:table-cell')}>
                  <div
                    data-ribbon=""
                    aria-hidden="true"
                    className="grid gap-0.5"
                    style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
                  >
                    {columns.map((col) => (
                      <StatusCell key={col.key} cell={ribbonCell(row, col)} name="" scale={scale} size="xs" decorative />
                    ))}
                  </div>
                </td>
                <td className={clsx(CELL, 'whitespace-nowrap text-right')}>
                  {!shown ? (
                    <span className="text-xs text-ink/70">Not reported</span>
                  ) : cell?.naReason ? (
                    <span className="text-xs text-ink/70">n/a</span>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <span className="font-semibold tabular-nums">{cell?.display || '—'}</span>
                      {cell?.status && (
                        <span role="img" aria-label={statusLabel(cell.status)} title={statusLabel(cell.status)} className="inline-flex">
                          <StatusChip status={cell.status} scale={scale} />
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className={clsx(CELL, 'whitespace-nowrap text-right text-xs font-medium tabular-nums')}>
                  {change ? (
                    <span data-tone={change.move.tone} className={MOVE_CLASS[change.move.tone]}>
                      {change.move.arrow && <span aria-hidden="true">{change.move.arrow} </span>}
                      <span>{change.amount}</span>
                    </span>
                  ) : (
                    <span className="text-ink/70">—</span>
                  )}
                </td>
                {showGoal && (
                  <td className={clsx(CELL, 'hidden pl-4 sm:table-cell')}>
                    {shown && cell?.value != null && (
                      <div aria-hidden="true" className="relative h-2 rounded-full bg-ink/[0.06]">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-accent"
                          style={{ width: `${Math.max(0, Math.min(100, cell.value))}%` }}
                        />
                        {target !== null && (
                          <div
                            className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 bg-ink/55"
                            style={{ left: `${Math.max(0, Math.min(100, target))}%` }}
                          />
                        )}
                      </div>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}