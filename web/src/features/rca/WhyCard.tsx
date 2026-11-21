import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  mergeAttribution,
  useAssistantSettings,
  useCellAttribution,
  useFiscalYearStartMonth,
  useMe,
  useMetricSummary,
  useOrgUnits,
  usePutMetricSummary,
  useSetMetricSummary,
  type CellAttribution,
  type MetricSummary,
  type MetricSummaryConflict,
  type RcaCellRef,
} from '../../api/queries'
import { ApiError } from '../../api/errors'
import { parsePeriod, periodLabel as labelOf } from '../../lib/period'
import { StatusChip, type StatusLevel } from '../../ui/status'
import { primaryButton, secondaryButton } from '../admin/formUi'
import { chartTheme, defaultStatusScale } from '../scorecard/charts/chartTheme'
import { RcaEditForm } from './RcaEditForm'
import { SummarySection } from './SummarySection'
import { WhyCardContent } from './WhyCardContent'
import { useWhyCardAnnounce, type WhyCardOpenOptions } from './WhyCardProvider'

/** Tailwind's `sm`: below it the card is a bottom sheet. Without matchMedia, assume a wider screen. */
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

interface Frame {
  ref: RcaCellRef
  /** The roll-up this card was opened from, for `‹ {parent}`. */
  parentName?: string
}

export interface WhyCardProps {
  scorecardId: string
  cell: RcaCellRef
  anchor: HTMLElement
  opts: WhyCardOpenOptions
  onClosed: () => void
}

function Skeleton() {
  return (
    <div role="status" aria-busy="true" className="mt-3 space-y-2">
      <span className="sr-only">Loading why</span>
      <div aria-hidden="true" className="h-4 w-3/4 rounded bg-ink/[0.08]" />
      <div aria-hidden="true" className="h-3 w-1/2 rounded bg-ink/[0.06]" />
      <div aria-hidden="true" className="h-2 w-full rounded bg-ink/[0.06]" />
      <div aria-hidden="true" className="h-12 w-full rounded bg-ink/[0.04]" />
    </div>
  )
}

/** The value row: only in the phone sheet, from the Exec summaries view or Report, and on a contributor's card. */
function ValueRow({ attribution: a, scale }: { attribution: CellAttribution; scale: StatusLevel[] }) {
  const label = chartTheme(scale, a.status).label
  return (
    <p data-testid="why-value" className="mt-1 flex items-center gap-2">
      <span className="text-xl font-semibold leading-7 tabular-nums">{a.display || '—'}</span>
      {a.status && (
        <>
          <StatusChip status={a.status} scale={scale} size="lg" />
          {label && <span className="sr-only">{label}</span>}
        </>
      )}
    </p>
  )
}

/** A written or stale summary: edits and `Still accurate` must start from its stored copy, never the card's excerpt. */
function isWritten(s: MetricSummary): boolean {
  return s.state === 'written' || s.state === 'stale'
}

/**
 * One cell's Why card (spec §10.2): a modal popover anchored to the trigger
 * from 640px up, a bottom sheet below. The metric's exec summary comes
 * first, then the cell's attribution. Focus goes to the heading on open and
 * back to the trigger on close; unsaved edits ask before closing.
 */
