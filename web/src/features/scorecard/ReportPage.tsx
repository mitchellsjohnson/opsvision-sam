import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  keys,
  PublishBlockedError,
  useDraftReportSummary,
  useItems,
  useLayout,
  useMe,
  useMembers,
  useMetricSummaries,
  useOrgUnits,
  usePublishReport,
  usePutReportSummary,
  useReportDocument,
  useReportMonths,
  useReportSummary,
  useScorecards,
  useVersions,
  useView,
  type AssistantUsage,
  type MetricSummary,
  type MetricSummaryListQuery,
} from '../../api/queries'
import { LinkList } from '../rca/LinkList'
import { RCA_LINKS_SHOWN, safeHref } from '../rca/rcaText'
import { ApiError } from '../../api/errors'
import type { components } from '../../api/schema'
import { parsePeriod, periodLabel } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { menuItemHighlight } from '../../ui/focus'
import { Sam } from '../../ui/Sam'
import { CHIP_SIZE, HATCH, StatusChip, type StatusLevel } from '../../ui/status'
import { usageText } from '../assistant/usage'
import { inputClass, primaryButton, secondaryButton } from '../admin/formUi'
import { defaultStatusScale } from './charts/chartTheme'
import { downloadBlob } from './exports'
import { ReportStatusList, SpokenChip } from './report/ReportStatusList'
import {
  buildReportModel,
  dateLabel,
  metricFacts,
  metricValue,
  noteSections,
  reportFileName,
  reportStatusLine,
  type ReportMetric,
  type ReportModel,
  type ReportSummaries,
} from './report/model'
import { coarseGrains } from './logic/coarse'
import { scorecardViewRequest, subtreeSubjects, versionInForce } from './viewRequest'

type ReportSummary = components['schemas']['ReportSummary']
type ScorecardView = components['schemas']['ScorecardView']
type Frequency = components['schemas']['Frequency']

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
} as const

/** Tailwind's `sm`: below it is a phone. Without matchMedia, assume a wider screen. */
const SM_UP = '(min-width: 640px)'

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SM_UP)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !window.matchMedia(SM_UP).matches : false
}

const FREQUENCY_WORD: Partial<Record<Frequency, string>> = { quarterly: 'quarterly', biannual: 'twice-yearly', annual: 'yearly' }

/**
 * `2 quarterly or twice-yearly metrics are not counted in this revision: …`
 * (§14.5), naming the frequencies of the metrics left out.
 */
function notCountedText(names: string[], rows: ScorecardView['rows']): string {
  const present = new Set(names.map((n) => rows.find((r) => r.metricName === n)?.frequency))
  const words = (['quarterly', 'biannual', 'annual'] as const).filter((f) => present.has(f)).map((f) => FREQUENCY_WORD[f]!)
  const kind = words.length > 2 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words.join(' or ')
  const what = [String(names.length), kind, names.length === 1 ? 'metric is' : 'metrics are'].filter(Boolean).join(' ')
  const period = names.length === 1 ? 'its period was' : 'their periods were'
  return `${what} not counted in this revision: it was published before ${period} saved.`
}

const HEALTH_ITEM = 'flex min-w-0 items-center gap-1.5 rounded-lg border border-ink/20 bg-white px-2 py-1.5 text-sm sm:gap-2 sm:px-3'

const MENU_ITEM = clsx(menuItemHighlight, 'flex h-8 cursor-default items-center rounded-md px-2.5 text-sm')

/** Phones: one Download menu in place of the two buttons. */
function DownloadMenu({ disabled, onDownload }: { disabled: boolean; onDownload: (kind: 'pptx' | 'pdf') => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger disabled={disabled} className={clsx(secondaryButton, 'inline-flex items-center gap-1')}>
        Download
        <ChevronDown aria-hidden="true" className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-48 rounded-lg border border-ink/20 bg-white p-1 shadow-lg"
        >
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => onDownload('pptx')}>
            PowerPoint (.pptx)
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => onDownload('pdf')}>
            PDF
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Phones: `Use my layout` as a switch with a 32×18 track. */
function LayoutSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-8 items-center gap-2 rounded-md pr-1 text-sm font-medium disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        className={clsx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-ink/55')}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white transition-transform',
            checked && 'translate-x-3.5',
          )}
        />
      </span>
      Use my layout
    </button>
  )
}

interface SummaryEditorProps {
  scorecardId: string
  period: string
  /** The summary as loaded when the editor opened; later refetches do not change what it saves against. */
  summary: ReportSummary
  /** Refetches the stored summary; undefined when that fails. */
  reload: () => Promise<ReportSummary | undefined>
  onDirtyChange: (dirty: boolean) => void
}

