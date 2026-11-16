import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useIsMutating } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, History, SendHorizontal, ShieldCheck, SquarePen, Target, WifiOff, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router'
import {
  keys,
  threadPending,
  useAskSamQuestion,
  useAssistantSettings,
  useAssistantThread,
  useAssistantThreads,
  useMe,
  useMyAssistantCredential,
  useOrgUnits,
  useVersions,
  type AssistantContext,
  type AssistantMessage,
} from '../../api/queries'
import { parsePeriod, periodLabel } from '../../lib/period'
import { menuItemHighlight } from '../../ui/focus'
import { Sam } from '../../ui/Sam'
import { primaryButton } from '../admin/formUi'
import { formatDate } from '../scorecard/format'
import { AssistantMessageItem, spokenText } from './AssistantMessage'
import { PRIVACY_LINE } from './useAssistant'

const MAX_QUESTION = 4000

/** `Oct 2026 · Unit A · On-time delivery`: what SAM is told the user is looking at. */
function useContextLabels(context: AssistantContext) {
  const me = useMe()
  const units = useOrgUnits()
  const versions = useVersions(context.metricKey ? context.scorecardId : undefined)
  const fy = me.data?.tenant?.fiscalYearStartMonth ?? 1
  const parsed = parsePeriod(context.period)
  const period = parsed ? periodLabel(parsed, fy) : ''
  const scope = context.scorecardId
    ? context.scope
      ? (units.data?.units.find((u) => u.id === context.scope)?.name ?? '')
      : `All of ${me.data?.tenant?.name ?? 'the company'}`
    : ''
  const all = versions.data?.versions ?? []
  const published = all.filter((v) => v.status === 'published')
  const metric = context.metricKey
    ? ([...published, ...all].flatMap((v) => v.content.metrics).find((m) => m.key === context.metricKey)?.name ?? '')
    : ''
  return { period, scope, metric, chip: [period, scope, metric].filter(Boolean).join(' · ') }
}

function starters(context: AssistantContext, labels: ReturnType<typeof useContextLabels>): string[] {
  const out: string[] = []
  const when = labels.period
  if (labels.metric) {
    out.push(when ? `Why is ${labels.metric} where it is in ${when}?` : `Why is ${labels.metric} where it is?`)
    out.push(`How is ${labels.metric} measured?`)
  }
  if (context.scorecardId) {
    const where = context.scope && labels.scope ? labels.scope : 'the company'
    out.push(`What needs attention in ${where}?`)
    if (when) out.push(`Summarize ${when}`)
  }
  if (out.length === 0) {
    out.push('How do statuses and bands work?', 'How does the commitment rule work?', 'What happens when data is restated?')
  }
  return out.slice(0, 4)
}

export interface DrawerBodyProps {
  context: AssistantContext
  threadId: string | null
  /** Counts the person's own chat switches, so a question asked before one does not switch back. */
  chat: number
  selectThread: (id: string | null) => void
  adoptThread: (chat: number, id: string) => void
  closeIfModal?: () => void
}

