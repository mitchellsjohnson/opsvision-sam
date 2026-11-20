import { StatusChip, type StatusLevel } from '../../ui/status'
import type { BoardCell, BoardRow } from './logic/statusBoard'

/** Under the sticky control bar, with room to breathe (WCAG 2.4.11). */
export const SCROLL_MARGIN = 'calc(var(--control-bar-h, 0px) + 16px)'

const BLANK_LABELS: Record<Exclude<BoardCell['kind'], 'status'>, string> = {
  missing: 'no data',
  na: 'n/a',
  unrated: 'not rated',
  notDue: 'not due',
}

/**
 * A category's heading over its tiles (§10): the name, how many metrics it
 * holds, and its roll-up as chips, worst first (`◆R 2` `▲Y 1`), or `All
 * Green`. Metrics with no status are counted after it (`1 no data`), so a
 * section is never called all green over a gap. The board's category labels
 * link to the heading, which takes focus.
 */
export function SectionHeader({
  categoryId,
  name,
  rows,
  shown = rows.length,
  scale,
}: {
  categoryId: string
  name: string
  /** Every metric in the section; the roll-up counts them all. */
  rows: BoardRow[]
  /** How many of them a Health filter leaves on the page: `1 of 3 metrics` when fewer than all. */
  shown?: number
  scale: StatusLevel[]
}) {
  const counts = new Map<string, number>()
  const blanks = new Map<string, number>()
  for (const row of rows) {
    const last = row.counted ?? row.cells[row.cells.length - 1]
    if (last?.kind === 'status') counts.set(last.status, (counts.get(last.status) ?? 0) + 1)
    else {
      const label = BLANK_LABELS[last?.kind ?? 'missing']
      blanks.set(label, (blanks.get(label) ?? 0) + 1)
    }
  }
  const ranked = [...scale].sort((a, b) => b.rank - a.rank)
  const best = ranked[ranked.length - 1]
  const exceptions = ranked.filter((s) => s !== best && counts.has(s.key))
  const blankText = [...blanks].map(([label, n]) => `${n} ${label}`).join(' · ')

  return (
    // In Customize layout mode, LayoutGrid publishes the toolbar's width so the roll-up wraps clear of it.
    <div
      data-section-header=""
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-ink/15 pb-1.5 pt-2"
      style={{ paddingRight: 'var(--tile-toolbar, 0px)' }}
    >
      <h2
        id={`section-${categoryId}`}
        tabIndex={-1}
        className="text-base font-semibold text-accent-deep"
        style={{ scrollMarginTop: SCROLL_MARGIN }}
      >
        {name}
      </h2>
      <span className="text-xs text-ink/70">
        {shown < rows.length && `${shown} of `}
        {rows.length} {rows.length === 1 ? 'metric' : 'metrics'}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
        {exceptions.length > 0 ? (
          <ul aria-label={`${name} roll-up`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {exceptions.map((s) => (
              <li key={s.key} className="flex items-center">
                <span aria-hidden="true" className="flex items-center gap-1 text-xs font-semibold tabular-nums">
                  <StatusChip status={s.key} scale={scale} /> <span>{counts.get(s.key)}</span>
                </span>
                <span className="sr-only">{`${counts.get(s.key)} ${s.label || s.key}`}</span>
              </li>
            ))}
          </ul>
        ) : counts.size > 0 ? (
          <span className="text-xs text-ink/70">All {best?.label ?? ''}</span>
        ) : null}
        {blankText && <span className="text-xs text-ink/70">{blankText}</span>}
      </div>
    </div>
  )
}
