import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router'
import type { CellRca } from '../../api/queries'
import type { components } from '../../api/schema'
import { INCIDENTS_SHOWN, RECORDS_SHOWN, REMAINDER_CLASS, REMAINDER_STYLE, segmentClass } from './GapBar'
import { durationText, safeHref, sourceLabel, timeRange } from './rcaText'

type RcaIncident = components['schemas']['RcaIncident']
type RcaRecord = components['schemas']['RcaRecord']

const LABEL = 'text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70'
const META = 'text-xs leading-4 text-ink/70'
const ROW = 'flex gap-2 border-t border-ink/10 py-2 first:border-t-0'

/** A ticket key: a link that opens in a new tab when its URL is https, else plain text. */
export function KeyLink({ k, url }: { k: string; url: string }) {
  const href = safeHref(url)
  if (!href) {
    return (
      <span data-key="" className="shrink-0 text-sm font-medium">
        {k}
      </span>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-accent-deep hover:underline"
    >
      <span data-key="">{k}</span>
      <ExternalLink aria-hidden="true" className="size-3" />{' '}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/** One line with the full title on hover in the popover; two lines in the sheet, where touch has no hover. */
function Title({ text, sheet }: { text: string; sheet: boolean }) {
  if (sheet) return <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm leading-5">{text}</span>
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="min-w-0 flex-1 truncate text-sm leading-5">{text}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-80 rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-lg"
          >
            {text}
            <Tooltip.Arrow width={10} height={5} className="fill-ink" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

function Swatch({ index, remainder = false }: { index: number; remainder?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('mt-1.5 size-2.5 shrink-0 rounded-sm', remainder ? REMAINDER_CLASS : segmentClass(index))}
      style={remainder ? REMAINDER_STYLE : undefined}
    />
  )
}

function IncidentRow({ incident, index, sheet, showSource }: { incident: RcaIncident; index: number; sheet: boolean; showSource: boolean }) {
  const meta = [incident.severity, timeRange(incident.startedAt, incident.endedAt), incident.countedDisplay].filter(Boolean).join(' · ')
  return (
    <li className={ROW}>
      <Swatch index={index} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <KeyLink k={incident.key} url={incident.url} />
            <Title text={incident.title} sheet={sheet} />
          </p>
          {incident.pointsDisplay && (
            <span data-points="" className="shrink-0 text-sm font-semibold leading-5 tabular-nums">
              {incident.pointsDisplay}
            </span>
          )}
        </div>
        {meta && <p className={META}>{meta}</p>}
        {incident.notes.map((n) => (
          <p key={n} className={META}>
            {n}
          </p>
        ))}
        {showSource && <p className="text-[11px] font-medium leading-4 text-ink/70">{sourceLabel(incident.source)}</p>}
      </div>
    </li>
  )
}

function RecordRow({ record, index, sheet }: { record: RcaRecord; index: number; sheet: boolean }) {
  const c = record.contribution
  const meta = [c.priority && c.priority !== 'none' ? c.priority : '', record.note].filter(Boolean).join(' · ')
  return (
    <li className={ROW}>
      <Swatch index={index} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <KeyLink k={c.externalId} url={c.url} />
            <Title text={c.title} sheet={sheet} />
          </p>
          {record.impactDisplay && (
            <span data-points="" className="shrink-0 text-sm font-semibold leading-5 tabular-nums">
              {record.impactDisplay}
            </span>
          )}
        </div>
        {meta && <p className={META}>{meta}</p>}
      </div>
    </li>
  )
}

/** `0.09 pts · 40m of the 7h 00m reported` → the points and the rest. */
function splitRemainder(display: string): { points: string; rest: string } {
  const at = display.indexOf(' · ')
  return at < 0 ? { points: '', rest: display } : { points: display.slice(0, at), rest: display.slice(at + 3) }
}

/** `Incidents add up to 0.20 pts (1h 30m), 15m more than the 1h 15m reported. …` (spec §5.6). */
export function excessSentence(rca: CellRca): string {
  const explained = rca.incidents.reduce((n, i) => n + i.countedMinutes, 0)
  const reported = rca.gap.reportedMinutes ?? Math.max(0, explained - (rca.excess?.minutes ?? 0))
  const points = rca.incidents.map((i) => Number.parseFloat(i.pointsDisplay))
  const sum =
    points.length > 0 && points.every((p) => Number.isFinite(p))
      ? `${points.reduce((a, b) => a + b, 0).toFixed(rca.gap.decimals ?? 2)} pts (${durationText(explained)})`
      : durationText(explained)
  return `Incidents add up to ${sum}, ${durationText(rca.excess?.minutes ?? 0)} more than the ${durationText(reported)} reported. The value is shown as reported; check the incident times or the reported downtime.`
}

/** `3 of 11 epics missed` → `Epics · 3 of 11 missed`. */
function recordsLabel(rca: CellRca): string {
  const m = /^(\d+) of (\d+) (.+) missed$/.exec(rca.recordsSummary ?? '')
  if (m) return `${m[3]![0]!.toUpperCase()}${m[3]!.slice(1)} · ${m[1]} of ${m[2]} missed`
  return rca.recordsSummary ? `Records · ${rca.recordsSummary}` : `Records · ${rca.recordsTotal}`
}

function More({ n }: { n: number }) {
  if (n <= 0) return null
  return <p className={clsx(META, 'pt-1')}>and {n} more</p>
}

/**
 * The evidence behind a gap (spec §10.2 item 5): incidents with the
 * remainder and any excess, or contributing records; plain text throughout.
 */
export function EvidenceList({ rca, sheet, isAdmin }: { rca: CellRca; sheet: boolean; isAdmin: boolean }) {
  const incidents = rca.incidents.slice(0, INCIDENTS_SHOWN)
  const records = rca.records.slice(0, RECORDS_SHOWN)
  const multiSource = new Set(incidents.map((i) => i.source)).size > 1
  const remainder = rca.unexplained ? splitRemainder(rca.unexplained.display) : null
  const nothingLinked = rca.gap.kind !== 'none' && rca.incidents.length === 0 && rca.records.length === 0 && rca.children.length === 0
  return (
    <>
      {nothingLinked && (
        <div className="mt-3 text-xs leading-4 text-ink/70">
          <p>No incidents or records are linked to this cell.</p>
          {isAdmin && (
            <Link to="/admin/record-types" className="mt-0.5 inline-block font-medium text-accent-deep hover:underline">
              Link incidents in Record types <span aria-hidden="true">›</span>
            </Link>
          )}
        </div>
      )}
      {(incidents.length > 0 || remainder) && (
        <section aria-label="Incidents" className="mt-3">
          <p className={LABEL}>Incidents · {rca.incidentsTotal}</p>
          <ul className="mt-1">
            {incidents.map((i, n) => (
              <IncidentRow key={`${i.source}:${i.externalId}`} incident={i} index={n} sheet={sheet} showSource={multiSource} />
            ))}
            {remainder && rca.unexplained && (
              <li className={ROW}>
                <Swatch index={0} remainder />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm leading-5">Not explained by any incident</p>
                    {remainder.points && (
                      <span data-points="" className="shrink-0 text-sm font-semibold leading-5 tabular-nums">
                        {remainder.points}
                      </span>
                    )}
                  </div>
                  <p className={META}>
                    {remainder.rest}
                    {rca.unexplained.withinTolerance && ' (within 1% of the reported downtime)'}
                  </p>
                </div>
              </li>
            )}
          </ul>
          <More n={rca.incidentsTotal - incidents.length} />
          {rca.excess && <p className="mt-1 border-l-2 border-ink/30 pl-2 text-xs leading-4 text-ink/80">{excessSentence(rca)}</p>}
        </section>
      )}
      {records.length > 0 && (
        <section aria-label="Records" className="mt-3">
          <p className={LABEL}>{recordsLabel(rca)}</p>
          {rca.typed && <p className={clsx(META, 'mt-1')}>This value was entered; the records below explain it but did not set it.</p>}
          <ul className="mt-1">
            {records.map((r, n) => (
              <RecordRow key={`${r.contribution.source}:${r.contribution.externalId}`} record={r} index={n} sheet={sheet} />
            ))}
          </ul>
          <More n={rca.recordsTotal - records.length} />
        </section>
      )}
    </>
  )
}
