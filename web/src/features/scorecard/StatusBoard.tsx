import clsx from 'clsx'
import { Fragment, useEffect, useId, useMemo, useRef, useSyncExternalStore, type FocusEvent, type RefObject } from 'react'
import { textWidth, uiFont, useFontsReady } from '../../ui/textWidth'
import { useElementWidth } from '../../ui/useElementWidth'
import { ItemName, Legend, RollUp, StatusCell, StatusCellTip, StatusChip, useGridNavigation, type StatusLevel } from '../../ui/status'
import { MOVE_CLASS } from './charts/chartTheme'
import type { Column } from './columns'
import { labelsNeedYear } from './logic/itemGrid'
import { boardLayout, cellName, fiscalGroups, fiscalLabel, rowName, streakAt, type BoardRow } from './logic/statusBoard'
import { columnUnit } from './logic/statusText'

export { StatusCellTip, type StatusCellTipProps } from '../../ui/status'

const ROW_HOVER = 'hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]'
/** The Current cell's `pl-3`. */
const VALUE_PAD = 12

/** `1 of 21 Red` beside the worst item: how many share its status; '' without the counts. */
function worstCount(row: BoardRow, scale: StatusLevel[]): string {
  const last = row.counted ?? row.cells[row.cells.length - 1]
  if (!row.worst?.of || last?.kind !== 'status') return ''
  const label = scale.find((s) => s.key === last.status)?.label ?? last.status
  return `${row.worst.of.same} of ${row.worst.of.total} ${label}`
}

/** `Last Jul 77%` for a row whose last report is before the selected period; '' when none is in the window. */
function lastReportedText(row: BoardRow, columns: Column[]): string {
  for (let i = row.cells.length - 1; i >= 0; i--) {
    const cell = row.cells[i]!
    if (cell.kind !== 'status' && cell.kind !== 'unrated') continue
    const column = columns[i]
    if (!column) return ''
    return [`Last ${labelsNeedYear(columns) ? column.fullLabel : column.label}`, cell.display].filter(Boolean).join(' ')
  }
  return ''
}

/** On a phone, the worst item's own line under the metric name: its name, keeping the ending, then the count. */
function StackedWorst({ row, scale }: { row: BoardRow; scale: StatusLevel[] }) {
  if (row.current || !row.worst) return null
  const count = worstCount(row, scale) || row.caption
  return (
    <span data-testid="stacked-worst" className="flex min-w-0 text-[11px] text-ink/70">
      <ItemName name={row.worst.name} className="font-medium text-ink/80" />
      {count && <span className="shrink-0 whitespace-pre">{` · ${count}`}</span>}
    </span>
  )
}