function SummaryEditor({ scorecardId, period, summary, reload, onDirtyChange }: SummaryEditorProps) {
  const id = useId()
  const [draft, setDraft] = useState({ text: summary.text, baseRevision: summary.revision, savedText: summary.text })
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [reloadFailed, setReloadFailed] = useState(false)
  const put = usePutReportSummary(scorecardId, period)
  const drafting = useDraftReportSummary(scorecardId, period)
  /** Set while the text box holds SAM's draft: the text it replaced, and what the draft cost. */
  const [fromSam, setFromSam] = useState<{ before: string; usage?: AssistantUsage } | null>(null)
  const abortDraft = useRef<AbortController | null>(null)
  const noteId = useId()
  const dirty = draft.text !== draft.savedText

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => () => abortDraft.current?.abort(), [])

  const draftWithSam = () => {
    abortDraft.current?.abort()
    const controller = new AbortController()
    abortDraft.current = controller
    const before = fromSam?.before ?? draft.text
    drafting.mutate(
      { signal: controller.signal },
      {
        onSuccess: (d) => {
          if (d.text === undefined) return
          const text = d.text
          setDraft((cur) => ({ ...cur, text }))
          setFromSam({ before, usage: d.usage })
          setSaved(false)
        },
      },
    )
  }
  const discardDraft = () => {
    if (!fromSam) return
    const text = fromSam.before
    setDraft((cur) => ({ ...cur, text }))
    setFromSam(null)
  }
  const draftError = drafting.isError ? drafting.error.message : drafting.data?.error

  const save = () => {
    const text = draft.text
    put.mutate(
      { text, expectedRevision: draft.baseRevision },
      {
        onSuccess: (data) => {
          setDraft((d) => ({ ...d, baseRevision: data.revision, savedText: data.text }))
          setSaved(true)
          setConflict(false)
          setFromSam(null)
        },
        onError: (e) => setConflict(e instanceof ApiError && e.status === 409),
      },
    )
  }

  const reloadSummary = async () => {
    const fresh = await reload()
    if (!fresh) {
      setReloadFailed(true)
      return
    }
    setDraft({ text: fresh.text, baseRevision: fresh.revision, savedText: fresh.text })
    setFromSam(null)
    setConflict(false)
    setReloadFailed(false)
    setSaved(false)
    put.reset()
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label htmlFor={id} className="block text-sm font-medium">
          Summary
        </label>
        <button
          type="button"
          className={clsx(secondaryButton, 'inline-flex items-center gap-1.5')}
          disabled={drafting.isPending}
          onClick={draftWithSam}
        >
          <Sam pose={drafting.isPending ? 'thinking' : 'mark'} className={clsx('size-5', drafting.isPending && 'ov-sam-think')} />
          {drafting.isPending ? 'Drafting…' : 'Draft with SAM'}
        </button>
      </div>
      {fromSam && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber bg-cream px-3 py-2 text-sm">
          <p id={noteId} className="font-medium">
            Draft from SAM — review before saving
          </p>
          {fromSam.usage && <p className="text-xs text-ink/70">{usageText(fromSam.usage)}</p>}
          <button type="button" className="ml-auto text-sm font-medium text-accent-deep underline" onClick={discardDraft}>
            Discard draft
          </button>
        </div>
      )}
      <textarea
        id={id}
        rows={fromSam ? 8 : 4}
        maxLength={8000}
        className={inputClass}
        value={draft.text}
        readOnly={drafting.isPending}
        aria-describedby={fromSam ? noteId : undefined}
        onChange={(e) => {
          const text = e.target.value
          setDraft((d) => ({ ...d, text }))
          setSaved(false)
        }}
      />
      {drafting.isPending && (
        <p role="status" className="mt-2 text-sm text-ink/80">
          SAM is drafting the summary…
        </p>
      )}
      {draftError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          {draftError}
          {draftError.includes('My settings') && (
            <>
              {' '}
              <Link to="/settings/ask-sam" className="font-medium text-accent-deep underline">
                Open Ask SAM settings
              </Link>
            </>
          )}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryButton} disabled={put.isPending} onClick={save}>
          Save summary
        </button>
        {saved && !dirty && (
          <p role="status" className="text-sm text-ink/80">
            Summary saved.
          </p>
        )}
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-status-r">
            <span>This summary changed since you opened it.</span>
            <button type="button" className={secondaryButton} onClick={() => void reloadSummary()}>
              Reload
            </button>
            {reloadFailed && <span>Could not reload the summary; try again.</span>}
          </div>
        ) : (
          put.isError && (
            <p role="alert" className="text-sm text-status-r">
              Could not save the summary: {put.error.message}
            </p>
          )
        )}
      </div>
    </div>
  )
}

/** Where an admin writes a metric's exec summary: its card, opened from the Exec summaries view. */
function writeHref(scorecardId: string, period: string, metricKey: string): string {
  return `/scorecards/${scorecardId}/exec-summaries?${new URLSearchParams({ period, why: metricKey })}`
}

/** `Write ›`, named for the metric. */
function WriteLink({ to, metricName, className }: { to: string; metricName: string; className?: string }) {
  return (
    <Link to={to} className={clsx('font-medium text-accent-deep hover:underline', className)}>
      Write <span className="sr-only">exec summary for {metricName}</span> <span aria-hidden="true">›</span>
    </Link>
  )
}

