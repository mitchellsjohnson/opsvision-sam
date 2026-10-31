import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useMe, useOrgUnits, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import type { ViewRequest } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { Footnote } from '../../ui/Footnote'
import { StatusBadge } from '../../ui/StatusBadge'
import { CellDrawer, type DrawerTarget } from './CellDrawer'
import { buildColumns, columnRequest, type Column } from './columns'
import { overrideSentence } from './format'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type ScorecardView = Schemas['ScorecardView']

const HEAT: Record<string, string> = {
  G: 'bg-status-g-bg',
  Y: 'bg-status-y-bg',
  R: 'bg-status-r-bg',
}

const MAX_SUBJECTS = 200

interface MetricGroup {
  key: string
  name: string
  rows: ViewRow[]
}
interface CategoryGroup {
  id: string
  name: string
  metrics: MetricGroup[]
}

/** Rows grouped by category (in category order), then metric (in the order returned). */
function groupRows(view: ScorecardView): CategoryGroup[] {
  const byCategory = new Map<string, Map<string, MetricGroup>>()
  for (const row of view.rows) {
    const metrics = byCategory.get(row.categoryId) ?? new Map<string, MetricGroup>()
    byCategory.set(row.categoryId, metrics)
    const group = metrics.get(row.metricKey) ?? { key: row.metricKey, name: row.metricName, rows: [] }
    metrics.set(row.metricKey, group)
    group.rows.push(row)
  }
  const known = [...view.categories].sort((a, b) => a.order - b.order)
  const groups: CategoryGroup[] = []
  for (const c of known) {
    const metrics = byCategory.get(c.id)
    if (metrics) groups.push({ id: c.id, name: c.name, metrics: [...metrics.values()] })
  }
  for (const [id, metrics] of byCategory) {
    if (!known.some((c) => c.id === id)) groups.push({ id, name: 'Other', metrics: [...metrics.values()] })
  }
  return groups
}

interface RowState {
  row: ViewRow
  id: string
  visible: boolean
  /** Child rows (deeper rows whose nearest shallower row is this one). */
  childIds: string[]
  /** True when some child is hidden by default, so the row gets a toggle. */
  collapsible: boolean
}

const expandKey = (row: ViewRow) => `${row.metricKey}|${row.subjectId}`

/**
 * Which of a metric's rows show. The shallowest rows and rows at depth 1 show
 * by default (the selected subject when the view is filtered); anything
 * deeper shows once its parent row is expanded.
 */
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

/** The ids of a unit and everything below it in the org tree. */
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

function cellKey(c: Cell): string {
  return c.ytd ? `YTD:${c.period}` : c.period
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading scorecard" aria-busy="true" className="space-y-2">
      <div className="space-y-2 motion-safe:animate-pulse">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-9 rounded bg-ink/10" />
        ))}
      </div>
    </div>
  )
}

interface DataCellProps {
  row: ViewRow
  cell: Cell | undefined
  column: Column
  heat: boolean
  statusLabel: (key: string) => string | undefined
  footnoteId: string
  onOpen: (cell: Cell, opener: HTMLElement) => void
}

