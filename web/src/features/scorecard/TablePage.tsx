import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMe, useOrgUnits, useScorecards, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import type { ViewRequest } from '../../lib/period'
import { useShellDock } from '../../shell/ShellDock'
import { usePeriodState } from '../../shell/usePeriodState'
import { focusReturnRef } from './focusTrigger'
import { StatusBadge } from '../../ui/StatusBadge'
import { CellDrawer, type DrawerTarget } from './CellDrawer'
import {
  buildColumns,
  columnRequest,
  groupedOverrideLabel,
  periodColumns,
  selectedColumnIndex,
  sliceTableWindow,
  type Column,
} from './columns'
import { overrideSentence, shortDate } from './format'
import { periodWindowSize, windowStart } from './logic/window'
import { cellKey, groupRows } from './viewHelpers'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']

const HEAT: Record<string, string> = {
  G: 'bg-status-g-bg',
  Y: 'bg-status-y-bg',
  R: 'bg-status-r-bg',
}

const MAX_SUBJECTS = 200
export interface TablePageProps {
  scorecardId: string
  scorecardName: string
  /** Mobile card layout instead of the grid (tests and narrow layouts). */
  compact?: boolean
  /** When set, use this width for the period window (full-screen table). */
  measureWidth?: number
  /** Full-screen focus dialog: overlay drawer, no shell dock. */
  embeddedInFocus?: boolean
}

interface RowState {
  row: ViewRow
  id: string
  visible: boolean
  childIds: string[]
  collapsible: boolean
}

const expandKey = (row: ViewRow) => `${row.metricKey}|${row.subjectId}`

function rowStates(
  rows: ViewRow[],
  expanded: Set<string>,
  idFor: (row: ViewRow) => string,
): { states: RowState[]; baseDepth: number } {
  const baseDepth = Math.min(...rows.map((r) => r.depth))
  const shownDepth = Math.max(baseDepth, 1)
  const states: RowState[] = []
  const stack: RowState[] = []
  for (const row of rows) {
    while (stack.length > 0 && (stack[stack.length - 1] as RowState).row.depth >= row.depth) stack.pop()
    const parent = stack[stack.length - 1]
    const visible =
      row.depth <= shownDepth ||
      (parent !== undefined && parent.visible && expanded.has(expandKey(parent.row)))
    const state: RowState = { row, id: idFor(row), visible, childIds: [], collapsible: false }
    if (parent) {
      parent.childIds.push(state.id)
      if (row.depth > shownDepth) parent.collapsible = true
    }
    states.push(state)
    stack.push(state)
  }
  return { states, baseDepth }
}

function withDescendants(selected: string[], units: { id: string; parentId: string }[]): string[] {
  const children = new Map<string, string[]>()
  for (const u of units) {
    const list = children.get(u.parentId) ?? []
    list.push(u.id)
    children.set(u.parentId, list)
  }
  const out = new Set<string>()
  const queue = [...selected]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (out.has(id)) continue
    out.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  return [...out]
}

/** Rows in `rows` that sit directly under `parent` in the metric hierarchy. */
export function directChildren(rows: ViewRow[], parent: ViewRow): ViewRow[] {
  const start = rows.findIndex((r) => r.metricKey === parent.metricKey && r.subjectId === parent.subjectId)
  if (start < 0) return []
  const out: ViewRow[] = []
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i]!
    if (r.metricKey !== parent.metricKey || r.depth <= parent.depth) break
    if (r.depth === parent.depth + 1) out.push(r)
  }
  return out
}

function statusMix(children: ViewRow[], columnKey: string): string | null {
  const counts: Record<string, number> = { G: 0, Y: 0, R: 0 }
  let segments = 0
  for (const child of children) {
    const cell = child.cells.find((c) => cellKey(c) === columnKey)
    if (cell?.status && cell.naReason === '') {
      counts[cell.status] = (counts[cell.status] ?? 0) + 1
      segments += 1
    }
  }
  if (segments === 0) return null
  const parts: string[] = []
  if (counts.G) parts.push(`${counts.G}G`)
  if (counts.Y) parts.push(`${counts.Y}Y`)
  if (counts.R) parts.push(`${counts.R}R`)
  return `${segments} segments · ${parts.join(' ')}`
}

function shallowest(rows: ViewRow[]): ViewRow {
  return rows.reduce((best, r) => (r.depth < best.depth ? r : best))
}

