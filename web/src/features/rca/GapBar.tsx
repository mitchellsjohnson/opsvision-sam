import clsx from 'clsx'
import type { CellAttribution } from '../../api/queries'
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

/** The card lists the first 5 incidents and 10 records, then `Show all`; the bar draws the first 5 and the rest as one segment. */
export const INCIDENTS_SHOWN = 5
export const RECORDS_SHOWN = 10

/** Minutes the incidents explain: the reported downtime less the remainder, or plus the excess. */
export function explainedMinutes(a: CellAttribution): number | null {
  const reported = a.gap.reportedMinutes
  if (reported === undefined || reported === null) return null
  return reported - (a.unexplained?.minutes ?? 0) + (a.excess?.minutes ?? 0)
}

/**
 * The incidents past the first 5, counted from the arithmetic rather than
 * from what is loaded, so the bar and its sentence cover every incident.
 */
function rest(a: CellAttribution): { count: number; minutes: number | null } {
  const shown = a.incidents.slice(0, INCIDENTS_SHOWN)
  const count = Math.max(0, a.incidentsTotal - shown.length)
  const explained = explainedMinutes(a)
  if (count === 0 || explained === null) return { count, minutes: null }
  return { count, minutes: Math.max(0, explained - shown.reduce((n, i) => n + i.countedMinutes, 0)) }
}

function sentence(a: CellAttribution, reported: number): string {
  const parts = a.incidents.slice(0, INCIDENTS_SHOWN).map((i) => `${i.key} ${i.countedDisplay}`)
  const more = rest(a)
  if (more.count > 0) {
    const noun = more.count === 1 ? 'incident' : 'incidents'
    parts.push(more.minutes === null ? `${more.count} more ${noun}` : `${more.count} more ${noun} ${durationText(more.minutes)}`)
  }
  if (a.unexplained) parts.push(`${durationText(a.unexplained.minutes)} not explained`)
  if (a.excess) parts.push(`${durationText(a.excess.minutes)} more than reported`)
  return `${durationText(reported)} down: ${parts.join(', ')}`
}

/**
 * The gap as one 8px bar (spec §10.2): a segment per listed incident in
 * evidence order, the rest of the incidents as one, the remainder hatched;
 * with an excess, the reported downtime fills the solid part and the excess
 * is a dashed outline past a tick. Records of a ratio split it evenly.
 * Hidden from assistive technology; its sentence is read instead.
 */
export function GapBar({ attribution: a }: { attribution: CellAttribution }) {
  const incidents = a.incidents.slice(0, INCIDENTS_SHOWN)
  if (a.gap.kind === 'downtime' && (incidents.length > 0 || a.unexplained)) {
    const more = rest(a)
    const parts: Part[] = incidents.map((i, n) => ({ key: `${i.source}:${i.externalId}`, minutes: i.countedMinutes, className: segmentClass(n) }))
    if (more.minutes) parts.push({ key: 'more', minutes: more.minutes, className: segmentClass(INCIDENTS_SHOWN) })
    const explained = explainedMinutes(a) ?? parts.reduce((n, p) => n + p.minutes, 0)
    if (a.unexplained) parts.push({ key: 'remainder', minutes: a.unexplained.minutes, className: REMAINDER_CLASS, remainder: true })
    const reported = a.gap.reportedMinutes ?? explained + (a.unexplained?.minutes ?? 0)
    const total = parts.reduce((n, p) => n + p.minutes, 0)
    const solid = a.excess && explained > 0 ? Math.min(100, (reported / explained) * 100) : 100
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
        <span className="sr-only">{sentence(a, reported)}</span>
      </>
    )
  }
  const records = a.records.slice(0, RECORDS_SHOWN)
  if (records.length > 0) {
    return (
      <>
        <div aria-hidden="true" data-testid="gap-bar" className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded">
          {records.map((r, n) => (
            <span key={`${r.contribution.source}:${r.contribution.externalId}`} className={clsx('h-full flex-1', segmentClass(n))} />
          ))}
        </div>
        <span className="sr-only">
          {`${a.recordsSummary ?? a.gap.headline}: ${records.map((r) => r.contribution.externalId).join(', ')}${
            a.recordsTotal > records.length ? ` and ${a.recordsTotal - records.length} more` : ''
          }`}
        </span>
      </>
    )
  }
  return null
}
