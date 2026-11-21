import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { CellAttribution } from '../../api/queries'
import type { components } from '../../api/schema'
import { explainedMinutes, INCIDENTS_SHOWN, RECORDS_SHOWN, REMAINDER_CLASS, REMAINDER_STYLE, segmentClass } from './GapBar'
import { durationText, safeHref, sourceLabel, timeRange } from './rcaText'
import { useWhyCardAnnounce } from './WhyCardProvider'

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

/** `Incidents add up to 0.20 pts (1h 30m), 15m more than the 1h 15m reported. …` (spec §5.6), over every incident. */
export function excessSentence(a: CellAttribution): string {
  const excess = a.excess?.minutes ?? 0
  const explained = explainedMinutes(a) ?? a.incidents.reduce((n, i) => n + i.countedMinutes, 0)
  const reported = a.gap.reportedMinutes ?? Math.max(0, explained - excess)
  const points = a.excess ? splitRemainder(a.excess.display).points : ''
  const sum = points ? `${points} (${durationText(explained)})` : durationText(explained)
  return `Incidents add up to ${sum}, ${durationText(excess)} more than the ${durationText(reported)} reported. The value is shown as reported; check the incident times or the reported downtime.`
}

/** `3 of 11 epics missed` → the label `Epics · 3 of 11 missed` and the noun `epics`. */
function recordsNoun(a: CellAttribution): { label: string; noun: string } {
  const m = /^(\d+) of (\d+) (.+) missed$/.exec(a.recordsSummary ?? '')
  if (m) return { label: `${m[3]![0]!.toUpperCase()}${m[3]!.slice(1)} · ${m[1]} of ${m[2]} missed`, noun: m[3]! }
  return { label: a.recordsSummary ? `Records · ${a.recordsSummary}` : `Records · ${a.recordsTotal}`, noun: 'records' }
}

/** Calls `onVisible` when it scrolls into view: the end of what is loaded. */
function EndOfList({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(onVisible)
  useEffect(() => {
    latest.current = onVisible
  }, [onVisible])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return <div ref={ref} aria-hidden="true" data-testid="end-of-list" className="h-px" />
}

interface ShowAllProps {
  total: number
  loaded: number
  noun: string
  /** More of this list can be loaded from the server. */
  more: boolean
  loading: boolean
  onLoadMore: () => void
}

/**
 * `Show all {n} incidents` / `Show fewer` (spec §6.6, §10.7): expands the
 * list in place and keeps focus; once expanded, reaching the end of what
 * is loaded loads the next page, announced as `Loaded {n} more incidents`.
 */
function useShowAll({ total, loaded, noun, more, loading, onLoadMore }: ShowAllProps, shown: number) {
  const announce = useWhyCardAnnounce()
  const [open, setOpen] = useState(false)
  const seen = useRef(loaded)
  useEffect(() => {
    if (open && loaded > seen.current) announce(`Loaded ${loaded - seen.current} more ${noun}`)
    seen.current = loaded
  }, [open, loaded, noun, announce])
  const button =
    total > shown ? (
      <button
        type="button"
        aria-expanded={open}
        className="mt-1 h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
        onClick={() => {
          setOpen(!open)
          if (!open) announce(`Showing ${total} ${noun}`)
        }}
      >
        {open ? 'Show fewer' : `Show all ${total} ${noun}`}
      </button>
    ) : null
  const end = open && more && !loading ? <EndOfList onVisible={onLoadMore} /> : null
  return { open, button, end }
}

export interface EvidenceListProps {
  /** Every loaded page joined (`mergeAttribution`). */
  attribution: CellAttribution
  sheet: boolean
  isAdmin: boolean
  /** Which list the next page holds, if any. */
  next: 'incidents' | 'records' | null
  loadingMore: boolean
  onLoadMore: () => void
}

/**
 * The evidence behind a gap (spec §10.2): incidents with the remainder and
 * any excess, or contributing records; the first 5 incidents or 10 records,
 * then `Show all`. Plain text throughout.
 */
export function EvidenceList({ attribution: a, sheet, isAdmin, next, loadingMore, onLoadMore }: EvidenceListProps) {
  const records = recordsNoun(a)
  const incidentsAll = useShowAll(
    { total: a.incidentsTotal, loaded: a.incidents.length, noun: 'incidents', more: next === 'incidents', loading: loadingMore, onLoadMore },
    Math.min(a.incidents.length, INCIDENTS_SHOWN),
  )
  const recordsAll = useShowAll(
    { total: a.recordsTotal, loaded: a.records.length, noun: records.noun, more: next === 'records', loading: loadingMore, onLoadMore },
    Math.min(a.records.length, RECORDS_SHOWN),
  )
  const incidents = incidentsAll.open ? a.incidents : a.incidents.slice(0, INCIDENTS_SHOWN)
  const shownRecords = recordsAll.open ? a.records : a.records.slice(0, RECORDS_SHOWN)
  const multiSource = new Set(incidents.map((i) => i.source)).size > 1
  const remainder = a.unexplained ? splitRemainder(a.unexplained.display) : null
  const nothingLinked = a.gap.kind !== 'none' && a.incidentsTotal === 0 && a.recordsTotal === 0 && a.children.length === 0
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
        <section aria-label="Incidents" aria-busy={loadingMore && next === 'incidents'} className="mt-3">
          <p className={LABEL}>Incidents · {a.incidentsTotal}</p>
          <ul className="mt-1">
            {incidents.map((i, n) => (
              <IncidentRow key={`${i.source}:${i.externalId}`} incident={i} index={n} sheet={sheet} showSource={multiSource} />
            ))}
            {remainder && a.unexplained && (
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
                    {a.unexplained.withinTolerance && ' (within 1% of the reported downtime)'}
                  </p>
                </div>
              </li>
            )}
          </ul>
          {incidentsAll.end}
          {incidentsAll.button}
          {a.excess && <p className="mt-1 border-l-2 border-ink/30 pl-2 text-xs leading-4 text-ink/80">{excessSentence(a)}</p>}
        </section>
      )}
      {shownRecords.length > 0 && (
        <section aria-label="Records" aria-busy={loadingMore && next === 'records'} className="mt-3">
          <p className={LABEL}>{records.label}</p>
          {a.typed && <p className={clsx(META, 'mt-1')}>This value was entered; the records below explain it but did not set it.</p>}
          <ul className="mt-1">
            {shownRecords.map((r, n) => (
              <RecordRow key={`${r.contribution.source}:${r.contribution.externalId}`} record={r} index={n} sheet={sheet} />
            ))}
          </ul>
          {recordsAll.end}
          {recordsAll.button}
        </section>
      )}
    </>
  )
}