function DataCell({ row, cell, column, statusLabel, footnoteId, onOpen }: DataCellProps) {
  const base = clsx('px-2 py-1.5 text-center align-middle text-sm', column.ytd && 'border-l-2 border-ink/30')
  if (!cell) {
    return (
      <td className={base}>
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
    <td className={clsx(base, hasStatus && HEAT[cell.status])}>
      <div className="flex items-center justify-center gap-1">
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={(e: MouseEvent<HTMLButtonElement>) => onOpen(cell, e.currentTarget)}
          className="inline-flex min-h-8 items-center gap-2 rounded px-1.5 hover:underline"
        >
          {isNA ? (
            <span className="max-w-40 text-xs text-ink/80">{cell.naReason}</span>
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
        </button>
        {cell.override && (
          <sup>
            <a
              href={`#${footnoteId}`}
              aria-label={`Overridden: see note for ${row.metricName}, ${row.subjectName}, ${column.fullLabel}`}
              className="px-1 font-semibold text-accent-deep underline"
            >
              †
            </a>
          </sup>
        )}
      </div>
    </td>
  )
}

export interface TableTabProps {
  scorecardId: string
  scorecardName: string
}

const selectClass = 'rounded-md border border-ink/30 bg-white px-2 py-1 text-sm'

/** The scorecard table: metrics by period, colored by status, with drill-in to each cell. */
export function TableTab({ scorecardId, scorecardName }: TableTabProps) {
  const uid = useId()
  const [period] = usePeriodState()
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const orgUnits = useOrgUnits()
  const versions = useVersions(scorecardId)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<DrawerTarget | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  const restate = params.get('restate') ?? ''
  const structure = params.get('structure') === 'current' ? 'current' : 'as_of'
  const fy = period.fiscalYearStartMonth
  const columns = useMemo(
    () => buildColumns(period.period, period.ytd, fy),
    [period.period, period.ytd, fy],
  )

  const subjectKey = period.subjects.join('\n')
  const unitList = orgUnits.data?.units
  const subjects = useMemo(() => {
    const picked = subjectKey === '' ? [] : subjectKey.split('\n')
    if (picked.length === 0) return []
    return withDescendants(picked, unitList ?? []).slice(0, MAX_SUBJECTS)
  }, [subjectKey, unitList])

  const request: ViewRequest = { ...columnRequest(columns) }
  if (subjects.length > 0) request.subjects = subjects
  if (restate !== '') request.restate = restate
  if (structure === 'current') request.structure = 'current'

  // A subject filter needs the org tree first; periods need the tenant's fiscal calendar.
  const ready = period.ready && (period.subjects.length === 0 || !orgUnits.isPending)
  const view = useView(ready ? scorecardId : undefined, request)

  const scale = me.data?.tenant?.statusScale ?? []
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  function setParam(key: string, value: string | null) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const restated = versions.data?.versions.find((v) => v.id === restate)
  const first = columns.find((c) => !c.ytd) ?? columns[0]
  const last = [...columns].reverse().find((c) => !c.ytd) ?? columns[columns.length - 1]
  const range =
    first && last ? (first.fullLabel === last.fullLabel ? first.fullLabel : `${first.fullLabel} to ${last.fullLabel}`) : ''
  const ytdColumn = columns.find((c) => c.ytd)
  const caption = `${scorecardName}, ${range}${ytdColumn ? `, with ${ytdColumn.fullLabel.replace(/^Year/, 'year')}` : ''}`

  const rowId = (r: ViewRow) => `${uid}-row-${r.metricKey}-${r.subjectId}`
  const noteId = (r: ViewRow, c: Column) => `${uid}-note-${r.metricKey}-${r.subjectId}-${c.key}`

  const footnotes: { id: string; where: string; text: string }[] = []

  function toggleRow(row: ViewRow) {
    setExpanded((prev) => {
      const next = new Set(prev)
      const key = expandKey(row)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  let content
  if (view.isPending) {
    content = <Skeleton />
  } else if (view.isError) {
    content = (
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
    content = <p className="text-sm text-ink/80">No results for this selection.</p>
  } else {
    const data = view.data
    const groups = groupRows(data)
    const colSpan = columns.length
    content = (
      <div
        role="region"
        aria-label={`${scorecardName} table`}
        // A scrolling region must be reachable by keyboard so wide tables can be panned (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="max-h-[75vh] overflow-auto rounded-md border border-ink/20 bg-white"
      >
        <table className="border-separate border-spacing-0 text-sm">
          <caption className="sticky left-0 px-3 py-2 text-left text-sm font-medium">{caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 w-64 min-w-64 max-w-64 border-b border-ink/30 bg-white px-3 py-2 text-left font-semibold"
              >
                Metric and subject
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  title={c.fullLabel}
                  className={clsx(
                    'sticky top-0 z-20 min-w-20 border-b border-ink/30 bg-white px-2 py-2 text-center font-semibold',
                    c.ytd && 'border-l-2 border-l-ink/30',
                  )}
                >
                  {c.label}
                  {c.ytd && <span className="sr-only"> {c.fullLabel.replace(/^Year to date/, '')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id}>
              <tr>
                <th
                  scope="rowgroup"
                  className="sticky left-0 z-10 w-64 min-w-64 max-w-64 border-b border-ink/20 bg-cream px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide"
                >
                  {g.name}
                </th>
                <td colSpan={colSpan} className="border-b border-ink/20 bg-cream" />
              </tr>
              {g.metrics.flatMap((m) => {
                const { states, baseDepth } = rowStates(m.rows, expanded, rowId)
                const byId = new Map(states.map((s) => [s.id, s]))
                return states.map((s, i) => {
                  const { row } = s
                  const cells = new Map(row.cells.map((c) => [cellKey(c), c]))
                  const isFirst = i === 0
                  const indent = (row.depth - baseDepth) * 1.25
                  const open = s.collapsible && s.childIds.some((id) => byId.get(id)?.visible)
                  return (
                    <tr key={s.id} id={s.id} hidden={!s.visible}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 w-64 min-w-64 max-w-64 border-b border-ink/10 bg-white px-3 py-1.5 text-left font-normal"
                      >
                        <div className="flex items-start gap-1" style={{ paddingLeft: `${indent}rem` }}>
                          {s.collapsible ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={s.childIds.join(' ')}
                              aria-label={`${open ? 'Hide' : 'Show'} subjects under ${row.subjectName}`}
                              onClick={() => toggleRow(row)}
                              className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-cream"
                            >
                              {open ? (
                                <ChevronDown aria-hidden="true" size={16} />
                              ) : (
                                <ChevronRight aria-hidden="true" size={16} />
                              )}
                            </button>
                          ) : (
                            <span className="inline-block w-5 shrink-0" aria-hidden="true" />
                          )}
                          <span>
                            <span className={isFirst ? 'block font-medium' : 'sr-only'}>{row.metricName}</span>{' '}
                            <span className={clsx(isFirst && 'text-xs text-ink/80')}>{row.subjectName}</span>
                          </span>
                        </div>
                      </th>
                      {columns.map((c) => {
                        const cell = cells.get(c.key)
                        const id = noteId(row, c)
                        if (s.visible && cell?.override) {
                          footnotes.push({
                            id,
                            where: `${row.metricName}, ${row.subjectName}, ${c.fullLabel}`,
                            text: overrideSentence(cell.override),
                          })
                        }
                        return (
                          <DataCell
                            key={c.key}
                            row={row}
                            cell={cell}
                            column={c}
                            heat
                            statusLabel={statusLabel}
                            footnoteId={id}
                            onOpen={(opened, button) => {
                              opener.current = button
                              setSelected({ row, cell: opened, columnLabel: c.fullLabel, fiscalYearStartMonth: fy })
                            }}
                          />
                        )
                      })}
                    </tr>
                  )
                })
              })}
            </tbody>
          ))}
        </table>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex flex-col text-xs font-medium">
          <label htmlFor={`${uid}-restate`}>View under methodology…</label>
          <select
            id={`${uid}-restate`}
            className={clsx(selectClass, 'mt-1')}
            value={restate}
            onChange={(e) => setParam('restate', e.target.value || null)}
          >
            <option value="">As reported</option>
            {(versions.data?.versions ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.status === 'published' ? '' : ` (${v.status.replace('_', ' ')})`}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="flex items-center gap-4 text-sm">
          <legend className="mb-1 text-xs font-medium">Structure</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${uid}-structure`}
              className="size-4 accent-accent"
              checked={structure === 'as_of'}
              onChange={() => setParam('structure', null)}
            />
            As of each month
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${uid}-structure`}
              className="size-4 accent-accent"
              checked={structure === 'current'}
              onChange={() => setParam('structure', 'current')}
            />
            Today&apos;s structure
          </label>
        </fieldset>
      </div>

      {restate !== '' && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-amber bg-cream px-4 py-2 text-sm"
        >
          <p>{`Restated under ${restated?.name ?? 'the selected methodology version'}. Stored results are unchanged.`}</p>
          <button
            type="button"
            onClick={() => setParam('restate', null)}
            className="rounded-md border border-ink/40 bg-white px-3 py-1 text-sm font-medium"
          >
            Back to as-reported
          </button>
        </div>
      )}

      <div className="mt-4">{content}</div>

      {footnotes.length > 0 && (
        <section aria-label="Override notes" className="mt-3 space-y-1">
          {footnotes.map((f) => (
            <Footnote key={f.id} id={f.id} marker="†">
              <span className="font-medium">{f.where}: </span>
              <span>{f.text}</span>
            </Footnote>
          ))}
        </section>
      )}

      <CellDrawer
        scorecardId={scorecardId}
        target={selected}
        onClose={() => setSelected(null)}
        returnFocusTo={opener}
      />
    </div>
  )
}
