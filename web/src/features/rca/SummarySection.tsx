import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import { useFiscalYearStartMonth, useMetricSummary, type MetricSummary } from '../../api/queries'
import { parsePeriod, periodLabel as labelOf } from '../../lib/period'
import { Sam } from '../../ui/Sam'
import { primaryButton, secondaryButton } from '../admin/formUi'
import { LinkList } from './LinkList'
import { noteDate, RCA_LINKS_SHOWN } from './rcaText'
import { useWhyCardAnnounce } from './WhyCardProvider'

const LABEL = 'text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70'
const SMALL_BUTTON = 'h-7 rounded-md border border-ink/40 bg-white px-2.5 text-xs font-medium hover:bg-cream disabled:opacity-60'
const TEXT_BUTTON = 'h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]'

/** The label of a period the summary belongs to: `Oct 2026`, or the quarter of a coarse metric. */
export function useSummaryPeriodLabel(period: string): string {
  const fy = useFiscalYearStartMonth()
  const parsed = parsePeriod(period)
  return parsed ? labelOf(parsed, fy) : period
}

/**
 * Why the period needs a summary, as the clause after `It is required
 * because`: `13 of 21 services are below 100% (worst Webhooks 99.06%)`,
 * `it is Red (99.63%)`, `it is below 100% (94%)`. '' when the server gave
 * no reason.
 */
export function requiredBecause(s: MetricSummary): string {
  const reason = (s.requirementReason ?? '').trim()
  const worst = / · (worst .+)$/.exec(s.standing.headline)?.[1]
  const counted = /^(\d+) of (\d+) (.+?) (below 100%|over plan|not .+)$/.exec(reason)
  if (counted) {
    const verb = counted[1] === '1' ? 'is' : 'are'
    return `${counted[1]} of ${counted[2]} ${counted[3]} ${verb} ${counted[4]}${worst ? ` (${worst})` : ''}`
  }
  if (/^(Below|Above) /.test(reason)) return `it is ${reason[0]!.toLowerCase()}${reason.slice(1)}`
  if (reason) return `it is ${reason}${s.standing.display ? ` (${s.standing.display})` : ''}`
  return ''
}

function DraftButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={clsx(secondaryButton, 'inline-flex h-8 items-center gap-1.5')} onClick={onClick}>
      <Sam className="size-4" />
      Draft with SAM
    </button>
  )
}

export interface SummarySectionProps {
  scorecardId: string
  /** The metric's exec summary for the period, as the card carries it (an excerpt and the first 3 links). */
  summary: MetricSummary
  /** The card is for a cell below the company: the label names the metric and period. */
  context: boolean
  /** Load and show the whole text at once, as the company's own card does; child cards show the excerpt with `More`. */
  whole?: boolean
  /** SAM is on for the organization: admins get `Draft with SAM`. */
  samEnabled: boolean
  /** A `Still accurate` save is running, and its failure. */
  confirming?: boolean
  confirmError?: string | null
  /** The whole summary that `Still accurate` sends could not be loaded; `onRetry` asks again. */
  loadError?: boolean
  onRetry?: () => void
  /** `Write exec summary`, `Edit` or `Add one`: opens the editor (admins). */
  onWrite: () => void
  onDraft: () => void
  onConfirm: () => void
}

/**
 * The Why card's Exec summary section (spec §10.2 item 2), always first:
 * the company's summary for the metric and period, or the slot saying it is
 * missing. Nothing else ever fills the slot. Admins (`summary.canEdit`) get
 * the actions; everyone else reads.
 */
