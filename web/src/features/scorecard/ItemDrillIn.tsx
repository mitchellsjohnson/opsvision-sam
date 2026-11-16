import { useId, type MouseEvent, type RefObject } from 'react'
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
}

/**
 * One item's trend in place of the grid (§6.6): a breadcrumb back to all
 * items, the item's name as the heading with its group and its own rule (the
 * rule after per-subject bands), the value row, and the focus line chart
 * banded by that rule.
 */
export function ItemDrillIn({ head, row, columns, scale, noun, total, onBack, headingRef, fy, markers = [] }: ItemDrillInProps) {
  const headingId = useId()
  const [params] = useSearchParams()
  const reduced = usePrefersReducedMotion()
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
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
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
        {(row.group || threshold) && (
          <>
            {/* On phones the details take their own line, so it never starts with a stray `·`. */}
            <span aria-hidden="true" className="hidden text-ink/70 sm:inline">
              ·
            </span>
            <span data-testid="drill-details" className="text-ink/70 max-sm:basis-full">
              {[row.group, threshold].filter(Boolean).join(' · ')}
            </span>
          </>
        )}
      </nav>
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