/** The metric's exec summary after its facts (spec §10.8): text, byline, links, then the attribution line. */
function MetricSummaryBlock({ metric, writeTo, isAdmin }: { metric: ReportMetric; writeTo: string; isAdmin: boolean }) {
  const labelId = useId()
  const [allLinks, setAllLinks] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const s = metric.summary
  if (!s || (s.state === 'optional' && !s.neededFor)) return null
  const links = allLinks ? s.links : s.links.slice(0, RCA_LINKS_SHOWN)
  return (
    <div className="mt-3 border-t border-ink/10 pt-3">
      <div role="group" aria-labelledby={labelId}>
        <p id={labelId} className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">
          Exec summary
        </p>
        {s.state === 'missing' ? (
          <p className="mt-1 text-xs font-semibold leading-4 text-status-r">Exec summary needed</p>
        ) : s.state === 'optional' ? (
          <p className="mt-1 text-xs font-semibold leading-4 text-ink/80">{`Needed for ${s.neededFor}`}</p>
        ) : (
          <>
            {s.editedSincePublication && <p className="mt-1 text-[11px] leading-4 text-ink/70">Exec summary edited since publication</p>}
            <p dir="auto" className="mt-1 text-sm leading-5 break-words">
              {s.text}
            </p>
            {(s.author || s.date) && (
              <p className="mt-0.5 text-[11px] leading-4 text-ink/70">{[s.author, s.date].filter(Boolean).join(' · ')}</p>
            )}
            <LinkList links={links} />
            {s.links.length > RCA_LINKS_SHOWN && (
              <button
                ref={toggleRef}
                type="button"
                aria-expanded={allLinks}
                className="-mx-1 mt-1 min-h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
                onClick={() => {
                  setAllLinks((v) => !v)
                  requestAnimationFrame(() => toggleRef.current?.focus())
                }}
              >
                {allLinks ? 'Show fewer' : `Show all ${s.linksTotal} links`}
              </button>
            )}
          </>
        )}
        {s.state === 'missing' && isAdmin && <WriteLink to={writeTo} metricName={metric.name} className="text-xs" />}
      </div>
      {s.attributionLine && (
        <p data-testid="summary-attribution" className="mt-2 text-xs leading-4 text-ink/70 break-words">
          <span className="sr-only">Attribution: </span>
          {metric.summary?.evidence.length ? <EvidenceLine summary={s} /> : s.attributionLine}
        </p>
      )}
    </div>
  )
}

/** The attribution line with each evidence key linked (`safeHref`), else as text. */
function EvidenceLine({ summary }: { summary: NonNullable<ReportMetric['summary']> }) {
  const line = summary.attributionLine ?? ''
  const cut = summary.evidence.length > 0 ? line.lastIndexOf(`: ${summary.evidence[0]!.key}`) : -1
  const headline = cut > 0 ? line.slice(0, cut) : ''
  return (
    <>
      {headline && `${headline}: `}
      {summary.evidence.map((e, i) => {
        const href = safeHref(e.url)
        return (
          <span key={`${e.key}:${i}`}>
            {i > 0 && ' · '}
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-deep hover:underline">
                {e.key}
              </a>
            ) : (
              e.key
            )}
            {e.pointsDisplay && ` ${e.pointsDisplay}`}
          </span>
        )
      })}
    </>
  )
}