export function SummarySection({
  scorecardId,
  summary: s,
  context,
  whole: wholeFirst = false,
  samEnabled,
  confirming = false,
  confirmError = null,
  loadError = false,
  onRetry,
  onWrite,
  onDraft,
  onConfirm,
}: SummarySectionProps) {
  const labelId = useId()
  const announce = useWhyCardAnnounce()
  const period = useSummaryPeriodLabel(s.period)
  const [allLinks, setAllLinks] = useState(false)
  const [moreClicked, setMoreClicked] = useState(false)
  const wholeText = wholeFirst || moreClicked
  const truncated = s.text?.endsWith('…') === true
  const haveAllLinks = s.links.length >= s.linksTotal
  const needWhole = (allLinks && !haveAllLinks) || (wholeText && truncated)
  const whole = useMetricSummary(scorecardId, needWhole ? s.metricKey : null, s.period)
  const links = allLinks ? (haveAllLinks ? s.links : (whole.data?.links ?? s.links)) : s.links.slice(0, RCA_LINKS_SHOWN)
  const text = wholeText && whole.data?.text ? whole.data.text : s.text
  const linksReady = allLinks && (haveAllLinks || whole.data !== undefined)
  const textRef = useRef<HTMLParagraphElement>(null)
  const showingWhole = moreClicked && whole.data?.text !== undefined

  // `More` removes itself once the whole text is in: focus the text it revealed.
  useEffect(() => {
    if (showingWhole) textRef.current?.focus()
  }, [showingWhole])

  useEffect(() => {
    if (linksReady) announce(`Showing ${links.length} links`)
    // Once per expansion, when the whole list is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linksReady])

  const label = (
    <p id={labelId} className={LABEL}>
      {context ? `Exec summary · ${s.metricName} · ${period}` : 'Exec summary'}
    </p>
  )

  if (s.state === 'missing') {
    const because = requiredBecause(s)
    return (
      <section
        aria-labelledby={labelId}
        className={clsx(
          'mt-3 rounded-md px-2 py-2',
          // One company task: the red block on the company's card, a quieter one on every child's (mockup 2).
          context ? 'bg-ink/[0.035]' : 'border border-status-r/40 bg-status-r-bg',
        )}
      >
        {label}
        <p className="mt-1 text-sm font-medium leading-5">
          No exec summary yet for {s.metricName}, {period}.
        </p>
        <p className="mt-0.5 text-xs leading-4 text-ink/80">
          {because ? `It is required because ${because}. ` : ''}The month can&apos;t be published until it is written.
        </p>
        {s.canEdit ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={clsx(primaryButton, 'h-8')} onClick={onWrite}>
              Write exec summary
            </button>
            {samEnabled && <DraftButton onClick={onDraft} />}
          </div>
        ) : (
          <p className="mt-1 text-xs leading-4 text-ink/80">Product ops writes this summary.</p>
        )}
      </section>
    )
  }

  if (s.state === 'optional') {
    return (
      <section aria-labelledby={labelId} className="mt-3 rounded-md bg-ink/[0.035] p-3">
        {label}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-4 text-ink/70">
          No exec summary (not required: 100% this month).
          {s.canEdit && (
            <button type="button" className={TEXT_BUTTON} onClick={onWrite}>
              Add one
            </button>
          )}
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby={labelId} className="mt-3 rounded-md bg-ink/[0.035] p-3">
      {label}
      {confirmError && (
        <p role="alert" className="mt-1.5 rounded-md border border-status-r bg-status-r-bg px-2 py-1.5 text-xs font-medium leading-4 text-ink">
          {confirmError}
        </p>
      )}
      {s.stale && (
        <div className="mt-1.5 rounded-md border border-status-y bg-status-y-bg px-2 py-1.5 text-xs leading-4 text-ink">
          <p className="font-semibold">This exec summary may be out of date.</p>
          {s.staleReasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
          {s.canEdit && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button type="button" className={SMALL_BUTTON} onClick={onWrite}>
                Edit
              </button>
              <button type="button" className={SMALL_BUTTON} disabled={confirming} onClick={onConfirm}>
                Still accurate
              </button>
            </div>
          )}
          {s.canEdit && loadError && (
            <p role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 font-medium text-status-r">
              Couldn&apos;t load the exec summary.
              <button type="button" className={SMALL_BUTTON} onClick={onRetry}>
                Try again
              </button>
            </p>
          )}
        </div>
      )}
      <p ref={textRef} tabIndex={-1} data-summary-text="" dir="auto" className="mt-1 break-words rounded-sm text-sm leading-5">
        {text}
        {truncated && !(wholeText && whole.data?.text) && (
          <>
            {' '}
            <button
              type="button"
              aria-expanded={wholeText}
              className={TEXT_BUTTON}
              onClick={() => setMoreClicked(true)}
            >
              More
            </button>
          </>
        )}
      </p>
      {s.authorName && (
        <p className="mt-1 text-[11px] leading-4 text-ink/70">
          {s.authorName}
          {s.updatedAt && ` · ${noteDate(s.updatedAt)}`}
          {s.channel === 'mcp' && ' · via MCP'}
        </p>
      )}
      <LinkList links={links} />
      {s.linksTotal > RCA_LINKS_SHOWN && (
        <button
          type="button"
          aria-expanded={allLinks}
          aria-busy={allLinks && !linksReady}
          className={clsx(TEXT_BUTTON, 'mt-1')}
          onClick={() => setAllLinks(!allLinks)}
        >
          {allLinks ? 'Show fewer' : `Show all ${s.linksTotal} links`}
        </button>
      )}
      {whole.isError && (
        <p role="alert" className="mt-1 text-xs leading-4 text-status-r">
          Couldn&apos;t load the whole exec summary.
        </p>
      )}
    </section>
  )
}