function CurrentValue({
  row,
  scale,
  columns,
  compact,
  room,
}: {
  row: BoardRow
  scale: StatusLevel[]
  columns: Column[]
  compact: boolean
  room: number
}) {
  const last = row.counted ?? row.cells[row.cells.length - 1]
  if (!row.current && row.worst && compact) {
    return <span className="text-sm font-semibold tabular-nums">{row.worst.display}</span>
  }
  const count = !row.current && row.worst ? worstCount(row, scale) : ''
  if (!row.current && row.worst && count) {
    const font = uiFont(400, 11)
    const oneLine = textWidth(row.worst.name, uiFont(500, 11)) + textWidth(` · ${count}`, font) <= room
    if (!oneLine) {
      // Too narrow for both: the name gets the line to itself, so ItemName keeps more of it, and the count goes under.
      return (
        <>
          <span className="block text-sm font-semibold tabular-nums">{row.worst.display}</span>
          <span className="flex min-w-0 justify-end text-[11px] text-ink/70">
            <ItemName name={row.worst.name} className="font-medium text-ink/80" />
          </span>
          <span className="block truncate text-[11px] text-ink/70">{count}</span>
        </>
      )
    }
    return (
      <>
        <span className="block text-sm font-semibold tabular-nums">{row.worst.display}</span>
        <span className="flex min-w-0 justify-end text-[11px] text-ink/70">
          <ItemName name={row.worst.name} className="font-medium text-ink/80" />
          <span className="shrink-0 whitespace-pre">{` · ${count}`}</span>
        </span>
      </>
    )
  }
  if (!row.current && row.worst) {
    return (
      <>
        <span className="block text-sm font-semibold tabular-nums">{row.worst.display}</span>
        <span title={[row.worst.name, row.caption].filter(Boolean).join(' · ')} className="block truncate text-[11px] text-ink/70">
          <span className="font-medium text-ink/80">{row.worst.name}</span>
          {row.caption && (
            <>
              {' · '}
              <span>{row.caption}</span>
            </>
          )}
        </span>
      </>
    )
  }
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
  const stopped = last?.kind === 'missing' && !row.counted ? lastReportedText(row, columns) : ''
  return (
    <>
      <span className={clsx('text-[11px] text-ink/70', !compact && 'block')}>
        {last?.kind === 'na' ? 'n/a' : stopped || 'No data'}
      </span>
      {row.caption && !compact && <span className="block truncate text-[11px] text-ink/70">{row.caption}</span>}
    </>
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
  /** Every category in order, so one a filter leaves without rows still shows, reading `none match`; from the rows when absent. */
  categories?: { id: string; name: string }[]
}

/**
 * Where a category's label goes: its section's heading (`SectionHeader`), else,
 * with the section header hidden, its first tile in page order (`LayoutGrid`'s
 * `data-layout-item`); null when neither is on the page.
 */
function sectionTarget(categoryId: string, metricKeys: string[]): { scrollTo: HTMLElement; focus: HTMLElement } | null {
  const heading = document.getElementById(`section-${categoryId}`)
  if (heading) return { scrollTo: heading, focus: heading }
  const ids = new Set(metricKeys.map((k) => `metric:${k}`))
  const tile = [...document.querySelectorAll<HTMLElement>('[data-layout-item]')].find((el) => ids.has(el.dataset.layoutItem ?? ''))
  if (!tile) return null
  // The tile's frame carries the scroll margin; its first control (Expand) takes focus.
  const frame = tile.querySelector<HTMLElement>('article, section') ?? tile
  const control = tile.querySelector<HTMLElement>('button:not([disabled]), a[href]')
  return control ? { scrollTo: frame, focus: control } : null
}

function goToSection(categoryId: string, metricKeys: string[]) {
  const target = sectionTarget(categoryId, metricKeys)
  if (!target) return
  target.scrollTo.scrollIntoView?.({ block: 'start' })
  target.focus.focus({ preventScroll: true })
}

/** Sections and tiles come and go outside the board (the Health filter, Customize), so the page's DOM is watched for them. */
function subscribeToPage(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'data-layout-item'] })
  return () => observer.disconnect()
}

/** The categories whose label has somewhere to go on the page. */
function useLinkedCategories(categories: { id: string; rows: BoardRow[] }[]): Set<string> {
  const linked = useSyncExternalStore(
    subscribeToPage,
    () =>
      categories
        .filter((c) => c.rows.length > 0 && sectionTarget(c.id, c.rows.map((r) => r.key)) !== null)
        .map((c) => c.id)
        .join('\n'),
    () => '',
  )
  return useMemo(() => new Set(linked ? linked.split('\n') : []), [linked])
}

/** Marks the header while it is stuck under the control bar, in the DOM, so scrolling never re-renders the board. */
function useStuckMark(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    const table = el?.closest('table')
    if (!el || !table) return
    const update = () => {
      const top = parseFloat(getComputedStyle(el).top) || 0
      const stuck = table.getBoundingClientRect().top < top && el.getBoundingClientRect().top <= top + 0.5
      el.toggleAttribute('data-stuck', stuck)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [ref])
}

/**
 * Every metric's status over the trend window as a grid: one row per metric,
 * one column per period, the selected period last. Exceptions carry the
 * color: the best status is a soft tint, the worst a solid fill. One tab
 * stop; arrow keys move between cells and Enter opens the metric.
 */
