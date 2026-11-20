import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useId, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { components } from '../../api/schema'
import { StatusChip, type StatusLevel } from '../../ui/status'
import { usePrefersReducedMotion } from '../../ui/Sparkline'
import { MOVE_CLASS } from './charts/chartTheme'
import { buildPoints } from './charts/points'
import { RatioChart } from './charts/RatioChart'
import type { VersionMarker } from './charts/versionMarkers'
import type { Column } from './columns'
import { ITEM_PARAM, type ItemRow } from './logic/itemGrid'
import type { NounForms } from './logic/nouns'
import { columnUnit, sinceText, thresholdText } from './logic/statusText'

type ViewRow = components['schemas']['ViewRow']

export interface ItemDrillInProps {
  /** The metric's head row: name, format, direction, kind and frequency. */
  head: ViewRow
  /** The item, over the columns shown. */
  row: ItemRow
  columns: Column[]
  scale: StatusLevel[]
  noun: NounForms
  /** How many items the grid has: `‹ All 24 services`. */
  total: number
  onBack: () => void
  /** The item's `h3`; the dialog moves focus to it on entry. */
  headingRef: RefObject<HTMLHeadingElement | null>
  fy: number
  /** Methodology changes within the columns. */
  markers?: VersionMarker[]
  /**
   * Where the item sits in the grid's visible order (§4): `index` null when it
   * is not in it (its group shut, or filtered out); `prev` and `next` absent
   * at the ends. Not in the order, `next` is the order's first item.
   */
  position: { index: number | null; total: number; prev?: { id: string; name: string }; next?: { id: string; name: string } }
  onStep: (itemId: string) => void
}

const STEP =
  'inline-flex size-8 items-center justify-center rounded-md text-ink/80 hover:bg-ink/5 disabled:cursor-default disabled:text-ink/30 disabled:hover:bg-transparent'

/**
 * One item's trend in place of the grid (§6.6): a breadcrumb back to all
 * items, the item's name as the heading with its group and its own rule (the
 * rule after per-subject bands), a stepper to the previous and next item
 * (§4), the value row, and the focus line chart banded by that rule.
 */
