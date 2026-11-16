import { Fragment } from 'react'
import { chartTheme } from '../../features/scorecard/charts/chartTheme'
import type { BoardCell, BoardRow } from '../../features/scorecard/logic/statusBoard'
import type { StatusLevel } from './StatusChip'

const BLANK_LABELS: Record<Exclude<BoardCell['kind'], 'status'>, string> = {
  missing: 'no data',
  na: 'n/a',
  unrated: 'not rated',
  notDue: 'not due',
}

/**
 * The selected period's exceptions as quiet text, `◆ 1 Red · ▲ 1 Yellow`, or
 * `All Green` when nothing is off; rows with no status are counted too
 * (`· 1 no data`), so a category is never called all green over a gap.
 * Nothing when no row has a status.
 */
export function RollUp({ rows, scale }: { rows: BoardRow[]; scale: StatusLevel[] }) {
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
  if (counts.size === 0) return null
  const ranked = [...scale].sort((a, b) => b.rank - a.rank)
  const best = ranked[ranked.length - 1]
  const exceptions = ranked.filter((s) => s !== best && counts.has(s.key))
  const parts = [
    ...(exceptions.length === 0
      ? [<Fragment key="all">All {best?.label ?? ''}</Fragment>]
      : exceptions.map((s) => (
          <Fragment key={s.key}>
            <span aria-hidden="true">{chartTheme(scale, s.key).shape}</span> {counts.get(s.key)} {s.label}
          </Fragment>
        ))),
    ...[...blanks].map(([label, n]) => <Fragment key={label}>{`${n} ${label}`}</Fragment>),
  ]
  return (
    <span className="ml-2 text-[11px] font-normal text-ink/70">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {part}
        </Fragment>
      ))}
    </span>
  )
}
