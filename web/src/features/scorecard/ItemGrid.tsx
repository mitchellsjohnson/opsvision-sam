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
import { useItems, useOrgLevels, useOrgUnits } from '../../api/queries'
import type { components } from '../../api/schema'
import { ItemName, Legend, StatusCell, StatusCellTip, StatusChip, useGridNavigation, type StatusLevel } from '../../ui/status'
import type { GridNavigation } from '../../ui/status/useGridNavigation'
import { textWidth, uiFont, useFontsReady } from '../../ui/textWidth'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme } from './charts/chartTheme'
import type { Column } from './columns'
import { filterItems, groupItems, itemSummary, labelsNeedYear, type ItemRow, type ItemSort } from './logic/itemGrid'
import { CHIP_MD_WIDTH, itemGridLayout, type ItemGridNeeds } from './logic/itemGridLayout'
import { countNoun, nounForms, type NounForms } from './logic/nouns'
import { cellName, fiscalGroups, streakAt } from './logic/statusBoard'
import { columnUnit, sinceText } from './logic/statusText'
import { cellKey } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type Direction = components['schemas']['Direction']

const ROW_HOVER = 'hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]'
/** Below this container width the summary, toolbar, legend and group headers take their phone form. */
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

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** The group column's header: the org level the items' units sit at (`Segment`), or `Group` when they differ or are not known. */
function useGroupNoun(rows: ItemRow[]): string {
  const items = useItems({ enabled: true })
  const units = useOrgUnits()
  const levels = useOrgLevels()
  const at = new Set<string>()
  for (const r of rows) {
    const unitId = items.data?.find((i) => i.id === r.id)?.orgUnitId
    const unit = unitId ? units.data?.units.find((u) => u.id === unitId) : undefined
    if (unit) at.add(unit.levelId)
  }
  const name = at.size === 1 ? levels.data?.find((l) => at.has(l.id))?.name : undefined
  return name ? capital(nounForms(name, 'unit').one) : 'Group'
}

/** What an item's value cell reads when it is not reported this period; '' for an item silent all window. */
function notReportedText(r: ItemRow, long: boolean, stacked: boolean): string {
  if (r.current.kind === 'na') return 'n/a'
  const last = r.lastReported
  if (!last) return ''
  return `Last ${long ? last.fullLabel : last.label}${stacked || !last.display ? '' : ` ${last.display}`}`
}

/** Each column's need in px (§2.2), measured from the texts the rows will show. */
function measureNeeds(rows: ItemRow[], scale: StatusLevel[], long: boolean, groupNoun: string): ItemGridNeeds {
  const nameFont = uiFont(500, 14)
  const groupFont = uiFont(400, 12)
  const valueFont = uiFont(600, 14)
  const noteFont = uiFont(400, 12)
  let name = 0
  let value = 0
  for (const r of rows) {
    name = Math.max(name, textWidth(r.name, nameFont))
    value = Math.max(
      value,
      r.reported
        ? textWidth(r.display || chartTheme(scale, r.status).label, valueFont) + (r.status ? 6 + CHIP_MD_WIDTH : 0)
        : textWidth(notReportedText(r, long, false), noteFont),
    )
  }
  const groups = [...new Set(rows.map((r) => r.group).filter(Boolean))]
  const group =
    groups.length < 2 ? 0 : Math.max(textWidth(groupNoun, uiFont(500, 12)), ...groups.map((g) => textWidth(g, groupFont))) + 16
  return { name: name + 12, group, value: Math.min(168, Math.max(96, value + 12)), extra: EXTRA_WIDTH }
}

