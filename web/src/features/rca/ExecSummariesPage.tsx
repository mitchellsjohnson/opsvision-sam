import clsx from 'clsx'
import { Copy, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  useMe,
  useMetricSummaries,
  useOrgUnits,
  useVersions,
  type MetricSummary,
  type SummaryListState,
} from '../../api/queries'
import { parsePeriod, periodLabel } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { primaryButton, secondaryButton } from '../admin/formUi'
import { defaultStatusScale } from '../scorecard/charts/chartTheme'
import { SpokenChip } from '../scorecard/report/ReportStatusList'
import { versionInForce } from '../scorecard/viewRequest'
import { requiredFor } from './rcaState'
import { noteDate } from './rcaText'
import { reminderText, standingLine } from './summaryReminder'
import { useWhyCard, useWhyCardAnnounce } from './WhyCardProvider'

type ListState = Exclude<SummaryListState, 'optional'>

const STATES: { value: ListState; label: string }[] = [
  { value: 'missing', label: 'Needed' },
  { value: 'stale', label: 'To review' },
  { value: 'written', label: 'Written' },
  { value: 'all', label: 'All' },
]

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

/** The list's name for a state: `Exec summaries needed for Oct 2026`. */
function listName(state: ListState, month: string): string {
  switch (state) {
    case 'missing':
      return `Exec summaries needed for ${month}`
    case 'stale':
      return `Exec summaries to review for ${month}`
    case 'written':
      return `Exec summaries written for ${month}`
    case 'all':
      return `Exec summaries for ${month}`
  }
}

/**
 * The Attribution column: the gap in the standing's words (unless the
 * requirement already says it), then the top evidence keys, or `Nothing linked`.
 */
export function attributionText(s: MetricSummary): string {
  const headline = s.standing.headline
  const worst = headline.indexOf(' · worst ')
  const gap = worst >= 0 ? headline.slice(0, worst) : headline
  const parts = gap && gap !== s.requirementReason ? [gap] : []
  const evidence = s.evidence ?? []
  if (evidence.length === 0) parts.push('Nothing linked')
  else {
    const named = evidence.slice(0, 3).map((e) => (e.pointsDisplay ? `${e.key} ${e.pointsDisplay}` : e.key))
    parts.push(evidence.length > 3 ? `${named.join(', ')} + ${evidence.length - 3} more` : named.join(', '))
  }
  return parts.join(' · ')
}

/** What a row's button says: admins write, review or edit; everyone else opens the card. */
function actionLabel(s: MetricSummary, isAdmin: boolean): string {
  if (!isAdmin) return 'Open'
  switch (s.state) {
    case 'missing':
      return 'Write'
    case 'stale':
      return 'Review'
    case 'written':
      return 'Edit'
    case 'optional':
      return 'Add'
  }
}

/** The slot a deleted summary leaves: missing when the month requires one, else optional. */
function unwritten(s: MetricSummary): MetricSummary {
  return {
    ...s,
    state: s.requirement === 'required' ? 'missing' : 'optional',
    text: undefined,
    authorName: undefined,
    channel: undefined,
    updatedAt: undefined,
    revision: undefined,
    links: [],
    linksTotal: 0,
    stale: false,
    staleReasons: [],
  }
}

/** Reads every page of a list (the server pages by size). */
function useAllPages(q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => Promise<unknown> }) {
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
}

interface Pin {
  summary: MetricSummary
  /** Where the row stood when it changed, so it stays in place. */
  index: number
  /** The listed row's revision it replaces: the list wins once it has moved past it. */
  supersedes: number | undefined
}

const NO_PINS: ReadonlyMap<string, Pin> = new Map()

function MissingTag({ isAdmin, neededFor }: { isAdmin: boolean; neededFor?: string }) {
  return isAdmin ? (
    <span className="inline-flex whitespace-nowrap rounded border border-status-r px-1.5 text-[11px] font-semibold leading-4 text-status-r">
      {neededFor ? `Needed for ${neededFor}` : 'Exec summary needed'}
    </span>
  ) : (
    <span className="inline-flex whitespace-nowrap rounded border border-dashed border-ink/40 px-1.5 text-[11px] font-semibold leading-4 text-ink/70">
      No exec summary yet
    </span>
  )
}

/** Why the row's summary is required: the reason, the month a coarse period was required for, or not at all. */
function reasonText(s: MetricSummary, neededFor: string | undefined): string {
  if (s.requirement === 'required') return s.requirementReason ?? ''
  return neededFor ? `Required for ${neededFor}` : 'Not required (100%)'
}