function hasValuedCellInWindow(rows: ViewRow[], windowKeys: Set<string>): boolean {
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!windowKeys.has(cellKey(cell))) continue
      if (cell.naReason !== '' || cell.display !== '' || cell.status !== '') return true
    }
  }
  return false
}

interface GroupedOverride {
  reason: string
  cells: { row: ViewRow; cell: Cell; column: Column; noteId: string }[]
}

function groupOverrides(
  entries: { row: ViewRow; cell: Cell; column: Column; noteId: string }[],
): { grouped: GroupedOverride[]; singles: typeof entries } {
  const byReason = new Map<string, typeof entries>()
  const singles: typeof entries = []
  for (const e of entries) {
    const reason = e.cell.override?.reason ?? ''
    if (!reason) continue
    const list = byReason.get(reason) ?? []
    list.push(e)
    byReason.set(reason, list)
  }
  const grouped: GroupedOverride[] = []
  for (const [reason, cells] of byReason) {
    if (cells.length > 1) grouped.push({ reason, cells })
    else singles.push(cells[0]!)
  }
  return { grouped, singles }
}

interface DataCellProps {
  cell: Cell | undefined
  column: Column
  statusLabel: (key: string) => string | undefined
  tabIndex: number
  dataRowIndex: number
  selected: boolean
  onOpen: (cell: Cell, opener: HTMLElement) => void
  onFocus: () => void
  onCellKeyDown: (e: KeyboardEvent<HTMLTableCellElement>) => void
}

function DataCell({
  cell,
  column,
  statusLabel,
  tabIndex,
  dataRowIndex,
  selected,
  onOpen,
  onFocus,
  onCellKeyDown,
}: DataCellProps) {
  const base = clsx(
    'px-2 py-1.5 text-right align-middle text-sm tabular-nums',
    column.ytd && 'border-l-2 border-ink/30',
    cell && !cell.naReason && cell.status && HEAT[cell.status],
  )
  if (!cell) {
    return (
      <td
        role="gridcell"
        tabIndex={-1}
        className={base}
        data-grid-row={dataRowIndex}
        data-grid-col={column.key}
        onKeyDown={onCellKeyDown}
        onFocus={onFocus}
      >
        <span role="img" aria-label="No data" className="text-ink/80">
          —
        </span>
      </td>
    )
  }
  const isNA = cell.naReason !== ''
  const hasStatus = !isNA && cell.status !== ''
  const missing = !isNA && !hasStatus && cell.display === ''
  return (
    <td
      role="gridcell"
      tabIndex={tabIndex}
      className={base}
      aria-selected={selected || undefined}
      data-grid-row={dataRowIndex}
      data-grid-col={column.key}
      onKeyDown={onCellKeyDown}
      onFocus={onFocus}
    >
      <CellButtonContent
        cell={cell}
        statusLabel={statusLabel}
        hasStatus={hasStatus}
        isNA={isNA}
        missing={missing}
        onOpen={onOpen}
      />
    </td>
  )
}

function CellButtonContent({
  cell,
  statusLabel,
  hasStatus,
  isNA,
  missing,
  onOpen,
}: {
  cell: Cell
  statusLabel: (key: string) => string | undefined
  hasStatus: boolean
  isNA: boolean
  missing: boolean
  onOpen: (cell: Cell, opener: HTMLElement) => void
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        aria-haspopup="dialog"
        tabIndex={-1}
        onClick={(e: MouseEvent<HTMLButtonElement>) => onOpen(cell, e.currentTarget)}
        className="inline-flex min-h-8 items-center justify-end gap-2 rounded px-1.5 hover:underline"
      >
        {isNA ? (
          <span role="img" aria-label={cell.naReason} className="rounded bg-status-na-bg px-1.5 text-xs text-ink">
            n/a
          </span>
        ) : missing ? (
          <span role="img" aria-label="No data" className="text-ink/80">
            —
          </span>
        ) : (
          <>
            <span className="font-medium">{cell.display || '—'}</span>
            {hasStatus && <StatusBadge status={cell.status} label={statusLabel(cell.status)} />}
          </>
        )}
        {cell.cutoff && <span className="sr-only">{`, month to date through ${shortDate(cell.cutoff)}`}</span>}
      </button>
      {cell.override && (
        <sup aria-hidden="true" className="font-semibold text-accent-deep">
          †
        </sup>
      )}
    </div>
  )
}

function Skeleton() {
  return (
    <p role="status" aria-busy="true">
      Loading table…
    </p>
  )
}