/** About how wide the phone key is on one line: chips and dot, labels at 11px, 10px gaps. */
function legendWidth(scale: StatusLevel[], present: Set<string>): number {
  const font = uiFont(400, 11)
  const entries = [
    ...scale.filter((s) => present.has(s.key)).map((s) => CHIP_MD_WIDTH + 4 + textWidth(s.label, font)),
    ...(present.has('missing') ? [6 + 4 + textWidth('No data', font)] : []),
    ...(present.has('na') ? [CHIP_MD_WIDTH + 4 + textWidth('n/a', font)] : []),
    ...(present.has('unrated') ? [CHIP_MD_WIDTH + 4 + textWidth('Not rated', font)] : []),
    ...(present.has('notDue') ? [CHIP_MD_WIDTH + 4 + textWidth('Not due', font)] : []),
  ]
  return entries.reduce((a, b) => a + b, 0) + 10 * Math.max(entries.length - 1, 0)
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

/**
 * The selected period's value (§2.4), on one line: the value and its chip
 * (no chip when stacked, where the cells carry the letter); else `Last Sep
 * 100.00%` (`Last Sep` stacked) or `n/a`. The group header says not
 * reported, so the cell never does.
 */
function ItemValue({ r, scale, long, stacked }: { r: ItemRow; scale: StatusLevel[]; long: boolean; stacked: boolean }) {
  if (r.reported) {
    return (
      <span data-value="" className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
        <span className="text-sm font-semibold tabular-nums">{r.display || chartTheme(scale, r.status).label}</span>
        {!stacked && r.status && <StatusChip status={r.status} scale={scale} />}
      </span>
    )
  }
  const text = notReportedText(r, long, stacked)
  return (
    <span data-value="" className="whitespace-nowrap text-xs leading-4 text-ink/70 tabular-nums">
      {text || (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No reports</span>
        </>
      )}
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
  stacked: boolean
  extra: boolean
  /** The group column is shown. */
  grouped: boolean
  /** The window is longer than a year, so `Last` names the year. */
  long: boolean
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
  const { shown, offset, fyStarts, columns, scale, stacked, extra, grouped, long, colSpan, worstColor, statusLabel, cellPropsFor, open, quiet } =
    ctx
  const cells = r.cells.slice(offset).map((cell, i) => {
    const column = shown[i]!
    const last = i === shown.length - 1
    const grid = cellPropsFor(r.id, i, index, i === activeCol)
    return (
      <td key={cell.key} className={clsx('px-0.5 py-1 align-middle', last && 'bg-accent/10', fyStarts.has(i) && 'border-l border-ink/20')}>
        <StatusCell
          cell={cell}
          name={cellName(r.name, column, cell, statusLabel, last)}
          scale={scale}
          tip={
            <StatusCellTip
              column={column}
              cell={cell}
              streak={streakAt(r.cells, offset + i)}
              scale={scale}
              title={r.name}
              titleNote={r.group || undefined}
            />
          }
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
  const value = <ItemValue r={r} scale={scale} long={long} stacked={stacked} />
  if (stacked) {
    return (
      <>
        <tr
          data-testid={`name-row-${r.id}`}
          aria-hidden="true"
          className="h-6 [&:has(+tr:focus-within)]:bg-ink/[0.035] [&:has(+tr:hover)]:bg-ink/[0.035]"
        >
          <td colSpan={colSpan} className="px-0.5 pt-1 align-bottom">
            <span className="flex items-baseline justify-between gap-3">
              <ItemName name={r.name} group={r.group} className={clsx('font-medium', !r.reported && 'text-ink/70')} />
              <span className="max-w-[45%] shrink-0 text-right">{value}</span>
            </span>
          </td>
        </tr>
        <tr data-testid={`item-${r.id}`} className={clsx(ROW_HOVER, 'h-8 [tr:hover+&]:bg-ink/[0.035]')}>
          <th scope="row" className="w-0 max-w-0 overflow-hidden p-0">
            <span className="sr-only">{r.name}</span>
          </th>
          {cells}
        </tr>
      </>
    )
  }
  return (
    <tr data-testid={`item-${r.id}`} className={clsx(ROW_HOVER, 'h-8')}>
      {/* A pointer shortcut only: the row's cells are the keyboard and screen reader path. */}
      <th scope="row" className="group cursor-pointer pr-3 text-left align-middle font-medium" onClick={() => open(r.id)}>
        <ItemName name={r.name} group={r.group} className={clsx('group-hover:underline', !r.reported && 'text-ink/70')} />
      </th>
      {grouped && <td className="truncate pr-4 align-middle text-xs text-ink/70">{r.group}</td>}
      {cells}
      <td className="pl-3 text-right align-middle">{value}</td>
      {extra && (
        <td className="pl-3 text-right align-middle text-xs tabular-nums text-ink/70">
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
  /** An item whose selected cell takes focus on mount (back from its drill-in); a silent one opens its group first. */
  restoreId?: string
  /**
   * The toolbar's right end: the range control, in month views, with the
   * column counts of its shortest and longest range. Hidden where the grid
   * shows no more columns at the longest than the shortest (phones).
   */
  range?: { control: ReactNode; minCount: number; maxCount: number }
  /** The surface's polite region; without it the grid announces in its own. */
  announce?: (message: string) => void
  /** Whether the group of items with no reports in the window is open; the grid keeps its own when absent. */
  silentOpen?: boolean
  onSilentOpen?: (open: boolean) => void
}

/**
 * An item metric's answer (§6.5): how many items are at the best status, the
 * exceptions, the worst item now, then every item × period as a keyboard
 * grid that fills its card (§2), sorted and filtered, with the not reported
 * after and the silent collapsed last.
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
  silentOpen,
  onSilentOpen,
}: ItemGridProps) {
  const hintId = useId()
  const noteId = useId()
  const silentId = useId()
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
  const long = labelsNeedYear(columns)
  const fontsReady = useFontsReady()
  const groupNoun = useGroupNoun(rows)
  // Measured once per set of texts (and again once web fonts load), not on every filter keystroke.
  const textsKey = JSON.stringify(rows.map((r) => [r.name, r.group, r.display, r.status, notReportedText(r, long, false)]))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `textsKey` stands for the texts measured from `rows`.
  const needs = useMemo(() => measureNeeds(rows, scale, long, groupNoun), [textsKey, scale, long, groupNoun, fontsReady])
  const layout = itemGridLayout(width, columns.length, needs)
  // The range control changes what the grid shows only where the longest range fits more columns than the shortest.
  const rangeShown = range !== undefined && itemGridLayout(width, range.maxCount, needs).count > range.minCount
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
  const filtering = shownFilter.trim() !== ''
  const summary = useMemo(() => itemSummary(rows, scale), [rows, scale])
  const { visible, reported, notReported, notApplicable, silent, allSilent } = useMemo(() => {
    const v = filterItems(rows, shownFilter)
    const g = groupItems(v, columns, sort, direction, scale)
    const every = groupItems(rows, columns, sort, direction, scale)
    return { visible: v, ...g, allSilent: rows.length > 0 && every.silent.length === rows.length }
  }, [rows, shownFilter, columns, sort, direction, scale])

  const [ownOpen, setOwnOpen] = useState(false)
  const open = silentOpen ?? ownOpen
  const setOpen = (next: boolean) => {
    if (silentOpen === undefined) setOwnOpen(next)
    onSilentOpen?.(next)
  }
  // While filtering, the matching silent items show; with nothing else to show, they are open.
  const silentShown = filtering || open || allSilent
  const silentToggle = !filtering && !allSilent
  const ordered = useMemo(
    () => [...reported, ...notReported, ...notApplicable, ...(silentShown ? silent : [])],
    [reported, notReported, notApplicable, silent, silentShown],
  )
  const opener = useRef(onOpenItem)
  useLayoutEffect(() => {
    opener.current = onOpenItem
  })
  const openItem = useCallback((itemId: string) => opener.current(itemId), [])
  const nav = useGridNavigation({
    rowIds: ordered.map((r) => r.id),
    colCount: shown.length,
    anchor: 'end',
    onOpen: openItem,
  })

  const [ownMessage, setOwnMessage] = useState('')
  const say = announce ?? setOwnMessage
  const shownMore = `Showing ${silent.length} more ${silent.length === 1 ? noun.one : noun.many}`

  // Back from a drill-in: focus the same item's selected cell, by id, without popping its tooltip. Only once
  // the measured width is laid out: switching to stacked rows rebuilds them, which would drop the focus.
  // An item in the shut silent group opens it first, so focus never falls back to the dialog frame.
  const restored = useRef(false)
  const askedOpen = useRef(false)
  const quiet = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !restoreId) return
    const actual = Math.floor(box.current?.getBoundingClientRect().width ?? 0)
    if (actual > 0 && actual !== Math.floor(width)) return
    if (!ordered.some((r) => r.id === restoreId)) {
      if (!silentShown && !askedOpen.current && silent.some((r) => r.id === restoreId)) {
        askedOpen.current = true
        setOpen(true)
        say(shownMore)
      } else if (!askedOpen.current) {
        restored.current = true
      }
      return
    }
    restored.current = true
    quiet.current = true
    nav.focusRow(restoreId, shown.length - 1)
  })

  const message = filtering ? `Showing ${visible.length} of ${countNoun(rows.length, noun)}` : `Showing all ${countNoun(rows.length, noun)}`
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
  const grouped = !stacked && layout.groupWidth > 0
  const colSpan = stacked ? shown.length + 1 : shown.length + 2 + (grouped ? 1 : 0) + (extra ? 1 : 0)
  const showFilter = rows.length > FILTER_MIN || filter !== ''
  const present = useMemo(() => {
    const keys = new Set<string>()
    for (const r of ordered) for (const c of r.cells.slice(offset)) keys.add(c.kind === 'status' ? c.status : c.kind)
    return keys
  }, [ordered, offset])
  const legendOneLine = narrow && legendWidth(scale, present) <= width

  const { cellPropsFor } = nav
  const ctx = useMemo<RowContext>(
    () => ({
      shown,
      offset,
      fyStarts,
      columns,
      scale,
      stacked,
      extra,
      grouped,
      long,
      colSpan,
      worstColor: worstColorOf(scale),
      statusLabel,
      cellPropsFor,
      open: openItem,
      quiet,
    }),
    [shown, offset, fyStarts, columns, scale, stacked, extra, grouped, long, colSpan, statusLabel, cellPropsFor, openItem],
  )
  const activeRow = nav.active.rowId
  const activeCol = nav.active.col
  const indexOf = new Map(ordered.map((r, i) => [r.id, i]))
  const rowOf = (r: ItemRow) => (
    <ItemGridRow key={r.id} r={r} index={indexOf.get(r.id) ?? -1} activeCol={r.id === activeRow ? activeCol : -1} ctx={ctx} />
  )
  const GROUP_LABEL = 'text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70'
  const groupHeader = (text: string) => (
    <tr>
      <th scope="rowgroup" colSpan={colSpan} className="border-b border-ink/10 pt-3 pb-1 text-left">
        <span data-group-label="" className={GROUP_LABEL}>
          {text}
        </span>
      </th>
    </tr>
  )
  const toggleSilent = () => {
    const next = !open
    setOpen(next)
    say(next ? shownMore : `Hid ${countNoun(silent.length, noun)}`)
  }

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
  const worstChip = w?.status ? (
    <span role="img" aria-label={statusLabel(w.status) ?? w.status} className="inline-flex self-center">
      <StatusChip status={w.status} scale={scale} size="lg" />
    </span>
  ) : null

  const note =
    layout.count < columns.length
      ? `Last ${layout.count} of ${columns.length} ${unit(columns.length)}`
      : columns.length > 1
        ? `${columns[0]!.fullLabel} – ${selected?.fullLabel ?? ''} · ${columns.length} ${unit(columns.length)}`
        : (selected?.fullLabel ?? '')
  const silentLabel = `No reports in the last ${columns.length} ${unit(columns.length)} · ${silent.length}${filtering ? ' match' : ''}`

  return (
    <div data-testid="item-grid">
      {!announce && (
        <p role="status" data-testid="item-grid-live" className="sr-only">
          {ownMessage}
        </p>
      )}
      <section aria-label="Summary" className={clsx('flex flex-wrap items-end justify-between gap-x-8', narrow ? 'gap-y-2' : 'gap-y-3')}>
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
        {w &&
          (narrow ? (
            // Phones: two lines, the name keeping its tail; the group and Red months are in the drill-in.
            <div data-testid="worst-now" className="grid w-full min-w-0 gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">Worst now</span>
                <ItemName name={w.name} group={w.group} className="text-sm font-semibold" />
              </span>
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="text-xl font-semibold tabular-nums">{w.display || '—'}</span>
                {worstChip}
                {since && <span className="text-xs text-ink/70">{since}</span>}
              </span>
            </div>
          ) : (
            <div data-testid="worst-now" className="grid min-w-0 justify-items-end gap-0.5 text-right">
              <span className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">Worst now</span>
              <span className="flex flex-wrap items-baseline justify-end gap-x-2">
                <span className="text-base font-semibold">{w.name}</span>
                <span className="text-xl font-semibold tabular-nums">{w.display || '—'}</span>
                {worstChip}
              </span>
              {worstLine && <span className="text-xs text-ink/70">{worstLine}</span>}
            </div>
          ))}
      </section>

      <div
        role="toolbar"
        aria-label={`Arrange ${noun.many}`}
        className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2', narrow ? 'mt-3' : 'mt-4')}
      >
        {rows.length > 1 && (
          <>
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
          </>
        )}
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

      <div className={clsx('rounded-lg border border-ink/20 bg-white px-2 pb-2 sm:px-4', narrow ? 'mt-2 pt-2' : 'mt-3 pt-3')}>
        <div className={clsx('flex flex-wrap items-center justify-between gap-x-6', narrow ? 'mb-1 gap-y-1' : 'mb-2 gap-y-2')}>
          <p id={noteId} className="text-xs text-ink/70">
            {note}
          </p>
          {ordered.length > 0 && (
            <div data-testid="item-grid-legend" className="min-w-0">
              <Legend scale={scale} unrated={false} present={present} compact={narrow} oneLine={legendOneLine} />
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
                {grouped && <col style={{ width: layout.groupWidth }} />}
                {shown.map((c) => (
                  <col key={c.key} style={{ width: layout.cellWidth }} />
                ))}
                {!layout.stacked && <col style={{ width: layout.valueWidth }} />}
                {extra && <col style={{ width: EXTRA_WIDTH }} />}
              </colgroup>
              <thead>
                {/* On phones one fiscal year is the summary's period already; the row would only push the grid down. */}
                {(stacked ? groups.length > 1 : groups.length > 0) && (
                  <tr>
                    <td className={layout.stacked ? 'p-0' : undefined} />
                    {grouped && <td />}
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
                  {grouped && (
                    <th scope="col" className="truncate pb-1.5 pr-4 text-left text-xs font-medium text-ink/70">
                      {groupNoun}
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
                    <th scope="col" className="pb-1.5 pl-3 text-right text-xs font-medium text-ink/70">
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
              {silent.length > 0 && (
                // Last, so its button is the next tab stop after the grid's cells; its rows render only while shown.
                <tbody>
                  <tr>
                    <th scope="rowgroup" colSpan={colSpan} className="border-b border-ink/10 pt-3 pb-1 text-left font-normal">
                      <div
                        data-testid="silent-header"
                        className={clsx('flex min-w-0', narrow ? 'flex-col items-start' : 'items-center gap-3')}
                      >
                        <span data-group-label="" className={clsx('shrink-0', GROUP_LABEL)}>
                          {silentLabel}
                        </span>
                        {silentToggle && (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={open ? silentId : undefined}
                            className={clsx(
                              'h-7 shrink-0 rounded-md px-1.5 text-xs font-medium text-accent-deep hover:underline',
                              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                              narrow ? '-ml-1.5' : '-mx-1.5',
                            )}
                            onClick={toggleSilent}
                          >
                            {open ? 'Hide' : `Show ${countNoun(silent.length, noun)}`}
                          </button>
                        )}
                        {!narrow && silentToggle && !open && (
                          <span data-testid="silent-preview" className="min-w-0 truncate text-xs text-ink/70">
                            {silent.map((r) => r.name).join(', ')}
                          </span>
                        )}
                      </div>
                    </th>
                  </tr>
                </tbody>
              )}
              {silent.length > 0 && silentShown && <tbody id={silentId}>{silent.map(rowOf)}</tbody>}
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