function SummaryCell({ s, isAdmin, neededFor }: { s: MetricSummary; isAdmin: boolean; neededFor?: string }) {
  if (s.state === 'missing' || (neededFor && !s.text)) return <MissingTag isAdmin={isAdmin} neededFor={neededFor} />
  if (!s.text) return <span className="text-ink/70">None</span>
  const byline = [s.authorName, s.updatedAt ? noteDate(s.updatedAt) : '', s.linksTotal > 0 ? `${s.linksTotal} link${s.linksTotal === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <span dir="auto" className="line-clamp-2 break-words">
        {s.text}
      </span>
      {byline && <span className="block text-[11px] leading-4 text-ink/70">{byline}</span>}
      {s.state === 'stale' && <span className="block text-[11px] font-semibold leading-4 text-status-y">May be out of date</span>}
    </>
  )
}

/** `worst {item}` for a metric with no company value, else ''. */
function worstLine(s: MetricSummary): string {
  return s.standing.headline.includes(' · worst ') ? standingLine(s) : ''
}

function ThisMonth({ s, scale, worst = true }: { s: MetricSummary; scale: ReturnType<typeof defaultStatusScale>; worst?: boolean }) {
  const line = worst ? worstLine(s) : ''
  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-semibold tabular-nums">{s.standing.display || '—'}</span>
        {s.standing.status && <SpokenChip status={s.standing.status} scale={scale} />}
      </span>
      {line && <span className="block text-xs leading-4 text-ink/70 break-words">{line}</span>}
    </>
  )
}

/**
 * The Exec summaries view (spec §10.5): one row per metric of the month at
 * company scope, what is needed first. Everyone sees what is missing; only
 * admins write, from the metric's Why card.
 */
export function ExecSummariesPage() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const [view] = usePeriodState()
  const me = useMe()
  const isAdmin = me.data?.role === 'admin'
  const fy = view.fiscalYearStartMonth
  const parsed = parsePeriod(view.period)
  const isMonth = parsed?.grain === 'month'
  const month = isMonth ? view.period : ''
  const monthLabel = parsed ? periodLabel(parsed, fy) : view.period
  const raw = params.get('state')
  const listState: ListState = STATES.some((s) => s.value === raw) ? (raw as ListState) : 'missing'
  const whyParam = params.get('why') ?? ''

  const list = useMetricSummaries(scorecardId, { period: month, state: listState })
  const missingList = useMetricSummaries(scorecardId, { period: month, state: 'missing' })
  const allList = useMetricSummaries(scorecardId, { period: whyParam ? month : '', state: 'all' })
  useAllPages(list)
  useAllPages(missingList)
  useAllPages(allList)

  const units = useOrgUnits()
  const roots = units.data?.units.filter((u) => u.parentId === '') ?? []
  const company = roots.length === 1 ? roots[0] : undefined
  const versions = useVersions(scorecardId)
  const categories = useMemo(
    () => versionInForce(versions.data?.versions ?? [], view.period, '')?.content.categories ?? [],
    [versions.data?.versions, view.period],
  )
  const scale = me.data?.tenant?.statusScale?.length ? me.data.tenant.statusScale : defaultStatusScale()
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label || key
  const why = useWhyCard()
  const announce = useWhyCardAnnounce()
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const filterId = useId()

  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState<'' | 'copied' | 'failed'>('')
  const [noCompany, setNoCompany] = useState(false)
  const neededOf = (s: MetricSummary) => requiredFor(s, month, fy)
  const pinKey = `${month}|${listState}`
  const [pinState, setPinState] = useState<{ key: string; pins: Map<string, Pin> }>({ key: pinKey, pins: new Map() })
  const pins = pinState.key === pinKey ? pinState.pins : NO_PINS

  const listed = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const counts = list.data?.pages[0]?.counts
  const rows = useMemo(() => {
    const out = listed.map((s) => {
      const pin = pins.get(s.metricKey)
      return pin && s.revision === pin.supersedes ? pin.summary : s
    })
    const present = new Set(listed.map((s) => s.metricKey))
    for (const [key, pin] of [...pins].sort((a, b) => a[1].index - b[1].index)) {
      if (!present.has(key)) out.splice(Math.min(pin.index, out.length), 0, pin.summary)
    }
    return out
  }, [listed, pins])
  const needle = filter.trim().toLowerCase()
  const shown = needle ? rows.filter((s) => s.metricName.toLowerCase().includes(needle)) : rows
  const groups = useMemo(() => {
    const out: { id: string; name: string; items: MetricSummary[] }[] = []
    for (const s of shown) {
      const id = s.categoryId ?? ''
      let g = out.find((x) => x.id === id)
      if (!g) {
        g = { id, name: categories.find((c) => c.id === id)?.name ?? (id || 'Other'), items: [] }
        out.push(g)
      }
      g.items.push(s)
    }
    return out
  }, [shown, categories])

  const onChanged = (s: MetricSummary, saved: MetricSummary | null) => {
    setPinState((prev) => {
      const current = prev.key === pinKey ? prev.pins : new Map<string, Pin>()
      const next = new Map(current)
      const was = current.get(s.metricKey)
      const index = Math.max(0, rows.findIndex((r) => r.metricKey === s.metricKey))
      next.set(s.metricKey, {
        // The row keeps its place: same category group, same position.
        summary: saved
          ? { ...saved, categoryId: s.categoryId ?? saved.categoryId, evidence: saved.evidence ?? s.evidence }
          : unwritten(s),
        index: was?.index ?? index,
        supersedes: was ? was.supersedes : listed.find((r) => r.metricKey === s.metricKey)?.revision,
      })
      return { key: pinKey, pins: next }
    })
    // The card's own live region, so the save is announced once, naming the metric.
    announce(saved ? `Exec summary saved for ${s.metricName}` : `Exec summary deleted for ${s.metricName}`)
  }

  const openCard = (s: MetricSummary, anchor: HTMLElement) => {
    if (!company) {
      setNoCompany(units.isSuccess)
      return
    }
    why.open({ metric: s.metricKey, subject: company.id, period: s.period }, anchor, {
      title: `${company.name} · ${s.metricName}`,
      showValue: true,
      display: s.standing.display || undefined,
      onChange: (saved) => onChanged(s, saved),
    })
  }

  // `?why={metric}` opens that metric's card once the list and the company are known.
  const openedWhy = useRef('')
  useEffect(() => {
    if (!whyParam || openedWhy.current === whyParam || !company || !list.data) return
    const s = rows.find((r) => r.metricKey === whyParam) ?? allList.data?.pages.flatMap((p) => p.items).find((r) => r.metricKey === whyParam)
    if (!s && whyParam && allList.isPending) return
    openedWhy.current = whyParam
    const anchor = document.querySelector<HTMLElement>(`[data-why-trigger="${CSS.escape(whyParam)}"]`) ?? headingRef.current
    if (!anchor) return
    if (s) openCard(s, anchor)
    else
      why.open({ metric: whyParam, subject: company.id, period: month }, anchor, { title: `${company.name} · ${whyParam}`, showValue: true })
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('why')
        return next
      },
      { replace: true },
    )
  })

  const setState = (s: ListState) => {
    setCopied('')
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (s === 'missing') next.delete('state')
      else next.set('state', s)
      return next
    })
  }

  const missingItems = missingList.data?.pages.flatMap((p) => p.items) ?? []
  const copyReminder = async () => {
    if (missingItems.length === 0) return
    const url = `${window.location.origin}/scorecards/${scorecardId}/exec-summaries?${new URLSearchParams({ period: month })}`
    try {
      await navigator.clipboard.writeText(reminderText(missingItems, url, monthLabel, statusLabel))
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  const total = counts ? counts.missing + counts.stale + counts.written + counts.optional : 0
  const countOf = (s: ListState) => (!counts ? 0 : s === 'all' ? total : counts[s])

  const action = (s: MetricSummary, className: string) => {
    const label = actionLabel(s, isAdmin)
    return (
      <button
        type="button"
        data-why-trigger={s.metricKey}
        className={clsx(label === 'Write' ? primaryButton : secondaryButton, className)}
        onClick={(e) => openCard(s, e.currentTarget)}
      >
        {label} <span className="sr-only">exec summary for {s.metricName}</span>
      </button>
    )
  }

  let body: ReactNode
  if (!isMonth) {
    body = <p className="mt-4 text-sm">Exec summaries are written for a month. Choose a month under Period.</p>
  } else if (list.isPending) {
    body = (
      <p role="status" aria-busy="true" className="mt-4 text-sm">
        Loading exec summaries…
      </p>
    )
  } else if (list.isError) {
    body = (
      <div role="alert" className="mt-4 rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        Could not load the exec summaries: {list.error.message}
      </div>
    )
  } else if (rows.length === 0) {
    const nothingRequired = (counts?.required ?? 0) === 0
    body =
      listState === 'missing' && !nothingRequired ? (
        <div className="mt-4 rounded-lg border border-ink/20 bg-white p-4 text-sm">
          <p>{`Every exec summary for ${monthLabel} is written. The month can be published.`}</p>
          <Link
            to={`/scorecards/${scorecardId}/report?${new URLSearchParams({ period: month })}`}
            className="mt-2 inline-block font-medium text-accent-deep hover:underline"
          >
            Go to the Report ›
          </Link>
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-ink/20 bg-white p-4 text-sm">
          {nothingRequired && (listState === 'missing' || listState === 'all')
            ? 'Every metric is at 100% this month; no exec summary is required.'
            : listState === 'stale'
              ? `No exec summary for ${monthLabel} needs review.`
              : `No exec summaries are written for ${monthLabel} yet.`}
        </p>
      )
  } else if (shown.length === 0) {
    body = <p className="mt-4 text-sm">{`No metric matches “${filter.trim()}”.`}</p>
  } else if (phone) {
    body = (
      <ul aria-label={listName(listState, monthLabel)} className="mt-3 space-y-3">
        {shown.map((s) => (
          <li key={s.metricKey} className="rounded-lg border border-ink/20 bg-white p-3">
            <p className="text-base font-semibold leading-6 break-words">{s.metricName}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm">
              <ThisMonth s={s} scale={scale} worst={false} />
              <span className="text-ink/80">
                {' · '}
                {reasonText(s, neededOf(s))}
              </span>
            </p>
            {worstLine(s) && <p className="text-xs leading-4 text-ink/70 break-words">{worstLine(s)}</p>}
            <p className="mt-1 text-xs leading-4 text-ink/70 break-words">{attributionText(s)}</p>
            <div className="mt-2 text-sm">
              <SummaryCell s={s} isAdmin={isAdmin} neededFor={neededOf(s)} />
            </div>
            {action(s, 'mt-3 h-10 w-full')}
          </li>
        ))}
      </ul>
    )
  } else {
    body = (
      <div className="mt-3 rounded-lg border border-ink/20 bg-white">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <caption className="px-3 py-2 text-left text-xs font-medium text-ink/70">{`${listName(listState, monthLabel)}, by category, worst first`}</caption>
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[14%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[22%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr className="text-left text-xs text-ink/70">
              {['Metric', 'This month', "Why it's required", 'Attribution', 'Exec summary'].map((h) => (
                <th key={h} scope="col" className="border-y border-ink/10 px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
              <th scope="col" className="border-y border-ink/10 px-3 py-2 text-right font-medium">
                Action
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={6}
                  className="border-b border-ink/10 bg-cream/60 px-3 py-1.5 text-left text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70"
                >
                  {`${g.name} · ${g.items.length}`}
                </th>
              </tr>
              {g.items.map((s) => (
                <tr key={s.metricKey} className="align-top">
                  <th scope="row" className="border-b border-ink/10 px-3 py-2.5 text-left font-medium break-words">
                    {s.metricName}
                  </th>
                  <td className="border-b border-ink/10 px-3 py-2.5">
                    <ThisMonth s={s} scale={scale} />
                  </td>
                  <td className="border-b border-ink/10 px-3 py-2.5 break-words">{reasonText(s, neededOf(s))}</td>
                  <td className="border-b border-ink/10 px-3 py-2.5 text-xs leading-4 break-words">{attributionText(s)}</td>
                  <td className="border-b border-ink/10 px-3 py-2.5">
                    <SummaryCell s={s} isAdmin={isAdmin} neededFor={neededOf(s)} />
                  </td>
                  <td className="border-b border-ink/10 px-3 py-2 text-right">{action(s, 'h-7 py-0 text-xs')}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-accent-deep">
        Exec summaries
      </h1>
      <p className="mt-1 text-sm text-ink/70">{`${monthLabel} · one per metric that is not at 100% · required to publish`}</p>

      {isMonth && (
        <>
          <div role="group" aria-label="Show exec summaries by state" className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {STATES.map((s) => {
              const pressed = listState === s.value
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setState(s.value)}
                  className={clsx(
                    'flex min-h-9 items-center gap-2 rounded-lg border bg-white px-3 py-1 text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep',
                    pressed ? 'border-accent bg-accent/[0.08] ring-1 ring-inset ring-accent' : 'border-ink/20 hover:bg-cream',
                  )}
                >
                  <span className="text-base font-semibold leading-5 tabular-nums">{countOf(s.value)}</span>{' '}
                  <span className="text-xs">{s.label}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="relative w-full sm:w-64">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-ink/70" />
              <input
                id={filterId}
                type="search"
                aria-label={`Filter ${total} metrics`}
                placeholder={`Filter ${total} metrics`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-9 w-full rounded-md border border-ink/30 bg-white pl-8 pr-2 text-sm placeholder:text-ink/70"
              />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <p role="status" className={clsx('text-xs', copied === 'failed' ? 'text-status-r' : 'text-ink/70')}>
                {copied === 'copied'
                  ? 'Reminder copied'
                  : copied === 'failed'
                    ? 'Couldn’t copy the reminder: the browser did not allow it.'
                    : ''}
              </p>
              <button
                type="button"
                className={clsx(secondaryButton, 'inline-flex h-9 items-center gap-1.5')}
                disabled={missingItems.length === 0}
                onClick={() => void copyReminder()}
              >
                <Copy aria-hidden="true" className="size-4" />
                Copy reminder
              </button>
            </div>
          </div>
        </>
      )}

      {noCompany && (
        <p role="alert" className="mt-3 text-sm text-status-r">
          No exec summary can be written: the organization has no single top-level unit.
        </p>
      )}
      {body}
    </div>
  )
}