/** Windowed scorecard table with keyboard grid navigation and a compact card mode. */
export function TablePage({
  scorecardId,
  scorecardName,
  compact = false,
  measureWidth,
  embeddedInFocus = false,
}: TablePageProps) {
  const uid = useId()
  const [period] = usePeriodState()
  const [, setParams] = useSearchParams()
  const me = useMe()
  const orgUnits = useOrgUnits()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [onlyOffTrack, setOnlyOffTrack] = useState(false)
  const [selected, setSelected] = useState<DrawerTarget | null>(null)
  const [showGrouped, setShowGrouped] = useState<Set<string>>(() => new Set())
  const opener = useRef<HTMLElement | null>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const shouldFocusCell = useRef(false)
  const [contentWidth, setContentWidth] = useState(0)
  const [focus, setFocus] = useState({ row: 0, col: 0 })
  const { setOpen: setDockOpen, dockRef } = useShellDock()
  const useShellDockColumn = !embeddedInFocus

  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    const measure = () => setContentWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const width = measureWidth ?? (contentWidth > 0 ? contentWidth : 960)
  const visible = periodWindowSize(width)
  const fy = period.fiscalYearStartMonth
  const allColumns = useMemo(() => buildColumns(period.period, period.ytd, fy), [period.period, period.ytd, fy])
  const periodCols = periodColumns(allColumns)
  const selectedIdx = selectedColumnIndex(allColumns, period.period)
  const maxStart = Math.max(0, Math.min(periodCols.length - visible, selectedIdx - visible + 1))
  const defaultStart = windowStart(periodCols.length, visible, selectedIdx)
  const [start, setStart] = useState(defaultStart)

  useEffect(() => {
    setStart(defaultStart)
  }, [defaultStart])

  const displayColumns = useMemo(() => sliceTableWindow(allColumns, start, visible), [allColumns, start, visible])
  const windowKeys = useMemo(() => new Set(displayColumns.map((c) => c.key)), [displayColumns])

  const picked = period.subjects.length > 0 ? period.subjects : period.scope ? [period.scope] : []
  const unitList = orgUnits.data?.units
  const subjects = useMemo(() => {
    if (picked.length === 0) return []
    return withDescendants(picked, unitList ?? []).slice(0, MAX_SUBJECTS)
  }, [picked, unitList])

  const request: ViewRequest = { ...columnRequest(allColumns) }
  if (subjects.length > 0) request.subjects = subjects
  if (period.restate !== '') request.restate = period.restate
  if (period.structure === 'current') request.structure = 'current'

  const ready = period.ready && (picked.length === 0 || !orgUnits.isPending)
  const view = useView(ready ? scorecardId : undefined, request)

  const scale = me.data?.tenant?.statusScale ?? []
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label
  const canEnter = me.data?.role === 'admin' || me.data?.role === 'contributor'
  const worstKey = scale.length > 0 ? [...scale].sort((a, b) => b.rank - a.rank)[0]?.key : 'R'
  const selectedColumnKey = periodCols[selectedIdx]?.key ?? period.period

  const rowId = (r: ViewRow) => `${uid}-row-${r.metricKey}-${r.subjectId}`
  const noteId = (r: ViewRow, c: Column) => `${uid}-note-${r.metricKey}-${r.subjectId}-${c.key}`

  const openDrawer = useCallback(
    (row: ViewRow, cell: Cell, column: Column, button: HTMLElement) => {
      opener.current = button
      setSelected({ row, cell, columnLabel: column.fullLabel, fiscalYearStartMonth: fy })
    },
    [fy],
  )

  const expandAll = () => {
    if (!view.data) return
    const next = new Set<string>()
    for (const row of view.data.rows) {
      if (row.depth >= 1) next.add(expandKey(row))
    }
    setExpanded(next)
  }

  const collapseAll = () => setExpanded(new Set())

  function setFocusParam(opener?: HTMLElement) {
    if (opener) focusReturnRef.current = opener
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('focus', 'table')
      return next
    })
  }

  useEffect(() => {
    if (!useShellDockColumn) return
    setDockOpen(selected !== null)
    return () => setDockOpen(false)
  }, [selected, setDockOpen, useShellDockColumn])

  const earlierDisabled = start <= 0
  const laterDisabled = start >= maxStart

  const gridRows = useMemo(() => {
    if (!view.data) return []
    const groups = groupRows(view.data)
    const rows: { key: string; row?: ViewRow; category?: string; state?: RowState; metricEmpty?: boolean; metric?: ViewRow[] }[] = []
    for (const g of groups) {
      rows.push({ key: `cat-${g.id}`, category: g.name })
      for (const m of g.metrics) {
        if (!hasValuedCellInWindow(m.rows, windowKeys)) {
          rows.push({ key: `empty-${m.key}`, metricEmpty: true, metric: m.rows, row: shallowest(m.rows) })
          continue
        }
        const { states } = rowStates(m.rows, expanded, rowId)
        for (const s of states) {
          if (!s.visible) continue
          if (onlyOffTrack) {
            const cell = s.row.cells.find((c) => cellKey(c) === selectedColumnKey)
            if (!cell || cell.status !== worstKey) continue
          }
          rows.push({ key: s.id, row: s.row, state: s, metric: m.rows })
        }
      }
    }
    return rows
  }, [view.data, expanded, onlyOffTrack, windowKeys, selectedColumnKey, worstKey, rowId])

  const flatDataRows = useMemo(
    () => gridRows.filter((r) => r.row && !r.metricEmpty) as { key: string; row: ViewRow }[],
    [gridRows],
  )

  const overrideEntries: { row: ViewRow; cell: Cell; column: Column; noteId: string }[] = []
  if (view.data) {
    const columnByKey = new Map(allColumns.map((c) => [c.key, c]))
    for (const row of view.data.rows) {
      for (const cell of row.cells) {
        if (!cell.override) continue
        const column = columnByKey.get(cellKey(cell))
        if (!column) continue
        overrideEntries.push({ row, cell, column, noteId: noteId(row, column) })
      }
    }
  }

  const { grouped, singles } = groupOverrides(overrideEntries)

  const moveFocus = useCallback(
    (dr: number, dc: number) => {
      if (flatDataRows.length === 0 || displayColumns.length === 0) return
      shouldFocusCell.current = true
      setFocus((prev) => ({
        row: Math.max(0, Math.min(flatDataRows.length - 1, prev.row + dr)),
        col: Math.max(0, Math.min(displayColumns.length - 1, prev.col + dc)),
      }))
    },
    [flatDataRows.length, displayColumns.length],
  )

  useEffect(() => {
    if (!shouldFocusCell.current) return
    shouldFocusCell.current = false
    if (compact || view.isPending || !view.data) return
    const col = displayColumns[focus.col]
    if (!col) return
    const el = measureRef.current?.querySelector<HTMLElement>(
      `td[role="gridcell"][data-grid-row="${focus.row}"][data-grid-col="${col.key}"]`,
    )
    el?.focus()
  }, [focus, displayColumns, compact, view.isPending, view.data])

  const handleCellKeyDown = useCallback(
    (dataRowIndex: number, colIndex: number) => (e: KeyboardEvent<HTMLTableCellElement>) => {
      setFocus({ row: dataRowIndex, col: colIndex })
      const dataRow = flatDataRows[dataRowIndex]
      const col = displayColumns[colIndex]
      if (!dataRow || !col) return
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault()
          moveFocus(0, 1)
          break
        case 'ArrowLeft':
          e.preventDefault()
          moveFocus(0, -1)
          break
        case 'ArrowDown':
          e.preventDefault()
          moveFocus(1, 0)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveFocus(-1, 0)
          break
        case 'Enter': {
          e.preventDefault()
          const cell = dataRow.row.cells.find((c) => cellKey(c) === col.key)
          if (!cell || (cell.naReason !== '' && !cell.display)) return
          const btn = e.currentTarget.querySelector('button')
          openDrawer(dataRow.row, cell, col, (btn ?? e.currentTarget) as HTMLElement)
          break
        }
        default:
          break
      }
    },
    [flatDataRows, displayColumns, moveFocus, openDrawer],
  )

  const compactPeriodCols = useMemo(
    () => periodCols.slice(Math.max(0, periodCols.length - 6)),
    [periodCols],
  )

  let body
  if (view.isPending) {
    body = <Skeleton />
  } else if (view.isError) {
    body = (
      <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        <p className="font-medium text-status-r">Could not load the scorecard: {view.error.message}</p>
        <button
          type="button"
          onClick={() => void view.refetch()}
          className="mt-3 rounded-md border border-ink/40 bg-white px-3 py-1.5 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    )
  } else if (view.data.rows.length === 0) {
    body = <p className="text-sm text-ink/80">No results for this selection.</p>
  } else if (compact) {
    const groups = groupRows(view.data)
    body = (
      <ul className="space-y-3">
        {groups.flatMap((g) =>
          g.metrics.map((m) => {
            const scope = shallowest(m.rows)
            const current = scope.cells.find((c) => cellKey(c) === selectedColumnKey)
            const cells = compactPeriodCols.map((col) => scope.cells.find((c) => cellKey(c) === col.key))
            return (
              <li key={m.key}>
                <article
                  aria-label={scope.metricName}
                  className="rounded-md border border-ink/20 bg-white p-3"
                >
                  <h2 className="text-base font-semibold">{scope.metricName}</h2>
                  <p className="mt-1 text-sm tabular-nums">
                    {current && current.naReason === '' ? current.display : current?.naReason ? 'n/a' : '—'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {cells.map((cell, i) => (
                      <StatusBadge
                        key={compactPeriodCols[i]!.key}
                        status={cell && cell.naReason === '' ? cell.status : null}
                        label={cell?.status ? statusLabel(cell.status) : undefined}
                      />
                    ))}
                  </div>
                </article>
              </li>
            )
          }),
        )}
      </ul>
    )
  } else {
    const colSpan = displayColumns.length
    body = (
      <table
        role="grid"
        aria-label={`${scorecardName} table`}
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
      >
        <caption className="sr-only">{scorecardName}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              role="columnheader"
              className="sticky top-[var(--scorecard-control-bar-height)] z-20 w-[clamp(13rem,24%,18rem)] border-b border-ink/30 bg-white px-3 py-2 text-left font-semibold"
            >
              Metric and subject
            </th>
            {displayColumns.map((c) => (
              <th
                key={c.key}
                scope="col"
                role="columnheader"
                title={c.fullLabel}
                className={clsx(
                  'sticky top-[var(--scorecard-control-bar-height)] z-20 min-w-[4.5rem] border-b border-ink/30 bg-white px-2 py-2 text-center font-semibold',
                  c.ytd && 'border-l-2 border-l-ink/30',
                  !c.ytd && c.period === period.period && 'border-t-2 border-t-accent',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        {gridRows.map((entry) => {
          if (entry.category) {
            return (
              <tbody key={entry.key}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={colSpan + 1}
                    className="sticky top-[calc(var(--scorecard-control-bar-height)+2.5rem)] z-10 bg-cream px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide"
                  >
                    {entry.category}
                  </th>
                </tr>
              </tbody>
            )
          }
          if (entry.metricEmpty && entry.row) {
            return (
              <tbody key={entry.key}>
                <tr aria-label={`${entry.row.metricName}, ${entry.row.subjectName}`}>
                  <th scope="row" className="border-b border-ink/10 px-3 py-2 text-left font-medium">
                    {entry.row.metricName}
                  </th>
                  <td role="gridcell" colSpan={colSpan} tabIndex={-1} className="border-b border-ink/10 px-3 py-2 text-sm text-ink/80">
                    No data in this range
                    {canEnter && (
                      <>
                        {' · '}
                        <Link to={`/entry?scorecard=${scorecardId}&period=${period.period}`} className="font-medium text-accent-deep underline">
                          Enter data
                        </Link>
                      </>
                    )}
                  </td>
                </tr>
              </tbody>
            )
          }
          if (!entry.row || !entry.state) return null
          const { row, state } = entry
          const dataRowIndex = flatDataRows.findIndex((r) => r.key === entry.key)
          const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
          const mix =
            state.collapsible && !expanded.has(expandKey(row))
              ? statusMix(directChildren(entry.metric ?? [], row), selectedColumnKey)
              : null
          const open = state.collapsible && state.childIds.length > 0 && expanded.has(expandKey(row))
          return (
            <tbody key={entry.key}>
              <tr aria-label={`${row.metricName}, ${row.subjectName}`}>
                <th scope="row" className="border-b border-ink/10 px-3 py-1.5 text-left font-normal">
                  <div className="flex items-start gap-1">
                    {state.collapsible ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={state.childIds.join(' ')}
                        aria-label={`${open ? 'Hide' : 'Show'} subjects under ${row.subjectName}`}
                        onClick={() => {
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            const key = expandKey(row)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            return next
                          })
                        }}
                        className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-cream"
                      >
                        {open ? <ChevronDown aria-hidden size={16} /> : <ChevronRight aria-hidden size={16} />}
                      </button>
                    ) : (
                      <span className="inline-block w-5 shrink-0" aria-hidden />
                    )}
                    <span>
                      <span className="block font-medium">{row.metricName}</span>
                      <span className="text-xs text-ink/80">{row.subjectName}</span>
                      {mix && <span className="mt-0.5 block text-xs text-ink/70">{mix}</span>}
                    </span>
                  </div>
                </th>
                {displayColumns.map((c, colIndex) => {
                  const cell = cells.get(c.key)
                  const tabIndex = dataRowIndex === focus.row && colIndex === focus.col ? 0 : -1
                  return (
                    <DataCell
                      key={c.key}
                      cell={cell}
                      column={c}
                      statusLabel={statusLabel}
                      tabIndex={tabIndex}
                      dataRowIndex={dataRowIndex}
                      selected={dataRowIndex === focus.row && colIndex === focus.col}
                      onOpen={(opened, button) => openDrawer(row, opened, c, button)}
                      onFocus={() => setFocus({ row: dataRowIndex, col: colIndex })}
                      onCellKeyDown={handleCellKeyDown(dataRowIndex, colIndex)}
                    />
                  )
                })}
              </tr>
            </tbody>
          )
        })}
      </table>
    )
  }

  return (
    <div ref={measureRef} className="min-w-0">
      <h1 className="sr-only">Table</h1>
      <div
        role="toolbar"
        aria-label="Table controls"
        className="mb-3 flex flex-wrap items-center gap-2"
      >
        <button type="button" className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm" onClick={expandAll}>
          Expand all
        </button>
        <button type="button" className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm" onClick={collapseAll}>
          Collapse all
        </button>
        <button
          type="button"
          aria-pressed={onlyOffTrack}
          className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm"
          onClick={() => setOnlyOffTrack((v) => !v)}
        >
          Only off track
        </button>
        <button
          type="button"
          className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm disabled:opacity-50"
          disabled={earlierDisabled}
          onClick={() => setStart((s) => Math.max(0, s - 1))}
        >
          Earlier
        </button>
        <button
          type="button"
          className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm disabled:opacity-50"
          disabled={laterDisabled}
          onClick={() => setStart((s) => Math.min(maxStart, s + 1))}
        >
          Later
        </button>
        <button
          type="button"
          className="rounded-md border border-ink/30 bg-white px-2 py-1 text-sm"
          onClick={(e) => setFocusParam(e.currentTarget)}
        >
          Expand
        </button>
      </div>

      {body}

      {grouped.length > 0 && (
        <section aria-label="Override notes" className="mt-3 space-y-2">
          {grouped.map((g) => {
            const id = `${uid}-group-${g.reason}`
            const open = showGrouped.has(g.reason)
            return (
              <div key={g.reason} className="text-sm">
                <p>
                  <span id={id}>{groupedOverrideLabel(g.reason, g.cells.length)}</span>
                  <button
                    type="button"
                    className="ml-2 font-medium text-accent-deep underline"
                    aria-expanded={open}
                    aria-controls={`${id}-cells`}
                    onClick={() =>
                      setShowGrouped((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.reason)) next.delete(g.reason)
                        else next.add(g.reason)
                        return next
                      })
                    }
                  >
                    show cells
                  </button>
                </p>
                {open && (
                  <ul id={`${id}-cells`} className="mt-1 list-disc pl-5 text-ink/80">
                    {g.cells.map((c) => (
                      <li key={c.noteId}>
                        {c.row.metricName}, {c.row.subjectName}, {c.column.fullLabel}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </section>
      )}

      {singles.length > 0 && (
        <section aria-label="Override notes" className="mt-3 space-y-1">
          {singles.map((f) => (
            <p key={f.noteId} className="text-sm">
              <span className="font-medium">
                {f.row.metricName}, {f.row.subjectName}, {f.column.fullLabel}:{' '}
              </span>
              <span>{overrideSentence(f.cell.override!)}</span>
            </p>
          ))}
        </section>
      )}

      <CellDrawer
        scorecardId={scorecardId}
        target={selected}
        onClose={() => setSelected(null)}
        returnFocusTo={opener}
        dockContainer={useShellDockColumn ? dockRef.current : null}
        elevatedOverlay={embeddedInFocus}
      />
    </div>
  )
}

/** Table route: loads the scorecard title from the list query. */
export function TablePageRoute() {
  const { sc } = useParams()
  const scorecards = useScorecards()
  const scorecard = scorecards.data?.scorecards.find((s) => s.id === sc)
  if (scorecards.isPending) return <p role="status">Loading…</p>
  return <TablePage scorecardId={sc ?? ''} scorecardName={scorecard?.name ?? 'Scorecard'} />
}