/** The drawer's content; loaded on first open, with the Markdown renderer it needs. */
export default function DrawerBody({ context, threadId, chat, selectThread, adoptThread, closeIfModal }: DrawerBodyProps) {
  const credential = useMyAssistantCredential()
  const settings = useAssistantSettings()
  const me = useMe()
  const thread = useAssistantThread(threadId)
  const ask = useAskSamQuestion({ onThread: (id) => adoptThread(chat, id) })
  // A question can still be on its way from before the drawer was last closed.
  const asking = useIsMutating({ mutationKey: keys.askSam }) > 0
  const labels = useContextLabels(context)
  const [text, setText] = useState('')
  const [awaitingId, setAwaitingId] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const composerId = useId()

  const messages = useMemo(() => thread.data?.messages ?? [], [thread.data])
  const pending = threadPending(thread.data) || ask.isPending || asking
  const ready = credential.data?.configured === true && settings.data?.enabled === true
  const loading = credential.isPending || settings.isPending
  const loadError = credential.error ?? settings.error
  const lostConnection = threadId !== null && thread.isError && thread.data !== undefined

  // The answer this session asked for, once written, is read out once.
  const awaited = awaitingId ? messages.find((m) => m.id === awaitingId) : undefined
  const announcement = awaited && awaited.status !== 'pending' ? spokenText(awaited) : ''

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length, pending])

  const send = (question: string) => {
    const q = question.trim()
    if (q === '' || pending || !ready) return
    ask.mutate(
      { threadId, text: q.slice(0, MAX_QUESTION), context },
      {
        onSuccess: (t) => {
          setAwaitingId(t.messages.findLast((m) => m.role === 'assistant')?.id ?? null)
          setText((current) => (current.trim() === q ? '' : current))
        },
        onError: () => {
          void credential.refetch()
          void settings.refetch()
          if (threadId) void thread.refetch()
        },
      },
    )
  }

  const switchTo = (id: string | null) => {
    ask.reset()
    setAwaitingId(null)
    selectThread(id)
  }

  const lastQuestion = messages.findLast((m) => m.role === 'user')?.text ?? ''
  const last = messages.at(-1)

  let body: ReactNode
  if (loading) {
    body = <p role="status" className="text-sm text-ink/80">Loading…</p>
  } else if (loadError) {
    body = (
      <p role="alert" className="text-sm font-medium text-status-r">
        Could not load Ask SAM: {loadError.message}
      </p>
    )
  } else if (!settings.data?.enabled) {
    body = (
      <Card pose="concerned" title="Ask SAM is turned off for this organization.">
        <p>
          {me.data?.role === 'admin' ? (
            <>
              You can turn it on in{' '}
              <Link to="/admin/assistant" className="font-medium text-accent-deep underline" onClick={closeIfModal}>
                Admin → Ask SAM settings
              </Link>
              .
            </>
          ) : (
            'An admin can turn it on.'
          )}
        </p>
      </Card>
    )
  } else if (!credential.data?.configured) {
    body = <SetupCard onNavigate={closeIfModal} />
  } else if (threadId && thread.isPending) {
    body = <p role="status" className="text-sm text-ink/80">Loading the chat…</p>
  } else if (threadId && thread.isError && !thread.data) {
    body = (
      <p role="alert" className="text-sm font-medium text-status-r">
        Could not load this chat: {thread.error.message}
      </p>
    )
  } else if (messages.length === 0) {
    body = (
      <div>
        <div className="flex items-start gap-3">
          <Sam pose="happy" className="size-12 shrink-0" />
          <p className="text-sm leading-relaxed text-ink/80">
            Hi, I’m SAM. Ask me why a number moved, how a metric is measured, or what to look at next. I read the
            same data you can see, and I never change anything.
          </p>
        </div>
        <ul aria-label="Suggested questions" className="mt-4 flex flex-col gap-2">
          {starters(context, labels).map((s) => (
            <li key={s}>
              <button
                type="button"
                disabled={pending}
                onClick={() => send(s)}
                className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-left text-sm hover:border-accent hover:bg-white disabled:opacity-60"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  } else {
    body = (
      <ol aria-label="Conversation" className="flex flex-col gap-4">
        {messages.map((m: AssistantMessage) => (
          <AssistantMessageItem
            key={m.id}
            message={m}
            onRetry={m === last && m.status === 'error' && lastQuestion ? () => send(lastQuestion) : undefined}
          />
        ))}
      </ol>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(text)
    }
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    send(text)
  }
  const focusOnMount = useCallback((el: HTMLTextAreaElement | null) => {
    // Focus moves from the drawer itself to the composer as soon as it can.
    if (el && document.activeElement?.hasAttribute('data-ask-sam')) el.focus()
  }, [])

  return (
    <>
      <div className="flex items-center gap-3 border-b border-ink/10 bg-white px-4 py-3">
        <Sam pose={pending ? 'thinking' : 'mark'} className={clsx('size-10 shrink-0', pending && 'ov-sam-think')} />
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-lg font-semibold leading-tight text-accent-deep">Ask SAM</Dialog.Title>
          <p className="text-xs text-ink/70">Your guide to the scorecard</p>
        </div>
        {ready && <ThreadSwitcher currentId={threadId} onSelect={switchTo} />}
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" className="rounded-md p-1.5 text-ink hover:bg-cream">
            <X aria-hidden="true" className="size-5" />
          </button>
        </Dialog.Close>
      </div>

      {labels.chip && (
        <div className="border-b border-ink/10 bg-white/60 px-4 py-2">
          <p className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/30 bg-white px-2.5 py-1 text-xs font-medium text-accent-deep">
            <Target aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only">Looking at: </span>
            <span className="truncate">{labels.chip}</span>
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {body}
        <div ref={endRef} />
      </div>

      <div role="status">
        {lostConnection && (
          <p className="flex items-center gap-2 border-t border-ink/10 bg-white px-4 py-2 text-sm text-ink/80">
            <WifiOff aria-hidden="true" className="size-4 shrink-0 text-status-r" />
            Lost connection to SAM. Retrying…
          </p>
        )}
      </div>

      <p data-testid="sam-live" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {ready && (
        <form onSubmit={onSubmit} className="border-t border-ink/10 bg-white px-4 pb-3 pt-2">
          {ask.isError && (
            <p role="alert" className="mb-2 rounded-md border border-status-r/40 bg-status-r-bg px-3 py-2 text-sm text-ink">
              {ask.error.message}
            </p>
          )}
          <label htmlFor={composerId} className="sr-only">
            Ask SAM a question
          </label>
          <div className="flex items-end gap-2 rounded-xl border border-ink/30 bg-white p-1.5 focus-within:border-accent-deep focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent-deep">
            <textarea
              id={composerId}
              ref={focusOnMount}
              rows={2}
              maxLength={MAX_QUESTION}
              value={text}
              placeholder="Ask about a metric, a status, or the method…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-ink/60 focus-visible:outline-none"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={pending || text.trim() === ''}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white hover:bg-accent-deep disabled:opacity-50"
            >
              <SendHorizontal aria-hidden="true" className="size-4" />
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink/70">
            Enter to send, Shift+Enter for a new line. SAM reads data and never changes it.
          </p>
        </form>
      )}
    </>
  )
}

function Card({ pose, title, children }: { pose: 'happy' | 'concerned'; title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-ink/15 bg-white p-4 text-sm">
      <Sam pose={pose} className="size-12" />
      <h3 id={titleId} className="mt-2 text-base font-semibold text-accent-deep">
        {title}
      </h3>
      <div className="mt-1 space-y-2 text-ink/80">{children}</div>
    </section>
  )
}

function SetupCard({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Card pose="happy" title="Add your Claude API key to use SAM">
      <p>SAM answers with your own key, so you choose what it costs. Setting it up takes a minute.</p>
      <p className="flex items-start gap-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-deep" />
        <span>{PRIVACY_LINE}</span>
      </p>
      <p className="pt-1">
        <Link to="/settings/ask-sam" className={clsx(primaryButton, 'inline-block')} onClick={onNavigate}>
          Set up Ask SAM
        </Link>
      </p>
    </Card>
  )
}

function ThreadSwitcher({ currentId, onSelect }: { currentId: string | null; onSelect: (id: string | null) => void }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label="Recent chats"
        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-ink hover:bg-cream"
      >
        <History aria-hidden="true" className="size-4" />
        <span className="hidden sm:inline">Chats</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[80] max-h-80 w-72 overflow-y-auto rounded-md border border-ink/20 bg-white p-1 text-ink shadow-lg"
        >
          <DropdownMenu.Item
            onSelect={() => onSelect(null)}
            className={clsx('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm font-medium', menuItemHighlight)}
          >
            <SquarePen aria-hidden="true" className="size-4" />
            New chat
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-ink/15" />
          <RecentThreads currentId={currentId} onSelect={onSelect} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Mounted only while the menu is open, so the list is fetched fresh each time. */
function RecentThreads({ currentId, onSelect }: { currentId: string | null; onSelect: (id: string | null) => void }) {
  const threads = useAssistantThreads()
  const labelId = useId()
  const itemClass = clsx('flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm', menuItemHighlight)
  return (
    <DropdownMenu.Group aria-labelledby={labelId}>
      <DropdownMenu.Label id={labelId} className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink/80">
        Recent
      </DropdownMenu.Label>
      {threads.isPending && (
        <DropdownMenu.Item disabled className="px-2 py-1.5 text-sm text-ink/70">
          Loading…
        </DropdownMenu.Item>
      )}
      {threads.isError && (
        <DropdownMenu.Item disabled className="px-2 py-1.5 text-sm text-status-r">
          Could not load your chats.
        </DropdownMenu.Item>
      )}
      {threads.data?.length === 0 && (
        <DropdownMenu.Item disabled className="px-2 py-1.5 text-sm text-ink/70">
          No chats yet.
        </DropdownMenu.Item>
      )}
      {threads.data?.map((t) => (
        <DropdownMenu.Item key={t.id} onSelect={() => onSelect(t.id)} className={itemClass}>
          <Check aria-hidden="true" className={clsx('mt-0.5 size-4 shrink-0', t.id !== currentId && 'invisible')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{t.title}</span>
            <span className="block text-xs opacity-80">{formatDate(t.updatedAt)}</span>
          </span>
          {t.id === currentId && <span className="sr-only">(current)</span>}
        </DropdownMenu.Item>
      ))}
    </DropdownMenu.Group>
  )
}