export function StatusBoard({ label, columns, rows, scale, onOpen, categories: allCategories }: StatusBoardProps) {
  const headingId = useId()
  const noteId = useId()
  const [measure, width] = useElementWidth<HTMLDivElement>()
  // Captions measured with a fallback font are measured again once the web font loads.
  useFontsReady()
  const tableRef = useRef<HTMLTableElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  useStuckMark(theadRef)
  const hoveredHeader = useRef<HTMLElement | null>(null)
  // The cell whose dialog is open: its tooltip stays shut when focus comes back on close.
  const reopening = useRef<HTMLElement | null>(null)
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  const layout = boardLayout(width, columns.length)
  const inline = layout.valueColumn
  const offset = columns.length - layout.count
  const shown = columns.slice(offset)
  const groups = fiscalGroups(shown)
  const fyStarts = new Set(groups.slice(1).map((g) => g.start))
  const reduced = layout.count < columns.length
  const lastIndex = shown.length - 1
  const open = (metricKey: string, el: HTMLElement) => {
    reopening.current = el
    onOpen(metricKey, el)
  }
  // Anchored at the end, so a narrower board keeps the same period.
  const { cellProps } = useGridNavigation({
    rowIds: rows.map((r) => r.key),
    colCount: shown.length,
    anchor: 'end',
    onOpen: (rowId, _col, el) => open(rowId, el),
  })

  const categories: { id: string; name: string; rows: BoardRow[] }[] = (allCategories ?? []).map((c) => ({ ...c, rows: [] }))
  for (const row of rows) {
    const group = categories.find((c) => c.id === row.category.id)
    if (group) group.rows.push(row)
    else categories.push({ id: row.category.id, name: row.category.name, rows: [row] })
  }
  const grouped = categories.length > 1
  const linked = useLinkedCategories(categories)
  // Inline: name, cells, value. Stacked: a zero-width row-header column, then the cells.
  const colSpan = shown.length + (inline ? 2 : 1)

  // The hovered column's header, marked in the DOM so hovering never re-renders the board.
  const markColumn = (back: number | null) => {
    hoveredHeader.current?.removeAttribute('data-hover')
    const th = back === null ? null : (tableRef.current?.querySelector<HTMLElement>(`th[data-back="${back}"]`) ?? null)
    th?.setAttribute('data-hover', '')
    hoveredHeader.current = th
  }

  const renderCells = (row: BoardRow) =>
    row.cells.slice(offset).map((cell, i) => {
      const back = lastIndex - i
      const column = shown[i]!
      const grid = cellProps(row.key, i)
      return (
        <td
          key={cell.key}
          className={clsx('px-0.5 py-1 align-middle', fyStarts.has(i) && 'border-l border-ink/20')}
          onMouseEnter={() => markColumn(back)}
        >
          <StatusCell
            cell={cell}
            name={cellName(row.name, column, cell, statusLabel, back === 0)}
            scale={scale}
            tip={<StatusCellTip column={column} cell={cell} streak={streakAt(row.cells, offset + i)} scale={scale} />}
            grid={{
              ...grid,
              onFocus: (e: FocusEvent<HTMLElement>) => {
                grid.onFocus(e)
                if (reopening.current === e.currentTarget) {
                  reopening.current = null
                  // Relies on Radix's Trigger skipping its open-on-focus handler when the event is defaultPrevented.
                  e.preventDefault()
                }
              },
            }}
            onOpen={(el) => open(row.key, el)}
          />
        </td>
      )
    })

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 scroll-mt-[var(--control-bar-h,0px)] sm:rounded-lg sm:border sm:border-ink/20 sm:bg-white sm:p-4"
    >
      {/* The tile's drag and menu buttons sit over the top-right corner; LayoutGrid publishes their width. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2" style={{ paddingRight: 'var(--tile-toolbar, 0px)' }}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 id={headingId} className="text-base font-semibold text-accent-deep">
            {label}
          </h2>
          {reduced && (
            <span id={noteId} className="text-xs text-ink/70">
              Last {layout.count} of {columns.length} {columnUnit(columns[0], columns.length)}
            </span>
          )}
        </div>
        <Legend
          scale={scale}
          unrated={rows.some((r) => r.cells.slice(offset).some((c) => c.kind === 'unrated'))}
          notDue={rows.some((r) => r.cells.slice(offset).some((c) => c.kind === 'notDue'))}
        />
      </div>
      <div ref={measure} className="mt-3 min-w-0">
        <div className={clsx('relative isolate', inline ? 'w-full' : 'w-fit')}>
          {layout.cellWidth && (
            <div
              data-testid="current-band"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 -z-10 rounded-sm bg-accent/10"
              style={{ width: layout.cellWidth, right: layout.valueWidth }}
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
              {inline ? <col style={layout.nameWidth ? { width: layout.nameWidth } : undefined} /> : <col style={{ width: 0 }} />}
              {shown.map((c) => (
                <col key={c.key} style={layout.cellWidth ? { width: layout.cellWidth } : undefined} />
              ))}
              {inline && <col style={{ width: layout.valueWidth }} />}
            </colgroup>
            <thead
              ref={theadRef}
              className="sticky z-10 bg-white data-[stuck]:[&>tr:last-child>*]:border-b [&>tr:last-child>*]:border-b-ink/10"
              style={{ top: 'calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))' }}
            >
              {groups.length > 0 && (
                <tr>
                  <td className={inline ? undefined : 'p-0'} />
                  {groups.map((g) => {
                    const short = fiscalLabel(g, layout.cellWidth)
                    return (
                      <th
                        key={g.fy}
                        scope="colgroup"
                        colSpan={g.span}
                        title={short === g.label ? undefined : g.label}
                        data-fy-start={g.start > 0 ? '' : undefined}
                        className={clsx(
                          'truncate pb-0.5 pl-1 text-left text-[11px] font-semibold uppercase tracking-wide text-ink/70',
                          g.start > 0 && 'border-l border-ink/20',
                        )}
                      >
                        {short === g.label ? (
                          g.label
                        ) : (
                          <>
                            <span aria-hidden="true">{short}</span>
                            <span className="sr-only">{g.label}</span>
                          </>
                        )}
                      </th>
                    )
                  })}
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
                      {category.rows.length > 0 ? (
                        <>
                          {linked.has(category.id) ? (
                            <a
                              href={`#section-${category.id}`}
                              className="inline-flex min-h-6 items-center align-middle text-[11px] font-semibold uppercase tracking-wide text-ink/70 hover:underline"
                              onClick={(e) => {
                                e.preventDefault()
                                goToSection(category.id, category.rows.map((r) => r.key))
                              }}
                            >
                              {category.name}
                            </a>
                          ) : (
                            <span className="inline-flex min-h-6 items-center align-middle text-[11px] font-semibold uppercase tracking-wide text-ink/70">
                              {category.name}
                            </span>
                          )}
                          <RollUp rows={category.rows} scale={scale} />
                        </>
                      ) : (
                        <>
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/70">{category.name}</span>{' '}
                          <span className="text-xs font-normal text-ink/70">· none match</span>
                        </>
                      )}
                    </th>
                  </tr>
                )}
                {category.rows.map((row) => {
                  const muted = row.cells.slice(offset).every((c) => c.kind === 'missing' || c.kind === 'notDue')
                  const named = shown[lastIndex] ? rowName(row, shown[lastIndex], statusLabel) : undefined
                  if (inline) {
                    return (
                      <tr key={row.key} data-testid={`ribbon-${row.key}`} aria-label={named} className={ROW_HOVER}>
                        <th scope="row" title={row.name} className={clsx('py-1 pr-3 text-left align-middle font-medium', muted && 'text-ink/70')}>
                          <span className="line-clamp-2 break-words">{row.name}</span>
                        </th>
                        {renderCells(row)}
                        <td className="py-1 pl-3 text-right align-middle">
                          <CurrentValue row={row} scale={scale} columns={columns} compact={false} room={layout.valueWidth - VALUE_PAD} />
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
                            <span title={row.name} className={clsx('line-clamp-2 min-w-0 break-words font-medium', muted && 'text-ink/70')}>
                              {row.name}
                            </span>
                            <span data-testid="stacked-value" className="max-w-[45%] shrink-0 truncate">
                              <CurrentValue row={row} scale={scale} columns={columns} compact room={0} />
                            </span>
                          </span>
                          <StackedWorst row={row} scale={scale} />
                        </td>
                      </tr>
                      <tr data-testid={`ribbon-${row.key}`} aria-label={named} className={clsx(ROW_HOVER, '[tr:hover+&]:bg-ink/[0.035]')}>
                        <th scope="row" className="w-0 max-w-0 overflow-hidden p-0">
                          <span className="sr-only">{row.name}</span>
                        </th>
                        {renderCells(row)}
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
