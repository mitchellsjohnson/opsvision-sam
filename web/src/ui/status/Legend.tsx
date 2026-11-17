import clsx from 'clsx'
import { HATCH, NoDataDot, UNRATED_CLASS } from './StatusCell'
import { CHIP_SIZE, StatusChip, type StatusLevel } from './StatusChip'

/**
 * The status key: each scale level best first, then No data, n/a, Not rated
 * when any cell is, and Not due when any cell is a coarse metric's month that
 * reports later (an empty cell, no dot). With `present` (the scale statuses
 * and `missing`, `na`, `unrated`, `notDue` that occur in the shown cells),
 * only those keys. `compact` is the phone key: 11px labels and 10px gaps, on
 * one line when `oneLine`, else wrapping.
 */
export function Legend({
  scale,
  unrated,
  notDue = false,
  present,
  compact = false,
  oneLine = false,
}: {
  scale: StatusLevel[]
  unrated: boolean
  notDue?: boolean
  present?: Set<string>
  compact?: boolean
  oneLine?: boolean
}) {
  const has = (key: string, otherwise: boolean) => (present ? present.has(key) : otherwise)
  const item = clsx('inline-flex items-center', compact ? 'gap-1' : 'gap-1.5')
  return (
    <ul
      aria-label="Status key"
      className={clsx(
        'flex items-center gap-y-1 text-ink/80',
        compact ? 'gap-x-2.5 text-[11px]' : 'gap-x-3 text-xs',
        oneLine ? 'flex-nowrap whitespace-nowrap' : 'flex-wrap',
      )}
    >
      {[...scale]
        .sort((a, b) => a.rank - b.rank)
        .filter((s) => has(s.key, true))
        .map((s) => (
          <li key={s.key} className={item}>
            <span aria-hidden="true" className="inline-flex">
              <StatusChip status={s.key} scale={scale} />
            </span>
            {s.label}
          </li>
        ))}
      {has('missing', true) && (
        <li className={item}>
          <span aria-hidden="true" className={compact ? 'inline-flex h-4 w-1.5 items-center justify-center' : clsx(CHIP_SIZE.md, 'border-transparent')}>
            <NoDataDot />
          </span>
          No data
        </li>
      )}
      {has('na', true) && (
        <li className={item}>
          <span aria-hidden="true" className={clsx(CHIP_SIZE.md, 'border-ink/15 bg-white')} style={HATCH} />
          n/a
        </li>
      )}
      {has('unrated', unrated) && (
        <li className={item}>
          <span aria-hidden="true" className={clsx(CHIP_SIZE.md, UNRATED_CLASS)} />
          Not rated
        </li>
      )}
      {has('notDue', notDue) && (
        <li className={item}>
          <span aria-hidden="true" className={clsx(CHIP_SIZE.md, 'border-ink/10')} />
          Not due
        </li>
      )}
    </ul>
  )
}
