import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  useAssistantSettings,
  useCellRca,
  useFiscalYearStartMonth,
  useMe,
  usePutCellRca,
  type CellRca,
  type RcaCellRef,
  type RcaNote,
} from '../../api/queries'
import { parsePeriod, periodLabel as labelOf } from '../../lib/period'
import { StatusChip, type StatusLevel } from '../../ui/status'
import { primaryButton, secondaryButton } from '../admin/formUi'
import { chartTheme, defaultStatusScale } from '../scorecard/charts/chartTheme'
import { RcaEditForm } from './RcaEditForm'
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

/** The value row: only in the phone sheet, from the RCAs view or Report, and on a contributor's card. */
function ValueRow({ rca, scale }: { rca: CellRca; scale: StatusLevel[] }) {
  const label = chartTheme(scale, rca.status).label
  return (
    <p data-testid="why-value" className="mt-1 flex items-center gap-2">
      <span className="text-xl font-semibold leading-7 tabular-nums">{rca.display || '—'}</span>
      {rca.status && (
        <>
          <StatusChip status={rca.status} scale={scale} size="lg" />
          {label && <span className="sr-only">{label}</span>}
        </>
      )}
    </p>
  )
}

/**
 * One cell's Why card (spec §10.2): a modal popover anchored to the trigger
 * from 640px up, a bottom sheet below. Focus goes to the heading on open and
 * back to the trigger on close; unsaved edits ask before closing.
 */
export function WhyCard({ scorecardId, cell, anchor, opts, onClosed }: WhyCardProps) {
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const announce = useWhyCardAnnounce()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor])

  const [stack, setStack] = useState<Frame[]>([{ ref: cell }])
  const frame = stack[stack.length - 1]!
  const top = stack.length === 1
  const [editing, setEditing] = useState(false)
  const [startDraft, setStartDraft] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const query = useCellRca(scorecardId, frame.ref)
  const rca = query.data
  const me = useMe()
  const fy = useFiscalYearStartMonth()
  const settings = useAssistantSettings(rca?.canEdit === true)
  const confirm = usePutCellRca(scorecardId)
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

  const requestClose = () => {
    if (editing && dirty) setConfirmDiscard(true)
    else onClosed()
  }
  const changed = (result: 'saved' | 'deleted', note: RcaNote | null) => {
    setEditing(false)
    setStartDraft(false)
    setDirty(false)
    announce(result === 'saved' ? 'RCA saved' : 'RCA deleted')
    if (top) opts.onChange?.(note)
  }
  const stillAccurate = () => {
    const note = rca?.note
    if (!note) return
    setConfirmError(null)
    confirm.mutate(
      { ...frame.ref, text: note.text, links: note.links, expectedRevision: note.revision },
      {
        onSuccess: (saved) => changed('saved', saved),
        onError: (e) => setConfirmError(e.message),
      },
    )
  }

  const title = (top ? opts.title : undefined) ?? rca?.subjectName ?? 'Loading…'
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

  let body: ReactNode
  if (query.isPending) {
    body = <Skeleton />
  } else if (query.isError || !rca) {
    const display = rca?.display ?? (top ? opts.display : undefined)
    body = (
      <div role="alert" className="mt-3 text-sm leading-5">
        <p>{display ? `Couldn't load why this cell is ${display}.` : "Couldn't load why for this cell."}</p>
        <button type="button" className={clsx(secondaryButton, 'mt-2 h-8')} onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    )
  } else if (editing) {
    body = (
      <RcaEditForm
        scorecardId={scorecardId}
        rca={rca}
        samEnabled={samEnabled}
        startDraft={startDraft}
        onDone={changed}
        onCancel={() => {
          setEditing(false)
          setStartDraft(false)
          setDirty(false)
          setConfirmDiscard(false)
        }}
        onDirtyChange={setDirty}
      />
    )
  } else {
    body = (
      <WhyCardContent
        scorecardId={scorecardId}
        rca={rca}
        periodLabel={periodLabel}
        scale={scale}
        sheet={phone}
        isAdmin={me.data?.role === 'admin'}
        samEnabled={samEnabled}
        confirming={confirm.isPending}
        confirmError={confirmError}
        onEdit={() => setEditing(true)}
        onDraft={() => {
          setStartDraft(true)
          setEditing(true)
        }}
        onConfirm={stillAccurate}
        onOpenChild={(child) =>
          setStack((s) => [...s, { ref: { ...frame.ref, subject: child.subjectId }, parentName: rca.subjectName }])
        }
        onNavigate={onClosed}
      />
    )
  }

  const card = (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {frame.parentName !== undefined && !editing && (
            <button
              type="button"
              className="-mx-1 mb-0.5 min-h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
              onClick={() => setStack((s) => s.slice(0, -1))}
            >
              <span aria-hidden="true">‹</span> <span className="sr-only">Back to</span> {frame.parentName}
            </button>
          )}
          <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">
            Why · {periodLabel}
            {editing && ' · Editing'}
          </p>
          {heading}
          {editing && rca && (
            <p className="text-xs leading-4 text-ink/70">
              {rca.display}
              {rca.gap.headline && ` · ${rca.gap.headline}`}
            </p>
          )}
          {!editing && showValue && rca && <ValueRow rca={rca} scale={scale} />}
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
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      {body}
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
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-xl bg-white p-4 pb-[max(16px,env(safe-area-inset-bottom))] text-ink shadow-lg"
          >
            {card}
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
          {card}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
