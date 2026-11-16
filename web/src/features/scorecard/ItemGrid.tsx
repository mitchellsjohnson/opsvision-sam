import clsx from 'clsx'
import { Search } from 'lucide-react'
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useItems, useOrgUnits } from '../../api/queries'
import type { components } from '../../api/schema'
import { Legend, StatusCell, StatusCellTip, StatusChip, useGridNavigation, type StatusLevel } from '../../ui/status'
import type { GridNavigation } from '../../ui/status/useGridNavigation'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme } from './charts/chartTheme'
import type { Column } from './columns'
import { filterItems, itemSummary, sortItems, type ItemRow, type ItemSort } from './logic/itemGrid'
import { itemGridLayout } from './logic/itemGridLayout'
import { countNoun, type NounForms } from './logic/nouns'
import { cellName, fiscalGroups, streakAt } from './logic/statusBoard'
import { columnUnit, sinceText } from './logic/statusText'
import { cellKey } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type Direction = components['schemas']['Direction']

const ROW_HOVER = 'hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]'
/** Below this container width the value column narrows and drops its chip, and groups hide. */
const NARROW = 640
const EXTRA_WIDTH = 112
/** The filter appears once there are more items than fit in a glance. */
const FILTER_MIN = 12

/** Each item's org unit name (`useItems` + `useOrgUnits`); `Unassigned` when it has none, '' until known. */
export function useItemGroups(): (itemId: string) => string {
  const items = useItems({ enabled: true })
  const units = useOrgUnits()
  return useCallback(
    (itemId: string) => {
      const item = items.data?.find((i) => i.id === itemId)
      if (!item) return ''
      if (!item.orgUnitId) return 'Unassigned'
      return units.data?.units.find((u) => u.id === item.orgUnitId)?.name ?? ''
    },
    [items.data, units.data],
  )
}

/**
 * Buttons in a radio group (§3.11): one tab stop; arrows, Home and End move
 * and select. The selected option is white, bold and outlined, so selection
 * never rests on fill alone.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const move = (to: number) => {
    const next = options[(to + options.length) % options.length]
    if (!next) return
    onChange(next.value)
    refs.current.get(next.value)?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    if (e.key in step) move(index + step[e.key]!)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(options.length - 1)
    else return
    e.preventDefault()
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-ink/[0.06] p-0.5">
      {options.map((o) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              if (el) refs.current.set(o.value, el)
              else refs.current.delete(o.value)
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={clsx(
              'h-7 whitespace-nowrap rounded-md px-2.5 text-xs',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              checked ? 'bg-white font-semibold text-ink inset-ring-1 inset-ring-ink/55' : 'font-medium text-ink/80 hover:text-ink',
            )}
            onKeyDown={onKeyDown}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function ItemValue({
  r,
  scale,
  columns,
  narrow,
  compact,
}: {
  r: ItemRow
  scale: StatusLevel[]
  columns: Column[]
  narrow: boolean
  compact: boolean
}) {
  if (r.reported) {
    return (
      <span className="inline-flex items-center justify-end gap-1.5">
        <span className="text-sm font-semibold tabular-nums">{r.display || chartTheme(scale, r.status).label}</span>
        {!narrow && !compact && r.status && <StatusChip status={r.status} scale={scale} />}
      </span>
    )
  }
  const na = r.current.kind === 'na'
  const span = columns.length
  const detail = na
    ? r.current.naReason
    : r.lastReported
      ? narrow
        ? `Last ${r.lastReported.label}`
        : `Last ${r.lastReported.label} · ${r.lastReported.display}`
      : `No reports in ${span} ${columnUnit(columns[span - 1], span)}`
  return (
    <span className="block leading-4">
      <span className={clsx('block whitespace-nowrap text-ink/80', narrow ? 'text-[11px]' : 'text-xs')}>
        {na ? 'Not applicable' : 'Not reported'}
      </span>
      {detail && <span className="block text-[11px] text-ink/70">{detail}</span>}
    </span>
  )
}

/** The worst status's color, for the Red months bars. */
function worstColorOf(scale: StatusLevel[]): string {
  const worst = [...scale].sort((a, b) => b.rank - a.rank)[0]
  return worst ? chartTheme(scale, worst.key).color : 'var(--color-ink)'
}