function MetricBlock({ metric, scale, writeTo, isAdmin }: { metric: ReportMetric; scale: StatusLevel[]; writeTo: string; isAdmin: boolean }) {
  const id = useId()
  return (
    <article aria-labelledby={id} className="h-full rounded-lg border border-ink/20 bg-white p-4">
      <h3 id={id} className="text-base font-semibold">
        {metric.name}
      </h3>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        {metric.status && <SpokenChip status={metric.status} scale={scale} size="lg" />}
        <span className="text-2xl font-semibold tabular-nums">{metricValue(metric) || '—'}</span>
      </p>
      <ul className="mt-2 space-y-0.5 text-sm text-ink/80">
        {metricFacts(metric).map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <MetricSummaryBlock metric={metric} writeTo={writeTo} isAdmin={isAdmin} />
    </article>
  )
}

/** Notes → Exec summaries: every summary of the month, worst first; a missing one says so. */
function ExecSummaryNotes({ model }: { model: ReportModel }) {
  if (model.execSummaries.length === 0) return null
  return (
    <div className="mt-3">
      <h3 className="text-sm font-semibold">Exec summaries</h3>
      <ul className="mt-1 list-disc pl-5 text-sm text-ink/80">
        {model.execSummaries.map((n) => (
          <li key={n.key} className="break-words">
            <span className="font-medium text-ink">{`${n.name} · ${[n.display, n.statusLabel].filter(Boolean).join(' ')}`}</span>
            {': '}
            {n.text === null ? (
              <span className="font-semibold text-status-r">Exec summary needed</span>
            ) : (
              <span dir="auto">
                {n.text}
                {n.keys.length > 0 && ` (${n.keys.join(', ')})`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** `3 exec summaries needed before Oct 2026 can be published`, or for one, `1 exec summary needed …`. */
function neededHeading(n: number, month: string): string {
  return `${n} exec ${n === 1 ? 'summary' : 'summaries'} needed before ${month} can be published`
}

/** `1 exec summary may be out of date: Spend vs plan. Publishing is allowed.` */
function staleLine(names: string[]): string {
  const n = names.length
  return `${n} exec ${n === 1 ? 'summary may' : 'summaries may'} be out of date: ${names.join(', ')}. Publishing is allowed.`
}

interface RequiredBlockProps {
  missing: MetricSummary[]
  /** Names of the stale summaries, which do not block. */
  stale: string[]
  monthLabel: string
  scorecardId: string
  period: string
  isAdmin: boolean
  scale: StatusLevel[]
  headingId: string
  headingRef: RefObject<HTMLHeadingElement | null>
}

/** The live report's list of required exec summaries not yet written (spec §10.8), shown to everyone. */
function RequiredBlock({ missing, stale, monthLabel, scorecardId, period, isAdmin, scale, headingId, headingRef }: RequiredBlockProps) {
  return (
    <section aria-labelledby={headingId} className="mt-4 rounded-lg border border-status-r/40 bg-status-r-bg p-4">
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-ink">
        {neededHeading(missing.length, monthLabel)}
      </h2>
      <ul className="mt-2 divide-y divide-status-r/20">
        {missing.map((s) => (
          <li key={s.metricKey} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-sm">
            <Link to={writeHref(scorecardId, period, s.metricKey)} className="font-medium text-accent-deep hover:underline">
              {s.metricName}
            </Link>
            {s.standing.display && <span className="font-semibold tabular-nums">{s.standing.display}</span>}
            {s.standing.status && <SpokenChip status={s.standing.status} scale={scale} />}
            {s.requirementReason && <span className="text-xs text-ink/80">{s.requirementReason}</span>}
            {isAdmin && <WriteLink to={writeHref(scorecardId, period, s.metricKey)} metricName={s.metricName} className="ml-auto text-sm" />}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm">
        <Link
          to={`/scorecards/${scorecardId}/exec-summaries?${new URLSearchParams({ period })}`}
          className="font-medium text-accent-deep hover:underline"
        >
          View all exec summaries ›
        </Link>
        {stale.length > 0 && (
          <span className="text-xs text-ink/70">
            {` · ${stale.length} written ${stale.length === 1 ? 'summary' : 'summaries'} may be out of date (${stale.join(', ')}); that does not block publishing.`}
          </span>
        )}
      </p>
    </section>
  )
}

interface ReportBodyProps {
  model: ReportModel
  scorecardName: string
  scale: StatusLevel[]
  /** Under 640px the table is the status list. */
  phone: boolean
  /** The view the report counts from, at its scope (see `ReportStatusList`). */
  counted: ScorecardView
  fiscalYearStartMonth: number
  scorecardId: string
  isAdmin: boolean
}

function ReportBody({ model, scorecardName, scale, phone, counted, fiscalYearStartMonth, scorecardId, isAdmin }: ReportBodyProps) {
  const writeTo = (key: string) => writeHref(scorecardId, model.period, key)
  const first = model.columns[0]?.fullLabel ?? ''
  const last = model.columns.filter((c) => !c.ytd).at(-1)?.fullLabel ?? ''
  return (
    <>
      <section aria-labelledby="report-needs" className="pt-8">
        <h2 id="report-needs" className="text-lg font-semibold text-accent-deep">
          Needs attention
        </h2>
        {model.needsAttention.length === 0 ? (
          <p className="mt-2 text-sm text-ink/80">Nothing needs attention this month.</p>
        ) : (
          <ul className="mt-3 grid gap-4 lg:grid-cols-3">
            {model.needsAttention.map((m) => (
              <li key={m.key}>
                <MetricBlock metric={m} scale={scale} writeTo={writeTo(m.key)} isAdmin={isAdmin} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {model.categories.map((c) => (
        <section key={c.id} aria-labelledby={`report-cat-${c.id}`} className="pt-8">
          <h2 id={`report-cat-${c.id}`} className="text-lg font-semibold text-accent-deep">
            {c.name}
          </h2>
          <ul className="mt-3 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
            {c.metrics.map((m) => (
              <li key={m.key}>
                <MetricBlock metric={m} scale={scale} writeTo={writeTo(m.key)} isAdmin={isAdmin} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="report-table" className="pt-8">
        <h2 id="report-table" className="text-lg font-semibold text-accent-deep">
          Scorecard table
        </h2>
        {phone ? (
          <ReportStatusList model={model} scale={scale} counted={counted} fiscalYearStartMonth={fiscalYearStartMonth} />
        ) : (
          <table className="mt-3 w-full table-fixed border-separate border-spacing-0 rounded-lg bg-white text-sm">
            <caption className="px-3 py-2 text-left text-sm font-medium">
              {`${scorecardName}, ${first} – ${last}, with year to date, ${model.scopeLabel}`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-[clamp(10rem,28%,18rem)] border-b border-ink/30 px-3 py-2 text-left font-semibold">
                  Metric
                </th>
                {model.columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.fullLabel}
                    className={
                      c.ytd
                        ? 'border-b border-l-2 border-ink/30 px-2 py-2 text-right font-semibold'
                        : 'border-b border-ink/30 px-2 py-2 text-right font-semibold'
                    }
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.table.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="border-b border-ink/10 px-3 py-1.5 text-left font-medium">
                    {r.name}
                  </th>
                  {r.cells.map((cell, i) => (
                    <td
                      key={model.columns[i]!.key}
                      className={
                        model.columns[i]!.ytd
                          ? 'border-b border-l-2 border-ink/10 border-l-ink/30 px-2 py-1.5 text-right tabular-nums'
                          : 'border-b border-ink/10 px-2 py-1.5 text-right tabular-nums'
                      }
                    >
                      <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                        {cell.naReason ? (
                          <span role="img" aria-label={`n/a: ${cell.naReason}`} className="rounded bg-status-na-bg px-1.5 text-xs text-ink">
                            n/a
                          </span>
                        ) : (
                          <span>{cell.display || '—'}</span>
                        )}
                        {cell.status && <SpokenChip status={cell.status} scale={scale} />}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="report-notes" className="pt-8">
        <h2 id="report-notes" className="text-lg font-semibold text-accent-deep">
          Notes
        </h2>
        <ExecSummaryNotes model={model} />
        {noteSections(model).map((s) => (
          <div key={s.heading} className="mt-3">
            <h3 className="text-sm font-semibold">{s.heading}</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink/80">
              {s.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  )
}

/** The monthly operating report: preview, summary, publish, and PPTX and PDF downloads. */
export function ReportPage() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const [period] = usePeriodState()
  const me = useMe()
  const scorecards = useScorecards()
  const orgUnits = useOrgUnits()
  const companyScope = period.scope === ''
  const items = useItems({ enabled: !companyScope })
  const isAdmin = me.data?.role === 'admin'
  const fy = period.fiscalYearStartMonth
  const parsed = parsePeriod(period.period)
  const isMonth = parsed?.grain === 'month'
  const revision = params.get('revision') === 'live' ? 'live' : ''
  const months = useReportMonths(isMonth ? scorecardId : undefined)
  const doc = useReportDocument(isMonth && period.ready ? scorecardId : undefined, period.period, revision)
  const summary = useReportSummary(scorecardId, period.period, isAdmin && isMonth && companyScope)
  const members = useMembers({ enabled: isAdmin })
  const layout = useLayout(scorecardId)
  const publish = usePublishReport(scorecardId, period.period)
  const [useMyLayout, setUseMyLayout] = useState(false)
  const [exporting, setExporting] = useState<'' | 'pptx' | 'pdf'>('')
  const [exportError, setExportError] = useState('')
  const [summaryDirty, setSummaryDirty] = useState(false)
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const warningId = useId()
  const unsavedId = useId()
  const requiredId = useId()
  const gateLineId = useId()
  const requiredHeadingRef = useRef<HTMLHeadingElement>(null)
  const queryClient = useQueryClient()
  /** The 409's missing summaries, for the month and revision refused, and when the list was last read as it came back. */
  const [blocked, setBlocked] = useState<{ key: string; missing: MetricSummary[]; at: number } | null>(null)
  const refetchSummary = summary.refetch
  const reloadSummary = useCallback(async () => {
    const result = await refetchSummary()
    return result.isError ? undefined : result.data
  }, [refetchSummary])

  // The scope's subtree is needed to filter the report; without it the report would show the wrong rows.
  const scopeLoading = !companyScope && (orgUnits.isPending || items.isPending)
  const scopeError = companyScope ? null : (orgUnits.error ?? items.error)

  const scale = me.data?.tenant?.statusScale?.length ? me.data.tenant.statusScale : defaultStatusScale()
  const companyName = me.data?.tenant?.name ?? 'Company'
  const scorecardName = scorecards.data?.scorecards.find((s) => s.id === sc)?.name ?? 'Scorecard'
  const scopeName = orgUnits.data?.units.find((u) => u.id === period.scope)?.name ?? 'Selected unit'
  const scopeSubjects = useMemo(
    () => (companyScope ? [] : subtreeSubjects([period.scope], { units: orgUnits.data?.units, items: items.data })),
    [companyScope, period.scope, orgUnits.data?.units, items.data],
  )

  const monthEntry = months.data?.months.find((m) => m.period === period.period)
  /** A name only for an admin who can read the members list and finds the publisher there. */
  const publisherName = (id: string | null | undefined) =>
    isAdmin && id ? members.data?.find((m) => m.userId === id)?.name || undefined : undefined
  const sameRevision = doc.data !== undefined && monthEntry?.status === 'published' && monthEntry.revision === doc.data.revision
  const statusLine = doc.data
    ? reportStatusLine({
        live: doc.data.live,
        period: period.period,
        today: new Date(),
        fiscalYearStartMonth: fy,
        publishedAt: sameRevision ? monthEntry?.publishedAt : doc.data.generatedAt,
        publisherName: sameRevision ? publisherName(monthEntry?.publishedBy) : undefined,
      })
    : ''

  // A live report counts each metric from the Overview's own request (its trend window and coarse periods), so
  // the two agree; a published report counts from its snapshot.
  const versions = useVersions(isMonth ? scorecardId : undefined)
  const live = doc.data?.live === true
  const overviewRequest = useMemo(() => {
    const version = versionInForce(versions.data?.versions ?? [], period.period, '')
    const coarse = version ? coarseGrains(version.content.metrics.map((m) => m.frequency), 'month') : []
    return scorecardViewRequest(
      { period: period.period, ytd: false, subjects: [], scope: period.scope, restate: '', structure: 'as_of', fiscalYearStartMonth: fy },
      { units: orgUnits.data?.units, items: items.data },
      { coarse },
    )
  }, [versions.data?.versions, period.period, period.scope, fy, orgUnits.data?.units, items.data])
  const overview = useView(isMonth && live && !versions.isPending && !scopeLoading ? scorecardId : undefined, overviewRequest)
  const overviewSettled = !live || (!versions.isPending && !overview.isPending)

  // Exec summaries are not in the report document: a live month reads them now, a published one its frozen copies
  // (with today's, to flag edits since), whole and in pages of 16.
  const publishedRevision = doc.data && !doc.data.live ? doc.data.revision : undefined
  const summariesQuery: MetricSummaryListQuery = {
    period: isMonth && doc.data ? period.period : '',
    state: 'all',
    full: true,
    ...(publishedRevision !== undefined ? { revision: publishedRevision } : {}),
  }
  const summaryList = useMetricSummaries(scorecardId, summariesQuery)
  const currentQuery: MetricSummaryListQuery = { period: publishedRevision !== undefined ? period.period : '', state: 'all' }
  const currentList = useMetricSummaries(scorecardId, currentQuery)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = summaryList
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const { hasNextPage: currentMore, isFetchingNextPage: currentFetching, fetchNextPage: fetchCurrent } = currentList
  useEffect(() => {
    if (currentMore && !currentFetching) void fetchCurrent()
  }, [currentMore, currentFetching, fetchCurrent])
  const summaries = useMemo<ReportSummaries | null>(() => {
    const pages = summaryList.data?.pages
    if (!pages || hasNextPage) return null
    const items = pages.flatMap((p) => p.items)
    if (publishedRevision === undefined) return { source: 'live', items }
    const counts = pages[0]!.counts
    // A revision published before the gate froze no summaries: no rows and nothing counted.
    if (items.length === 0 && counts.required === 0 && counts.written === 0) return { source: 'before', items }
    return { source: 'published', items, current: currentList.data?.pages.flatMap((p) => p.items) }
  }, [summaryList.data, hasNextPage, publishedRevision, currentList.data])

  const layoutItems = useMemo(() => (useMyLayout ? (layout.data?.items ?? []) : null), [useMyLayout, layout.data?.items])
  const model = useMemo(
    () =>
      doc.data && !scopeLoading && !scopeError && overviewSettled
        ? buildReportModel({
            doc: doc.data,
            scorecardName,
            companyName,
            scope: period.scope,
            scopeName,
            scopeSubjects,
            period: period.period,
            fiscalYearStartMonth: fy,
            scale,
            layout: layoutItems,
            statusLine,
            overview: live ? (overview.data ?? null) : null,
            versions: versions.data?.versions,
            summaries,
          })
        : null,
    [
      doc.data,
      scopeLoading,
      scopeError,
      overviewSettled,
      scorecardName,
      companyName,
      period.scope,
      scopeName,
      scopeSubjects,
      period.period,
      fy,
      scale,
      layoutItems,
      statusLine,
      live,
      overview.data,
      versions.data?.versions,
      summaries,
    ],
  )
  // What the model counted from, at the scope: the status list draws a coarse metric's periods from it.
  const counted = useMemo(() => {
    if (!doc.data) return null
    const source = doc.data.standing ?? (live ? overview.data : undefined) ?? doc.data.view
    if (companyScope) return source
    const inScope = new Set(scopeSubjects)
    return { ...source, rows: source.rows.filter((r) => inScope.has(r.subjectId)) }
  }, [doc.data, live, overview.data, companyScope, scopeSubjects])

  const search = (patch: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    patch(next)
    const s = next.toString()
    return s ? `?${s}` : ''
  }
  const reportPath = `/scorecards/${scorecardId}/report`
  const liveSearch = search((n) => n.set('revision', 'live'))
  const setRevision = (live: boolean) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (live) next.set('revision', 'live')
      else next.delete('revision')
      return next
    })

  const download = async (kind: 'pptx' | 'pdf') => {
    if (!model) return
    setExporting(kind)
    setExportError('')
    try {
      const bytes =
        kind === 'pptx'
          ? await (await import('./report/pptx')).buildPptx(model)
          : await (await import('./report/pdf')).buildPdf(model)
      downloadBlob(reportFileName(model, kind), MIME[kind], new Blob([bytes.slice()], { type: MIME[kind] }))
    } catch (e) {
      setExportError(`Could not build the ${kind.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting('')
    }
  }

  // Publishing (and republishing from a published revision) is gated by the live month: the live report's own
  // list, or beside a published revision the live list read with it.
  const gateKey = `${period.period}|${publishedRevision ?? 'live'}`
  const gateQuery = publishedRevision === undefined ? summariesQuery : currentQuery
  const gateList = publishedRevision === undefined ? summaryList : currentList
  const currentItems = useMemo(() => currentList.data?.pages.flatMap((p) => p.items) ?? [], [currentList.data])
  const liveMissing = live ? (model?.summariesMissing ?? []) : currentItems.filter((s) => s.state === 'missing')
  const liveStale = live ? (model?.summariesStaleNames ?? []) : currentItems.filter((s) => s.state === 'stale').map((s) => s.metricName)
  // A refused publish's own list stands for its month and revision until the summaries are read again.
  if (blocked && blocked.key !== gateKey) setBlocked(null)
  const refused = blocked && blocked.key === gateKey && gateList.dataUpdatedAt <= blocked.at ? blocked.missing : null
  const missing = refused ?? liveMissing
  const gated = missing.length > 0
  useEffect(() => {
    if (blocked) requiredHeadingRef.current?.focus()
  }, [blocked])
  const resetPublish = publish.reset
  useEffect(() => resetPublish(), [gateKey, resetPublish])

  const controlsDisabled = !isMonth || !model
  const publishDisabled = !isMonth || !model || publish.isPending || summaryDirty
  const runPublish = () => {
    if (gated) return
    publish.mutate(undefined, {
      onSuccess: () => setRevision(false),
      onError: (e) => {
        if (!(e instanceof PublishBlockedError)) return
        // The hook has already re-read the list; this list stands until it is read again.
        const at = queryClient.getQueryState(keys.metricSummaries(scorecardId, gateQuery))?.dataUpdatedAt ?? 0
        setBlocked({ key: gateKey, missing: e.missing, at })
      },
    })
  }
  const publishButton = (
    <button
      type="button"
      className={clsx(primaryButton, gated && 'cursor-not-allowed opacity-60 hover:bg-accent')}
      disabled={publishDisabled}
      aria-disabled={gated ? true : undefined}
      aria-describedby={
        isMonth ? [gated ? `${requiredId} ${gateLineId}` : '', warningId, summaryDirty ? unsavedId : ''].join(' ').trim() : undefined
      }
      onClick={runPublish}
    >
      Publish
    </button>
  )
  const gateLine = gated && isAdmin && (
    <span id={gateLineId} className="text-xs leading-4 text-status-r">
      {`Publishing needs ${missing.length} more exec ${missing.length === 1 ? 'summary' : 'summaries'}.`}
    </span>
  )
  const subtitle = [scorecardName, parsed ? periodLabel(parsed, fy) : period.period, companyScope ? `All of ${companyName}` : scopeName]

  return (
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold text-accent-deep">Report</h1>
      <p className="mt-1 text-sm text-ink/80">{subtitle.join(' · ')}</p>
      {isMonth && statusLine && <p className="mt-1 text-sm font-medium">{statusLine}</p>}

      <div role="toolbar" aria-label="Report controls" className="mt-3 flex flex-wrap items-center gap-2">
        {phone && isAdmin && publishButton}
        {phone && <DownloadMenu disabled={controlsDisabled || exporting !== ''} onDownload={(kind) => void download(kind)} />}
        {phone && gateLine && <div className="basis-full">{gateLine}</div>}
        {doc.data && !doc.data.live && (
          <button type="button" className={secondaryButton} onClick={() => setRevision(true)}>
            View live
          </button>
        )}
        {revision === 'live' && monthEntry?.status === 'published' && (
          <button type="button" className={secondaryButton} onClick={() => setRevision(false)}>
            View published
          </button>
        )}
        {phone ? (
          <div className="basis-full">
            <LayoutSwitch checked={useMyLayout} disabled={!isMonth} onChange={setUseMyLayout} />
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 px-1 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                disabled={!isMonth}
                checked={useMyLayout}
                onChange={(e) => setUseMyLayout(e.target.checked)}
              />
              Use my layout
            </label>
            <button type="button" className={secondaryButton} disabled={controlsDisabled || exporting !== ''} onClick={() => void download('pptx')}>
              Download PPTX
            </button>
            <button type="button" className={secondaryButton} disabled={controlsDisabled || exporting !== ''} onClick={() => void download('pdf')}>
              Download PDF
            </button>
          </>
        )}
        {isAdmin && (
          <>
            {!phone && publishButton}
            {!phone && gateLine}
            {isMonth && (
              <span id={warningId} className="rounded-md border border-amber bg-cream px-2 py-1 text-sm">
                This month is not locked.
              </span>
            )}
            {isMonth && summaryDirty && (
              <span id={unsavedId} className="rounded-md border border-amber bg-cream px-2 py-1 text-sm">
                You have unsaved summary changes. Save before publishing.
              </span>
            )}
          </>
        )}
      </div>

      {!isMonth && <p className="mt-3 text-sm">The monthly report is available on a month.</p>}
      {isMonth && scopeError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          Could not load the units and items in this scope: {scopeError.message}
        </p>
      )}
      {exporting && (
        <p role="status" className="mt-2 text-sm text-ink/80">
          Building the {exporting.toUpperCase()}…
        </p>
      )}
      {exportError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          {exportError}
        </p>
      )}
      {publish.isError && !(publish.error instanceof PublishBlockedError && isMonth && gated && model) && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          Could not publish: {publish.error.message}
        </p>
      )}
      {isMonth && gated && model && (
        <RequiredBlock
          missing={missing}
          stale={liveStale}
          monthLabel={model.monthLabel}
          scorecardId={scorecardId}
          period={period.period}
          isAdmin={isAdmin}
          scale={scale}
          headingId={requiredId}
          headingRef={requiredHeadingRef}
        />
      )}
      {isMonth && live && !gated && model && model.summariesStaleNames.length > 0 && (
        <p className="mt-3 text-xs leading-4 text-ink/70">{staleLine(model.summariesStaleNames)}</p>
      )}
      {isMonth && model?.summariesBefore && (
        <p className="mt-3 text-sm text-ink/80">This revision was published before exec summaries were required.</p>
      )}
      {isMonth && (period.restate !== '' || period.structure === 'current') && (
        <p className="mt-2 text-sm text-ink/80">
          View options do not apply to the report: it uses the methodology and structure in force each month.
        </p>
      )}

      {isMonth && doc.data?.dataRevised && (
        <section aria-label="Data revised since publication" className="mt-3 rounded-md border border-amber bg-cream p-3 text-sm">
          <p className="font-semibold">Data revised since publication</p>
          <Link to={{ pathname: reportPath, search: liveSearch }} className="font-medium text-accent-deep underline">
            View the live report
          </Link>
          <ul className="mt-2 list-disc pl-5 break-words">
            {doc.data.changes.map((c) => {
              const row = doc.data.view.rows.find((r) => r.metricKey === c.metricKey && r.subjectId === c.subjectId)
              const p = parsePeriod(c.period)
              return (
                <li key={`${c.metricKey}/${c.subjectId}/${c.period}`}>
                  {`${row?.metricName ?? c.metricKey}, ${row?.subjectName ?? c.subjectId}, ${p ? periodLabel(p, fy) : c.period}: ${c.was || 'blank'} → ${c.now || 'blank'}`}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {isMonth && (doc.isPending || (scopeLoading && !scopeError)) && (
        <p role="status" aria-busy="true" className="mt-4">
          Loading report…
        </p>
      )}
      {isMonth && doc.isError && (
        <div role="alert" className="mt-4 rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
          Could not load the report: {doc.error.message}
        </div>
      )}

      {isMonth && model && (
        <>
          <section aria-labelledby="report-summary" className="pt-6">
            <h2 id="report-summary" className="text-lg font-semibold text-accent-deep">
              Summary
            </h2>
            <ul aria-label="Health this month" className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {model.health.map((h) => (
                <li key={h.key} className={HEALTH_ITEM}>
                  <span aria-hidden="true" className="inline-flex">
                    <StatusChip status={h.key} scale={scale} size="lg" />
                  </span>
                  <span className="text-base font-semibold tabular-nums">{h.count}</span>{' '}
                  <span className="min-w-0">{h.label}</span>
                </li>
              ))}
              {model.notReported > 0 && (
                <li className={HEALTH_ITEM}>
                  <span aria-hidden="true" className={clsx(CHIP_SIZE.lg, 'border-ink/15 bg-white')} style={HATCH} />
                  <span className="text-base font-semibold tabular-nums">{model.notReported}</span>{' '}
                  <span className="min-w-0">Not reported</span>
                </li>
              )}
            </ul>
            {model.notCounted.names.length > 0 && (
              <p className="mt-2 text-xs text-ink/70">
                {notCountedText(model.notCounted.names, doc.data?.view.rows ?? [])}
                {isAdmin && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="font-medium text-accent-deep underline disabled:opacity-60"
                      disabled={publishDisabled}
                      onClick={runPublish}
                    >
                      Publish again to include them.
                    </button>
                  </>
                )}
              </p>
            )}
            {model.summaryFor !== null ? (
              <p className="mt-3 text-sm">
                <Link to={{ pathname: reportPath, search: search((n) => n.delete('scope')) }} className="font-medium text-accent-deep underline">
                  {model.summaryFor}
                </Link>
              </p>
            ) : isAdmin ? (
              <>
                {!doc.data?.live && (
                  <p className="mt-3 text-sm text-ink/80">Edits apply to the live report and the next publish.</p>
                )}
                {summary.isError && !summary.data ? (
                  <p role="alert" className="mt-3 text-sm text-status-r">
                    Could not load the summary: {summary.error.message}
                  </p>
                ) : (
                  summary.data && (
                    <SummaryEditor
                      key={period.period}
                      scorecardId={scorecardId}
                      period={period.period}
                      summary={summary.data}
                      reload={reloadSummary}
                      onDirtyChange={setSummaryDirty}
                    />
                  )
                )}
              </>
            ) : (
              <p className="mt-3 whitespace-pre-wrap text-sm">{model.summary || 'No summary written for this month.'}</p>
            )}
            {model.facts.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-sm">
                {model.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </section>

          <ReportBody
            model={model}
            scorecardName={scorecardName}
            scale={scale}
            phone={phone}
            counted={counted ?? doc.data!.view}
            fiscalYearStartMonth={fy}
            scorecardId={scorecardId}
            isAdmin={isAdmin}
          />
        </>
      )}

      {isMonth && months.data && months.data.months.length > 0 && (
        <section aria-labelledby="report-history" className="pt-8">
          <h2 id="report-history" className="text-lg font-semibold text-accent-deep">
            Report history
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {[...months.data.months].reverse().map((m) => {
              const p = parsePeriod(m.period)
              const name = publisherName(m.publishedBy)
              const status =
                m.status === 'published'
                  ? `Published${m.publishedAt ? ` on ${dateLabel(m.publishedAt)}` : ''}${name ? ` by ${name}` : ''}`
                  : 'Live'
              return (
                <li key={m.period}>
                  <Link
                    to={{
                      pathname: reportPath,
                      search: search((n) => {
                        n.set('period', m.period)
                        n.delete('revision')
                      }),
                    }}
                    aria-current={m.period === period.period ? 'page' : undefined}
                    className="font-medium text-accent-deep underline"
                  >
                    {p ? periodLabel(p, fy) : m.period}
                  </Link>
                  {` · ${status}`}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