export function WhyCard({ scorecardId, cell, anchor, opts, onClosed }: WhyCardProps) {
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const announce = useWhyCardAnnounce()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Set when the focused control is about to disappear; applied after the next render.
  const focusAfter = useRef<'heading' | 'summary' | 'text' | null>(null)
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor])

  const [stack, setStack] = useState<Frame[]>([{ ref: cell }])
  const frame = stack[stack.length - 1]!
  const top = stack.length === 1
  const [editing, setEditing] = useState(false)
  const [startDraft, setStartDraft] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const query = useCellAttribution(scorecardId, frame.ref)
  const attribution = mergeAttribution(query.data)
  const summary = attribution?.summary ?? null
  const me = useMe()
  const fy = useFiscalYearStartMonth()
  const units = useOrgUnits()
  const settings = useAssistantSettings(summary?.canEdit === true)
  const confirm = usePutMetricSummary(scorecardId)
  const setStored = useSetMetricSummary(scorecardId)
  // Editing and `Still accurate` always start from getMetricSummary: a card carries an excerpt and 3 links,
  // and nothing in the excerpt reliably says it was cut. The query is shared with the section's.
  const needWhole = summary !== null && summary.canEdit && isWritten(summary) && (editing || summary.stale)
  const whole = useMetricSummary(scorecardId, needWhole ? summary.metricKey : null, summary?.period ?? '')
  const editable = summary === null ? null : isWritten(summary) ? (whole.data ?? null) : summary
  const company = units.data?.units.some((u) => u.id === frame.ref.subject && u.parentId === '') === true
  const scale = me.data?.tenant?.statusScale?.length ? me.data.tenant.statusScale : defaultStatusScale()
  const parsed = parsePeriod(frame.ref.period)
  const periodLabel = parsed ? labelOf(parsed, fy) : frame.ref.period
  const samEnabled = settings.data?.enabled === true

  const focusHeading = () => headingRef.current?.focus()
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!editing) focusHeading()
  }, [stack.length, editing])
  useEffect(() => {
    if (confirmDiscard) keepRef.current?.focus()
  }, [confirmDiscard])
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    const el =
      target === 'heading'
        ? headingRef.current
        : target === 'text'
          ? bodyRef.current?.querySelector<HTMLElement>('textarea')
          : bodyRef.current?.querySelector<HTMLElement>('[data-summary-text]')
    ;(el ?? headingRef.current)?.focus()
  })

  const requestClose = () => {
    if (editing && dirty) setConfirmDiscard(true)
    else onClosed()
  }
  const changed = (result: 'saved' | 'deleted', saved: MetricSummary | null) => {
    setEditing(false)
    setStartDraft(false)
    setDirty(false)
    announce(result === 'saved' ? 'Exec summary saved' : 'Exec summary deleted')
    if (top) opts.onChange?.(saved)
  }
  const stillAccurate = () => {
    if (!editable?.text) return
    setConfirmError(null)
    confirm.mutate(
      {
        metric: editable.metricKey,
        period: editable.period,
        text: editable.text,
        links: editable.links,
        expectedRevision: editable.revision ?? 0,
      },
      {
        onSuccess: (saved) => {
          // `Still accurate` goes away once the summary is no longer stale.
          focusAfter.current = 'summary'
          changed('saved', saved)
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409) {
            // Show their version, so the next Still accurate or Edit goes against the stored revision.
            setStored(editable.metricKey, editable.period, (e.body as MetricSummaryConflict | undefined)?.current ?? null)
            setConfirmError(`${e.message} Their version is shown; check it before confirming.`)
            focusAfter.current = 'summary'
            return
          }
          setConfirmError(e.message)
        },
      },
    )
  }

  const title = (top ? opts.title : undefined) ?? attribution?.subjectName ?? 'Loading…'
  const showValue = phone || opts.showValue === true || !top
  const headingClass = 'break-words text-base font-semibold leading-6 text-ink'
  const heading = phone ? (
    <Dialog.Title asChild>
      <h2 ref={headingRef} tabIndex={-1} className={headingClass}>
        {title}
      </h2>
    </Dialog.Title>
  ) : (
    <h3 ref={headingRef} id={headingId} tabIndex={-1} className={headingClass}>
      {title}
    </h3>
  )

  const startEditing = (draft: boolean) => {
    setStartDraft(draft)
    setEditing(true)
  }
  const stopEditing = () => {
    setEditing(false)
    setStartDraft(false)
    setDirty(false)
    setConfirmDiscard(false)
  }

  let summarySlot: ReactNode = null
  if (summary && editing) {
    summarySlot = editable ? (
      <RcaEditForm
        scorecardId={scorecardId}
        summary={editable}
        attribution={attribution}
        samEnabled={samEnabled}
        startDraft={startDraft}
        onDone={changed}
        onCancel={stopEditing}
        onDirtyChange={setDirty}
      />
    ) : whole.isError ? (
      <div role="alert" className="mt-3 text-sm leading-5">
        <p>Couldn&apos;t load the exec summary.</p>
        <button type="button" className={clsx(secondaryButton, 'mt-2 h-8')} onClick={() => void whole.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <Skeleton />
    )
  } else if (summary) {
    summarySlot = (
      <SummarySection
        scorecardId={scorecardId}
        summary={summary}
        context={!top || (units.data !== undefined && !company)}
        whole={top && company}
        samEnabled={samEnabled}
        confirming={confirm.isPending || (summary.stale && summary.canEdit && editable === null)}
        confirmError={confirmError}
        loadError={summary.stale && whole.isError}
        onRetry={() => void whole.refetch()}
        onWrite={() => startEditing(false)}
        onDraft={() => startEditing(true)}
        onConfirm={stillAccurate}
      />
    )
  }

  let body: ReactNode
  if (query.isPending) {
    body = <Skeleton />
  } else if (query.isError || !attribution) {
    const display = attribution?.display ?? (top ? opts.display : undefined)
    body = (
      <div role="alert" className="mt-3 text-sm leading-5">
        <p>{display ? `Couldn't load why this cell is ${display}.` : "Couldn't load why for this cell."}</p>
        <button
          type="button"
          className={clsx(secondaryButton, 'mt-2 h-8')}
          onClick={() =>
            void query.refetch().then(() => {
              focusAfter.current = 'heading'
            })
          }
        >
          Try again
        </button>
      </div>
    )
  } else {
    const next = attribution.incidentsCursor ? 'incidents' : attribution.recordsCursor ? 'records' : null
    body = (
      <WhyCardContent
        scorecardId={scorecardId}
        attribution={attribution}
        periodLabel={periodLabel}
        scale={scale}
        sheet={phone}
        isAdmin={me.data?.role === 'admin'}
        summarySlot={summarySlot}
        editing={editing}
        next={next}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => {
          if (!query.isFetchingNextPage) void query.fetchNextPage()
        }}
        onEdit={() => startEditing(false)}
        onOpenChild={(child) => {
          if (editing && dirty) {
            setConfirmDiscard(true)
            return
          }
          stopEditing()
          setStack((s) => [...s, { ref: { ...frame.ref, subject: child.subjectId }, parentName: attribution.subjectName }])
        }}
        onNavigate={onClosed}
      />
    )
  }

  const header = (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {frame.parentName !== undefined && !editing && (
            <button
              type="button"
              className="-mx-1 mb-0.5 min-h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
              onClick={() => {
                setConfirmError(null)
                setStack((s) => s.slice(0, -1))
              }}
            >
              <span aria-hidden="true">‹</span> <span className="sr-only">Back to</span> {frame.parentName}
            </button>
          )}
          <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">
            Why · {periodLabel}
            {editing && ' · Editing'}
          </p>
          {heading}
          {editing && summary && (
            <p className="text-xs leading-4 text-ink/70">
              {summary.standing.headline || summary.standing.display}
              {summary.requirement === 'required' && ' · required'}
            </p>
          )}
          {!editing && showValue && attribution && <ValueRow attribution={attribution} scale={scale} />}
        </div>
        <button
          type="button"
          aria-label="Close"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink/70 hover:bg-ink/[0.06] hover:text-ink"
          onClick={requestClose}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {confirmDiscard && (
        <div role="alert" className="mt-2 rounded-md border border-ink/20 bg-cream p-2">
          <p className="text-sm font-medium leading-5">Discard your changes?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={clsx(primaryButton, 'h-7 py-0 text-xs')} onClick={onClosed}>
              Discard
            </button>
            <button
              ref={keepRef}
              type="button"
              className={clsx(secondaryButton, 'h-7 py-0 text-xs')}
              onClick={() => {
                focusAfter.current = 'text'
                setConfirmDiscard(false)
              }}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
    </>
  )

  const onOpenAutoFocus = (e: Event) => {
    e.preventDefault()
    focusHeading()
  }
  const onCloseAutoFocus = (e: Event) => {
    e.preventDefault()
    if (anchor.isConnected) anchor.focus()
  }

  if (phone) {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && requestClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={onOpenAutoFocus}
            onCloseAutoFocus={onCloseAutoFocus}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-xl bg-white text-ink shadow-lg"
          >
            {/* The header and Close stay put; the body is the sheet's only scroll area (spec §10.2). */}
            <div className="shrink-0 px-4 pt-4">{header}</div>
            <div
              ref={bodyRef}
              data-testid="why-body"
              className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))]"
            >
              {body}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }

  return (
    <Popover.Root open modal onOpenChange={(open) => !open && requestClose()}>
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          aria-labelledby={headingId}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className="z-50 max-h-[min(640px,calc(100vh-32px))] w-[400px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border border-ink/20 bg-white p-4 text-ink shadow-lg"
        >
          {header}
          <div ref={bodyRef} data-testid="why-body">
            {body}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