/** What every row reads that does not change from one row to the next; memoized, so rows can skip. */
interface RowContext {
  shown: Column[]
  offset: number
  fyStarts: Set<number>
  columns: Column[]
  scale: StatusLevel[]
  narrow: boolean
  stacked: boolean
  extra: boolean
  colSpan: number
  worstColor: string
  statusLabel: (key: string) => string | undefined
  cellPropsFor: GridNavigation['cellPropsFor']
  open: (itemId: string) => void
  /** Set when focus is restored by script, so that one focus does not pop the cell's tooltip. */
  quiet: RefObject<boolean>
}

/**
 * One item's row (two when stacked). Memoized: it redraws only when its
 * item, its place in the order or whether it holds the tab stop changes,
 * so typing in the filter or moving the tab stop leaves the other rows be.
 */
const ItemGridRow = memo(function ItemGridRow({
  r,
  index,
  activeCol,
  ctx,
}: {
  r: ItemRow
  /** Its place in the order. */
  index: number
  /** The column holding the tab stop in this row, or -1. */
  activeCol: number
  ctx: RowContext
}) {
  const { shown, offset, fyStarts, columns, scale, narrow, stacked, extra, colSpan, worstColor, statusLabel, cellPropsFor, open, quiet } = ctx
  const cells = r.cells.slice(offset).map((cell, i) => {
    const column = shown[i]!
    const last = i === shown.length - 1
    const grid = cellPropsFor(r.id, i, index, i === activeCol)
    return (
      <td key={cell.key} className={clsx('px-0.5 py-0.5 align-middle', last && 'bg-accent/10', fyStarts.has(i) && 'border-l border-ink/20')}>
        <StatusCell
          cell={cell}
          name={cellName(r.name, column, cell, statusLabel, last)}
          scale={scale}
          tip={<StatusCellTip column={column} cell={cell} streak={streakAt(r.cells, offset + i)} scale={scale} />}
          grid={{
            ...grid,
            onFocus: (e: FocusEvent<HTMLElement>) => {
              grid.onFocus(e)
              if (quiet.current) {
                quiet.current = false
                // Radix's tooltip trigger skips its open-on-focus when the event is defaultPrevented.
                e.preventDefault()
              }
            },
          }}
          onOpen={() => open(r.id)}
        />
      </td>
    )
  })
  const value = <ItemValue r={r} scale={scale} columns={columns} narrow={narrow} compact={stacked} />
  if (stacked) {
    return (
      <>
        <tr
          data-testid={`name-row-${r.id}`}
          aria-hidden="true"
          className="[&:has(+tr:focus-within)]:bg-ink/[0.035] [&:has(+tr:hover)]:bg-ink/[0.035]"
        >
          <td colSpan={colSpan} className="px-0.5 pt-2">
            <span className="flex items-baseline justify-between gap-3">
              <span data-name="" className={clsx('line-clamp-2 min-w-0 break-words font-medium', !r.reported && 'text-ink/70')}>
                {r.name}
              </span>
              <span className="max-w-[45%] shrink-0 text-right">{value}</span>
            </span>
          </td>
        </tr>
        <tr data-testid={`item-${r.id}`} className={clsx(ROW_HOVER, '[tr:hover+&]:bg-ink/[0.035]')}>
          <th scope="row" className="w-0 max-w-0 overflow-hidden p-0">
            <span className="sr-only">{r.name}</span>
          </th>
          {cells}
        </tr>
      </>
    )
  }
  return (
    <tr data-testid={`item-${r.id}`} className={ROW_HOVER}>
      {/* A pointer shortcut only: the row's cells are the keyboard and screen reader path. */}
      <th
        scope="row"
        title={r.name}
        className={clsx('group cursor-pointer py-0.5 pr-3 text-left align-middle font-medium', !r.reported && 'text-ink/70')}
        onClick={() => open(r.id)}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span data-name="" className="line-clamp-2 min-w-0 break-words group-hover:underline">
            {r.name}
          </span>
          {!narrow && r.group && <span className="max-w-[50%] shrink-0 truncate text-[11px] font-normal leading-4 text-ink/70">{r.group}</span>}
        </span>
      </th>
      {cells}
      <td className={clsx('py-0.5 text-right align-middle', narrow ? 'pl-2' : 'pl-3')}>{value}</td>
      {extra && (
        <td className="py-0.5 pl-3 text-right align-middle text-xs tabular-nums text-ink/70">
          {r.worstCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              {r.worstCount}
              <span aria-hidden="true" className="h-1.5 w-11 overflow-hidden rounded-full bg-ink/[0.06]">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.min(100, (r.worstCount / columns.length) * 100)}%`, backgroundColor: worstColor }}
                />
              </span>
            </span>
          ) : (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">0</span>
            </>
          )}
        </td>
      )}
    </tr>
  )
})

export interface ItemGridProps {
  /** The metric's head row: its name and format; a unit row with a value leads the summary. */
  head: ViewRow
  /** Every item, unfiltered. */
  rows: ItemRow[]
  /** The window shown; the last is the selected period. */
  columns: Column[]
  scale: StatusLevel[]
  direction: Direction
  noun: NounForms
  sort: ItemSort
  onSort: (sort: ItemSort) => void
  filter: string
  onFilter: (text: string) => void
  onOpenItem: (itemId: string) => void
  /** An item whose selected cell takes focus on mount (back from its drill-in). */
  restoreId?: string
  /**
   * The toolbar's right end: the range control, in month views, with the
   * column counts of its shortest and longest range. Hidden where the grid
   * shows no more columns at the longest than the shortest (phones).
   */
  range?: { control: ReactNode; minCount: number; maxCount: number }
  /** The surface's polite region; without it the grid announces in its own. */
  announce?: (message: string) => void
}

/**
 * An item metric's answer (§6.5): how many items are at the best status, the
 * exceptions, the worst item now, then every item × period as a keyboard
 * grid, sorted and filtered, with the not reported last.
 */
export function ItemGrid({
  head,
  rows,
  columns,
  scale,
  direction,
  noun,
  sort,
  onSort,
  filter,
  onFilter,
  onOpenItem,
  restoreId,
  range,
  announce,
}: ItemGridProps) {
  const hintId = useId()
  const noteId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const box = useRef<HTMLDivElement | null>(null)
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el
      measure(el)
    },
    [measure],
  )
  const narrow = width > 0 && width < NARROW
  const layoutOpts = { valueWidth: narrow ? 76 : 136, extraWidth: EXTRA_WIDTH, nameMin: 96 }
  const layout = itemGridLayout(width, columns.length, layoutOpts)
  // The range control changes what the grid shows only where the longest range fits more columns than the shortest.
  const rangeShown = range !== undefined && itemGridLayout(width, range.maxCount, layoutOpts).count > range.minCount
  const offset = columns.length - layout.count
  const shown = useMemo(() => columns.slice(offset), [columns, offset])
  const selected = columns[columns.length - 1]
  const unit = (n: number) => columnUnit(selected, n)
  const statusLabel = useCallback((key: string) => scale.find((s) => s.key === key)?.label, [scale])
  const byRank = [...scale].sort((a, b) => a.rank - b.rank)
  const best = byRank[0]
  const worst = byRank[byRank.length - 1]
  const worstLabel = worst?.label ?? worst?.key ?? ''

  // The grid follows the filter at a lower priority than the input, so typing stays quick on a long list.
  const shownFilter = useDeferredValue(filter)
  const summary = useMemo(() => itemSummary(rows, scale), [rows, scale])
  const { visible, reported, notReported, notApplicable } = useMemo(() => {
    const v = filterItems(rows, shownFilter)
    return { visible: v, ...sortItems(v, sort, direction, scale) }
  }, [rows, shownFilter, sort, direction, scale])
  const ordered = useMemo(() => [...reported, ...notReported, ...notApplicable], [reported, notReported, notApplicable])
  const opener = useRef(onOpenItem)
  useLayoutEffect(() => {
    opener.current = onOpenItem
  })
  const open = useCallback((itemId: string) => opener.current(itemId), [])
  const nav = useGridNavigation({
    rowIds: ordered.map((r) => r.id),
    colCount: shown.length,
    anchor: 'end',
    onOpen: open,
  })

  // Back from a drill-in: focus the same item's selected cell, by id, without popping its tooltip. Only once
  // the measured width is laid out: switching to stacked rows rebuilds them, which would drop the focus.
  const restored = useRef(false)
  const quiet = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !restoreId) return
    const actual = Math.floor(box.current?.getBoundingClientRect().width ?? 0)
    if (actual > 0 && actual !== Math.floor(width)) return
    restored.current = true
    quiet.current = true
    nav.focusRow(restoreId, shown.length - 1)
  })

  const [ownMessage, setOwnMessage] = useState('')
  const say = announce ?? setOwnMessage
  const message = shownFilter.trim()
    ? `Showing ${visible.length} of ${countNoun(rows.length, noun)}`
    : `Showing all ${countNoun(rows.length, noun)}`
  // Announced 300 ms after typing stops; never on mount (a filter restored after a drill-in is not news).
  const announced = useRef(filter)
  useEffect(() => {
    if (shownFilter === announced.current || shownFilter !== filter) return
    const t = setTimeout(() => {
      announced.current = shownFilter
      say(message)
    }, 300)
    return () => clearTimeout(t)
  }, [shownFilter, filter, message, say])

  const groups = useMemo(() => fiscalGroups(shown), [shown])
  const fyStarts = useMemo(() => new Set(groups.slice(1).map((g) => g.start)), [groups])
  const stacked = layout.stacked
  const extra = layout.extraShown
  const colSpan = stacked ? shown.length + 1 : shown.length + 2 + (extra ? 1 : 0)
  const showFilter = rows.length > FILTER_MIN || filter !== ''
  const unrated = ordered.some((r) => r.cells.slice(offset).some((c) => c.kind === 'unrated'))
  const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

  const { cellPropsFor } = nav
  const ctx = useMemo<RowContext>(
    () => ({
      shown,
      offset,
      fyStarts,
      columns,
      scale,
      narrow,
      stacked,
      extra,
      colSpan,
      worstColor: worstColorOf(scale),
      statusLabel,
      cellPropsFor,
      open,
      quiet,
    }),
    [shown, offset, fyStarts, columns, scale, narrow, stacked, extra, colSpan, statusLabel, cellPropsFor, open],
  )
  const activeRow = nav.active.rowId
  const activeCol = nav.active.col
  const indexOf = new Map(ordered.map((r, i) => [r.id, i]))
  const rowOf = (r: ItemRow) => (
    <ItemGridRow key={r.id} r={r} index={indexOf.get(r.id) ?? -1} activeCol={r.id === activeRow ? activeCol : -1} ctx={ctx} />
  )
  const groupHeader = (text: string) => (
    <tr>
      <th
        scope="rowgroup"
        colSpan={colSpan}
        className="border-b border-ink/10 pt-3 pb-1 text-left text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70"
      >
        {text}
      </th>
    </tr>
  )

  const scopeCell = head.subjectKind !== 'item' && selected ? head.cells.find((c) => cellKey(c) === selected.key) : undefined
  const scopeLead = scopeCell && scopeCell.naReason === '' && scopeCell.value != null ? scopeCell : undefined
  const counts = [...byRank]
    .reverse()
    .filter((l) => l.key !== best?.key && (summary.counts.get(l.key) ?? 0) > 0)
    .map((l) => ({ key: l.key, shape: chartTheme(scale, l.key).shape, text: `${summary.counts.get(l.key)} ${l.label}` }))
  const unratedCount = rows.filter((r) => r.reported && !r.status).length
  const tail = [
    unratedCount > 0 ? `${unratedCount} not rated` : '',
    summary.notReported > 0 ? `${summary.notReported} not reported` : '',
    summary.notApplicable > 0 ? `${summary.notApplicable} n/a` : '',
    selected?.fullLabel ?? '',
  ].filter(Boolean)

  const w = summary.worst
  const since = w ? sinceText(w.cells, w.cells.length - 1, columns, statusLabel) : ''
  const worstMonths =
    w && w.worstCount > 0 ? `${w.worstCount} ${worstLabel} ${unit(w.worstCount)} in the last ${columns.length}` : ''
  const worstLine = [since, worstMonths, w?.group ?? ''].filter(Boolean).join(' · ')

  const note =
    layout.count < columns.length
      ? `Last ${layout.count} of ${columns.length} ${unit(columns.length)}`
      : columns.length > 1
        ? `${columns[0]!.fullLabel} – ${selected?.fullLabel ?? ''} · ${columns.length} ${unit(columns.length)}`
        : (selected?.fullLabel ?? '')

  return (
    <div data-testid="item-grid">
      {!announce && (
        <p role="status" data-testid="item-grid-live" className="sr-only">
          {ownMessage}
        </p>
      )}
      <section aria-label="Summary" className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <p className={clsx('font-semibold tabular-nums', narrow ? 'text-xl' : 'text-[28px] leading-9')}>
            {scopeLead && (
              <span className="mr-2 inline-flex flex-wrap items-baseline gap-x-2">
                <span>{head.subjectName}</span>
                <span>{scopeLead.display}</span>
                {scopeLead.status && (
                  <span role="img" aria-label={statusLabel(scopeLead.status) ?? scopeLead.status} className="inline-flex self-center">
                    <StatusChip status={scopeLead.status} scale={scale} size="lg" />
                  </span>
                )}
                <span aria-hidden="true">·</span>
              </span>
            )}
            <span>{`${summary.best} of ${countNoun(summary.total, noun)} ${best?.label ?? ''}`}</span>
          </p>
          <p data-testid="summary-counts" className="mt-0.5 text-sm text-ink/80">
            {counts.map((c, i) => (
              <Fragment key={c.key}>
                {i > 0 && ' · '}
                <span aria-hidden="true">{c.shape}</span> {c.text}
              </Fragment>
            ))}
            {tail.map((t, i) => (
              <Fragment key={t}>
                {counts.length > 0 || i > 0 ? ' · ' : ''}
                {t}
              </Fragment>
            ))}
          </p>
        </div>
        {w && (
          <div data-testid="worst-now" className={clsx('grid min-w-0 gap-0.5', !narrow && 'justify-items-end text-right')}>
            <span className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">Worst now</span>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-base font-semibold">{w.name}</span>
              <span className="text-xl font-semibold tabular-nums">{w.display || '—'}</span>
              {w.status && (
                <span role="img" aria-label={statusLabel(w.status) ?? w.status} className="inline-flex self-center">
                  <StatusChip status={w.status} scale={scale} size="lg" />
                </span>
              )}
            </span>
            {worstLine && <span className="text-xs text-ink/70">{worstLine}</span>}
          </div>
        )}
      </section>

      <div role="toolbar" aria-label={`Arrange ${noun.many}`} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-ink/70">Sort</span>
        <SegmentedControl
          label={`Sort ${noun.many}`}
          options={[
            { value: 'worst', label: 'Worst now' },
            { value: 'reds', label: `Most ${worstLabel} ${unit(2)}` },
            { value: 'name', label: 'Name' },
          ]}
          value={sort}
          onChange={onSort}
        />
        {showFilter && (
          <div className={clsx('relative', narrow ? 'w-full' : 'w-[220px]')}>
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink/55" />
            <input
              ref={inputRef}
              type="search"
              aria-label={`Filter ${noun.many}`}
              placeholder={`Filter ${countNoun(rows.length, noun)}`}
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears a filter first; only an empty one lets Escape close the surface.
                if (e.key !== 'Escape' || filter === '') return
                e.preventDefault()
                onFilter('')
              }}
              className="h-8 w-full rounded-md border border-ink/30 bg-white pr-2 pl-7 text-sm placeholder:text-ink/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
          </div>
        )}
        {rangeShown && <div className="ml-auto">{range.control}</div>}
      </div>

      <div className="mt-3 rounded-lg border border-ink/20 bg-white px-2 pt-3 pb-2 sm:px-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p id={noteId} className="text-xs text-ink/70">
            {note}
          </p>
          {ordered.length > 0 && (
            // On phones the key sits in even rows of three, so no entry wraps onto a line alone.
            <div
              data-testid="item-grid-legend"
              className={clsx(narrow && '[&>ul]:grid [&>ul]:grid-cols-3 [&>ul]:justify-items-start')}
            >
              <Legend scale={scale} unrated={unrated} />
            </div>
          )}
        </div>
        <div ref={setBox} className="min-w-0">
          {ordered.length === 0 ? (
            <div className="py-6 text-center text-sm">
              <p>
                No {noun.many} match “{filter.trim()}”.
              </p>
              <button
                type="button"
                className="mt-2 rounded-md px-2 py-1 text-sm font-medium text-accent-deep hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => {
                  onFilter('')
                  inputRef.current?.focus()
                }}
              >
                Clear filter
              </button>
            </div>
          ) : (
            <table
              role="grid"
              aria-label={`${head.metricName} by ${noun.one} and ${unit(1)}`}
              aria-describedby={`${noteId} ${hintId}`}
              data-stacked={String(layout.stacked)}
              className="table-fixed border-separate border-spacing-0 text-sm"
              style={{ width: layout.tableWidth }}
            >
              <colgroup>
                <col style={{ width: layout.stacked ? 0 : layout.nameWidth }} />
                {shown.map((c) => (
                  <col key={c.key} style={{ width: layout.cellWidth }} />
                ))}
                {!layout.stacked && <col style={{ width: layout.valueWidth }} />}
                {extra && <col style={{ width: EXTRA_WIDTH }} />}
              </colgroup>
              <thead>
                {groups.length > 0 && (
                  <tr>
                    <td className={layout.stacked ? 'p-0' : undefined} />
                    {groups.map((g) => (
                      <th
                        key={g.fy}
                        scope="colgroup"
                        colSpan={g.span}
                        className={clsx(
                          'truncate pb-0.5 pl-1 text-left text-[11px] font-semibold uppercase tracking-wide text-ink/70',
                          g.start > 0 && 'border-l border-ink/20',
                        )}
                      >
                        {g.label}
                      </th>
                    ))}
                    {!layout.stacked && <td />}
                    {extra && <td />}
                  </tr>
                )}
                <tr>
                  {layout.stacked ? (
                    <td className="p-0" />
                  ) : (
                    <th scope="col" className="pb-1.5 pr-3 text-left text-xs font-medium text-ink/70">
                      {capital(noun.one)}
                    </th>
                  )}
                  {shown.map((c, i) => {
                    const isSelected = i === shown.length - 1
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        title={c.fullLabel}
                        className={clsx(
                          'relative px-0.5 pb-1.5 text-center text-xs tabular-nums',
                          isSelected ? 'font-semibold text-accent-deep' : 'font-medium text-ink/70',
                          fyStarts.has(i) && 'border-l border-ink/20',
                        )}
                      >
                        {c.label}
                        {isSelected && <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
                      </th>
                    )
                  })}
                  {!layout.stacked && (
                    <th scope="col" className={clsx('pb-1.5 text-right text-xs font-medium text-ink/70', narrow ? 'pl-2' : 'pl-3')}>
                      {selected?.label}
                      <span className="sr-only"> value</span>
                    </th>
                  )}
                  {extra && (
                    <th scope="col" className="pb-1.5 pl-3 text-right text-xs font-medium text-ink/70">
                      {worstLabel} {unit(2)}
                    </th>
                  )}
                </tr>
              </thead>
              {reported.length > 0 && <tbody>{reported.map(rowOf)}</tbody>}
              {notReported.length > 0 && (
                <tbody>
                  {groupHeader(`Not reported this ${unit(1)} · ${notReported.length}`)}
                  {notReported.map(rowOf)}
                </tbody>
              )}
              {notApplicable.length > 0 && (
                <tbody>
                  {groupHeader(`Not applicable this ${unit(1)} · ${notApplicable.length}`)}
                  {notApplicable.map(rowOf)}
                </tbody>
              )}
            </table>
          )}
        </div>
        {ordered.length > 0 && (
          <p id={hintId} className="mt-2 text-[11px] leading-4 text-ink/70">
            Arrow keys move between cells · Enter opens the {noun.one}’s trend · Home/End jump to the first or current {unit(1)}
          </p>
        )}
      </div>
    </div>
  )
}
