import clsx from 'clsx'
import type { CellRca } from '../../api/queries'
import { HATCH } from '../../ui/status'
import { durationText } from './rcaText'

const SEGMENTS = ['bg-accent', 'bg-accent/60', 'bg-accent/35'] as const

/** The fill of the nth evidence segment and its swatch: accent, 60%, 35%, then ink at 30%. */
export function segmentClass(index: number): string {
  return SEGMENTS[index] ?? 'bg-ink/30'
}

/** The remainder's hatch, for the bar and the list swatch. */
export const REMAINDER_CLASS = 'border border-ink/15'
export const REMAINDER_STYLE = HATCH

interface Part {
  key: string
  minutes: number
  className: string
  remainder?: boolean
}

/** Up to five incidents are listed; the bar draws the same ones. */
export const INCIDENTS_SHOWN = 5
export const RECORDS_SHOWN = 10

function sentence(rca: CellRca, reported: number): string {
  const shown = rca.incidents.slice(0, INCIDENTS_SHOWN)
  const parts = shown.map((i) => `${i.key} ${i.countedDisplay}`)
  if (rca.unexplained) parts.push(`${durationText(rca.unexplained.minutes)} not explained`)
  if (rca.excess) parts.push(`${durationText(rca.excess.minutes)} more than reported`)
  return `${durationText(reported)} down: ${parts.join(', ')}`
}

/**
 * The gap as one 8px bar (spec §10.2): a segment per incident in evidence
 * order, the remainder hatched; with an excess, the reported downtime fills
 * the solid part and the excess is a dashed outline past a tick. Records of
 * a ratio split it evenly. Hidden from assistive technology; its sentence is
 * read instead.
 */
export function GapBar({ rca }: { rca: CellRca }) {
  const incidents = rca.incidents.slice(0, INCIDENTS_SHOWN)
  if (rca.gap.kind === 'downtime' && (incidents.length > 0 || rca.unexplained)) {
    const explained = incidents.reduce((n, i) => n + i.countedMinutes, 0)
    const reported = rca.gap.reportedMinutes ?? explained + (rca.unexplained?.minutes ?? 0)
    const parts: Part[] = incidents.map((i, n) => ({ key: `${i.source}:${i.externalId}`, minutes: i.countedMinutes, className: segmentClass(n) }))
    if (rca.unexplained) parts.push({ key: 'remainder', minutes: rca.unexplained.minutes, className: REMAINDER_CLASS, remainder: true })
    const total = parts.reduce((n, p) => n + p.minutes, 0)
    const solid = rca.excess && explained > 0 ? Math.min(100, (reported / explained) * 100) : 100
    return (
      <>
        <div aria-hidden="true" data-testid="gap-bar" className="relative mt-2 flex h-2 w-full overflow-hidden rounded">
          <div className="flex h-full gap-px" style={{ width: `${solid}%` }}>
            {parts.map((p) => (
              <span
                key={p.key}
                className={clsx('h-full min-w-px rounded-[1px]', p.className)}
                style={{ flexGrow: total > 0 ? p.minutes : 1, flexBasis: 0, ...(p.remainder ? REMAINDER_STYLE : {}) }}
              />
            ))}
          </div>
          {solid < 100 && (
            <>
              <span className="h-full w-0.5 shrink-0 bg-ink" />
              <span className="h-full flex-1 rounded-r border border-dashed border-ink/55" />
            </>
          )}
        </div>
        <span className="sr-only">{sentence(rca, reported)}</span>
      </>
    )
  }
  const records = rca.records.slice(0, RECORDS_SHOWN)
  if (records.length > 0) {
    return (
      <>
        <div aria-hidden="true" data-testid="gap-bar" className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded">
          {records.map((r, n) => (
            <span key={`${r.contribution.source}:${r.contribution.externalId}`} className={clsx('h-full flex-1', segmentClass(n))} />
          ))}
        </div>
        <span className="sr-only">
          {`${rca.recordsSummary ?? rca.gap.headline}: ${records.map((r) => r.contribution.externalId).join(', ')}`}
        </span>
      </>
    )
  }
  return null
}
