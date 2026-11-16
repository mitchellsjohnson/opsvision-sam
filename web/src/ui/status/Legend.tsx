import clsx from 'clsx'
import { HATCH, NoDataDot, UNRATED_CLASS } from './StatusCell'
import { CHIP_SIZE, StatusChip, type StatusLevel } from './StatusChip'

/** The status key: each scale level best first, then No data, n/a, and Not rated when any cell is. */
export function Legend({ scale, unrated }: { scale: StatusLevel[]; unrated: boolean }) {
  return (
    <ul aria-label="Status key" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/80">
      {[...scale]
        .sort((a, b) => a.rank - b.rank)
        .map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex">
              <StatusChip status={s.key} scale={scale} />
            </span>
            {s.label}
          </li>
        ))}
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(CHIP_SIZE.md, 'border-transparent')}>
          <NoDataDot />
        </span>
        No data
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={clsx(CHIP_SIZE.md, 'border-ink/15 bg-white')} style={HATCH} />
        n/a
      </li>
      {unrated && (
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={clsx(CHIP_SIZE.md, UNRATED_CLASS)} />
          Not rated
        </li>
      )}
    </ul>
  )
}