export function ItemDrillIn({
  head,
  row,
  columns,
  scale,
  noun,
  total,
  onBack,
  headingRef,
  fy,
  markers = [],
  position,
  onStep,
}: ItemDrillInProps) {
  const headingId = useId()
  const [params] = useSearchParams()
  const reduced = usePrefersReducedMotion()
  const prevRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  // The stepper button that had focus when a step began (a click, or J/K pressed on it), and the item then:
  // once the step lands on an end and disables that button, focus moves to the other one.
  const pressed = useRef<{ on: 'prev' | 'next'; from: string } | null>(null)
  useLayoutEffect(() => {
    const p = pressed.current
    if (!p || p.from === row.id) return
    pressed.current = null
    if (p.on === 'next' && !position.next) prevRef.current?.focus()
    else if (p.on === 'prev' && !position.prev) nextRef.current?.focus()
  })
  const step = (which: 'prev' | 'next') => {
    const target = position[which]
    if (!target) return
    pressed.current = { on: which, from: row.id }
    onStep(target.id)
  }
  // The dialog's shortcuts make the J/K step; this only notes which button had focus.
  const noteStepperKey = (e: KeyboardEvent<HTMLButtonElement>, on: 'prev' | 'next') => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 'j' || key === 'k') pressed.current = { on, from: row.id }
  }
  const forget = (e: FocusEvent<HTMLButtonElement>) => {
    // A button that loses focus by being disabled has no related target; that one is the case to handle.
    if (e.relatedTarget) pressed.current = null
  }
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label
  const worst = [...scale].sort((a, b) => b.rank - a.rank)[0]
  const worstLabel = worst?.label ?? worst?.key ?? ''
  const unit = (n: number) => columnUnit(columns[columns.length - 1], n)

  const back = new URLSearchParams(params)
  back.delete(ITEM_PARAM)
  const goBack = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    onBack()
  }

  // The item's own rule in the selected column, or its latest in the window.
  const rule =
    row.cell?.rule ??
    [...row.row.cells].reverse().find((c) => c.rule && columns.some((col) => col.period === c.period && !c.ytd))?.rule
  const threshold = rule
    ? thresholdText(rule, {
        format: head.format,
        direction: head.direction,
        chartKind: head.chartKind,
        frequency: head.frequency,
        statusLabel,
        items: true,
        surface: 'focus',
      })
    : ''

  const points = buildPoints(row.row, columns, fy)
  const values = points.filter((p) => p.kind === 'value')
  const since = sinceText(row.cells, row.cells.length - 1, columns, statusLabel)
  const worstMonths = row.worstCount > 0 ? `${row.worstCount} ${worstLabel} ${unit(row.worstCount)} in the last ${columns.length}` : ''
  const summary = [
    `${row.name} ${head.metricName.toLowerCase()} over ${columns.length} ${unit(columns.length)}`,
    values.length > 0 ? `: from ${values[0]!.display} to ${values[values.length - 1]!.display}` : ': no values',
    threshold ? `; ${threshold}` : '',
    `; ${worstLabel} in ${row.worstCount} ${unit(row.worstCount)}`,
  ].join('')

  return (
    <section aria-labelledby={headingId} data-testid="item-drill-in">
      <div data-testid="drill-crumbs" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {/* On phones the breadcrumb takes its own line; the details and the stepper share the next, so no line starts with a stray `·`. */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 max-sm:basis-full">
          <Link to={{ search: back.toString() }} onClick={goBack} className="font-medium text-accent-deep hover:underline">
            <span aria-hidden="true">‹ </span>
            All {total} {total === 1 ? noun.one : noun.many}
          </Link>
          <span aria-hidden="true" className="text-ink/70">
            /
          </span>
          <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
            {row.name}
          </h3>
        </nav>
        {(row.group || threshold) && (
          <>
            <span aria-hidden="true" className="hidden text-ink/70 sm:inline">
              ·
            </span>
            <span data-testid="drill-details" className="min-w-0 text-ink/70 max-sm:flex-1">
              {[row.group, threshold].filter(Boolean).join(' · ')}
            </span>
          </>
        )}
        <div role="group" aria-label={`Step through ${noun.many}`} className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            ref={prevRef}
            type="button"
            disabled={!position.prev}
            aria-label={position.prev ? `Previous ${noun.one}: ${position.prev.name}` : `Previous ${noun.one}`}
            aria-keyshortcuts="K"
            title={`Previous ${noun.one} (K)`}
            className={STEP}
            onClick={() => step('prev')}
            onKeyDown={(e) => noteStepperKey(e, 'prev')}
            onBlur={forget}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <span className="min-w-14 text-center text-xs text-ink/70 tabular-nums">
            {position.index === null ? (
              <>
                <span aria-hidden="true">–</span>
                <span className="sr-only">not in the current list</span>
              </>
            ) : (
              `${position.index + 1} of ${position.total}`
            )}
          </span>
          <button
            ref={nextRef}
            type="button"
            disabled={!position.next}
            aria-label={position.next ? `Next ${noun.one}: ${position.next.name}` : `Next ${noun.one}`}
            aria-keyshortcuts="J"
            title={`Next ${noun.one} (J)`}
            className={STEP}
            onClick={() => step('next')}
            onKeyDown={(e) => noteStepperKey(e, 'next')}
            onBlur={forget}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div data-testid="drill-value-row" className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {row.reported ? (
          <>
            <span className="text-[28px] font-semibold leading-9 tabular-nums">{row.display || '—'}</span>
            {row.status && (
              <span role="img" aria-label={statusLabel(row.status) ?? row.status} className="inline-flex self-center">
                <StatusChip status={row.status} scale={scale} size="lg" />
              </span>
            )}
            {row.change && (
              <span data-tone={row.change.move.tone} className={`text-base font-medium tabular-nums ${MOVE_CLASS[row.change.move.tone]}`}>
                {row.change.move.arrow && <span aria-hidden="true">{row.change.move.arrow} </span>}
                {row.change.text}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="text-xl font-semibold text-ink/80">{row.current.kind === 'na' ? 'Not applicable' : 'Not reported'}</span>
            <span className="text-sm text-ink/70">
              {row.current.kind === 'na'
                ? row.current.naReason
                : row.lastReported
                  ? `Last ${row.lastReported.label} · ${row.lastReported.display}`
                  : `No reports in ${columns.length} ${unit(columns.length)}`}
            </span>
          </>
        )}
        {[since, worstMonths].filter(Boolean).length > 0 && (
          <span className="text-sm text-ink/70">{[since, worstMonths].filter(Boolean).join(' · ')}</span>
        )}
      </div>
      <p className="sr-only">{summary}</p>
      <div data-chart-region="" className="mt-2">
        <RatioChart
          row={row.row}
          points={points}
          columns={columns}
          scale={scale}
          target={row.cell?.target ?? null}
          animated={!reduced}
          size="focus"
          fyStart={fy}
          markers={markers}
        />
      </div>
    </section>
  )
}
