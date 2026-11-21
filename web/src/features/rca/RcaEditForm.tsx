import clsx from 'clsx'
import { AlertCircle, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  useDeleteMetricSummary,
  useMetricSummaryDraft,
  usePutMetricSummary,
  type CellAttribution,
  type MetricSummary,
  type MetricSummaryConflict,
  type MetricSummaryDraft,
  type RcaLink,
} from '../../api/queries'
import { ApiError } from '../../api/errors'
import { Sam } from '../../ui/Sam'
import { inputClass, primaryButton, secondaryButton } from '../admin/formUi'
import { PasteLinks } from './PasteLinks'
import { codePoints, linksBytes, RCA_LINKS_BYTES, RCA_LINKS_MAX, RCA_MAX, safeHref } from './rcaText'
import { SamSuggestion } from './SamSuggestion'
import { useSummaryPeriodLabel } from './SummarySection'
import { useWhyCardAnnounce } from './WhyCardProvider'

const MSG = {
  text: 'Write what drove this metric this month',
  tooLong: 'Write up to 280 characters',
  https: 'Use a link that starts with https://',
  title: 'Add a title for this link',
  duplicate: 'This link is already listed',
  count: `Up to ${RCA_LINKS_MAX} links`,
  budget: 'These links are too long together; shorten or remove some',
} as const

let rowSeq = 0

interface LinkRow {
  id: number
  title: string
  url: string
}

interface RowErrors {
  title?: string
  url?: string
}

interface Problems {
  text?: string
  links?: string
  rows: Record<number, RowErrors>
}

function toRows(links: RcaLink[]): LinkRow[] {
  return links.map((l) => ({ id: rowSeq++, ...l }))
}

function filled(rows: LinkRow[]): LinkRow[] {
  return rows.filter((r) => r.title.trim() !== '' || r.url.trim() !== '')
}

function toLinks(rows: LinkRow[]): RcaLink[] {
  return filled(rows).map((r) => ({ title: r.title.trim(), url: r.url.trim() }))
}

function sameLinks(a: RcaLink[], b: RcaLink[]): boolean {
  return a.length === b.length && a.every((l, i) => l.title === b[i]?.title && l.url === b[i]?.url)
}

/** The checks of spec §8.2 the browser can make; the server checks again. */
function check(text: string, rows: LinkRow[]): Problems {
  const problems: Problems = { rows: {} }
  if (text.trim() === '') problems.text = MSG.text
  else if (codePoints(text) > RCA_MAX) problems.text = MSG.tooLong
  const seen = new Set<string>()
  for (const r of filled(rows)) {
    const e: RowErrors = {}
    const href = safeHref(r.url.trim())
    if (!href) e.url = MSG.https
    else if (seen.has(href)) e.url = MSG.duplicate
    if (href) seen.add(href)
    if (r.title.trim() === '') e.title = MSG.title
    if (e.title || e.url) problems.rows[r.id] = e
  }
  if (filled(rows).length > RCA_LINKS_MAX) problems.links = MSG.count
  else if (linksBytes(toLinks(rows)) > RCA_LINKS_BYTES) problems.links = MSG.budget
  return problems
}

/** What SAM drafts from, in the suggestion's words: `from 3 services' attribution and 4 incidents`. */
function draftSources(a: CellAttribution | undefined, s: MetricSummary): string {
  if (!a) return 'from the attribution'
  const parts: string[] = []
  if (a.children.length > 0) {
    const noun = /^\d+ of \d+ (.+?) (below|over|not)\b/.exec(s.requirementReason ?? a.gap.headline)?.[1] ?? 'contributors'
    parts.push(`${a.children.length} ${noun}' attribution`)
  }
  if (a.incidentsTotal > 0) parts.push(`${a.incidentsTotal} ${a.incidentsTotal === 1 ? 'incident' : 'incidents'}`)
  else {
    const missed = /^(\d+) of \d+ (.+) missed$/.exec(a.recordsSummary ?? '')
    if (missed) parts.push(`${missed[1]} missed ${missed[2]}`)
    else if (a.recordsTotal > 0) parts.push(`${a.recordsTotal} ${a.recordsTotal === 1 ? 'record' : 'records'}`)
  }
  return parts.length > 0 ? `from ${parts.join(' and ')}` : 'from the gap alone'
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="mt-1 flex items-start gap-1 text-xs font-medium leading-4 text-status-r">
      <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        <span className="sr-only">Error: </span>
        {message}
      </span>
    </p>
  )
}

export interface RcaEditFormProps {
  scorecardId: string
  /**
   * The metric's exec summary with its whole text and every link
   * (`getMetricSummary`), or its unwritten slot: the starting text and the
   * revision saved against.
   */
  summary: MetricSummary
  /** The card's attribution, for what SAM drafts from. */
  attribution?: CellAttribution
  /** SAM is on for the organization: offer `Draft with SAM`. */
  samEnabled: boolean
  /** Start a SAM draft as the form opens (`Draft with SAM` from the card). */
  startDraft?: boolean
  onDone: (result: 'saved' | 'deleted', summary: MetricSummary | null) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * The exec summary editor (spec §10.3–§10.4), for admins only
 * (`summary.canEdit`; nothing renders for anyone else): plain text up to 280
 * code points and up to 25 https links in 16 KB, with `Paste links`.
 */
export function RcaEditForm(props: RcaEditFormProps) {
  if (!props.summary.canEdit) return null
  return <EditForm {...props} />
}

function EditForm({ scorecardId, summary, attribution, samEnabled, startDraft = false, onDone, onCancel, onDirtyChange }: RcaEditFormProps) {
  const id = useId()
  const announce = useWhyCardAnnounce()
  const period = useSummaryPeriodLabel(summary.period)
  const ref = { metric: summary.metricKey, period: summary.period }
  const written = summary.state === 'written' || summary.state === 'stale'

  const [text, setText] = useState(written ? (summary.text ?? '') : '')
  const [rows, setRows] = useState<LinkRow[]>(() => toRows(written ? summary.links : []))
  const [base, setBase] = useState({
    text: written ? (summary.text ?? '') : '',
    links: written ? summary.links : [],
    revision: written ? (summary.revision ?? 0) : 0,
  })
  const [pasting, setPasting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [server, setServer] = useState<Problems>({ rows: {} })
  const [failure, setFailure] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ current: MetricSummary | null } | null>(null)
  const [yourText, setYourText] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<MetricSummaryDraft | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const put = usePutMetricSummary(scorecardId)
  const del = useDeleteMetricSummary(scorecardId)
  const drafting = useMetricSummaryDraft(scorecardId)
  const abortDraft = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const count = codePoints(text)
  const over = count - RCA_MAX
  const problems = check(text, rows)
  const dirty = text !== base.text || !sameLinks(toLinks(rows), base.links)
  const busy = put.isPending || del.isPending

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => textareaRef.current?.focus(), [])
  useEffect(() => () => abortDraft.current?.abort(), [])
  useEffect(() => {
    if (confirmDelete) keepRef.current?.focus()
  }, [confirmDelete])

  const draftWithSam = () => {
    abortDraft.current?.abort()
    const controller = new AbortController()
    abortDraft.current = controller
    setSuggestion(null)
    drafting.mutate(
      { ...ref, signal: controller.signal },
      {
        onSuccess: (d) => {
          if (d.text === undefined) return
          setSuggestion(d)
          announce('Draft ready')
        },
      },
    )
  }
  const cancelDraft = () => {
    abortDraft.current?.abort()
    drafting.reset()
  }
  const startedDraft = useRef(false)
  useEffect(() => {
    if (!startDraft || !samEnabled || startedDraft.current) return
    startedDraft.current = true
    draftWithSam()
    // Once, as the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draftError = drafting.isError && !isAbort(drafting.error) ? drafting.error.message : drafting.data?.error

  const fail = (e: unknown, rowsSent: LinkRow[]) => {
    if (e instanceof ApiError && e.status === 409) {
      setConflict({ current: (e.body as MetricSummaryConflict | undefined)?.current ?? null })
      setYourText(text)
      return
    }
    if (e instanceof ApiError && e.status === 400 && e.details.length > 0) {
      const next: Problems = { rows: {} }
      for (const d of e.details) {
        const m = /^links\[(\d+)\]\.(title|url)$/.exec(d.path)
        const row = m ? rowsSent[Number(m[1])] : undefined
        if (row && m) next.rows[row.id] = { ...next.rows[row.id], [m[2] as 'title' | 'url']: d.message }
        else if (d.path === 'links') next.links = d.message
        else if (d.path === 'text') next.text = d.message
        else setFailure(d.message)
      }
      setServer(next)
      return
    }
    const message = e instanceof Error ? e.message : String(e)
    setFailure(e instanceof ApiError && e.status === 403 ? message : `Couldn't save the exec summary: ${message}`)
  }

  const save = () => {
    setSubmitted(true)
    setFailure(null)
    setServer({ rows: {} })
    if (problems.text || problems.links || Object.keys(problems.rows).length > 0) {
      const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ;(first ?? textareaRef.current)?.focus()
      return
    }
    const sent = filled(rows)
    put.mutate(
      { ...ref, text: text.normalize('NFC').trim(), links: toLinks(rows), expectedRevision: base.revision },
      {
        onSuccess: (saved) => {
          setConflict(null)
          onDone('saved', saved)
        },
        onError: (e) => fail(e, sent),
      },
    )
  }

  const remove = () => {
    setFailure(null)
    del.mutate(
      { ...ref, expectedRevision: base.revision },
      {
        onSuccess: () => onDone('deleted', null),
        onError: (e) => {
          setConfirmDelete(false)
          fail(e, [])
        },
      },
    )
  }

  const showTheirs = () => {
    const current = conflict?.current ?? null
    const theirs = { text: current?.text ?? '', links: current?.links ?? [], revision: current?.state === 'missing' || current?.state === 'optional' ? 0 : (current?.revision ?? 0) }
    setText(theirs.text)
    setRows(toRows(theirs.links))
    setBase(theirs)
    setConflict(null)
    setUndo(null)
  }

  const textError = server.text ?? (submitted ? problems.text : undefined)
  const rowError = (row: LinkRow, field: 'title' | 'url'): string | undefined =>
    server.rows[row.id]?.[field] ??
    (submitted || touched.has(`${field}-${row.id}`) ? problems.rows[row.id]?.[field] : undefined)
  const linksError = server.links ?? problems.links
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)))
  const describe = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined

  const hintId = `${id}-hint`
  const counterId = `${id}-count`
  const textErrId = `${id}-text-err`
  const linksErrId = `${id}-links-err`

  return (
    <form
      ref={formRef}
      aria-label="Edit exec summary"
      className="mt-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label htmlFor={`${id}-text`} className="text-sm font-semibold leading-5">
          Exec summary for {summary.metricName}, {period}
        </label>
        {samEnabled && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className={clsx(secondaryButton, 'inline-flex h-7 items-center gap-1.5 px-2 py-0 text-xs')}
              disabled={drafting.isPending}
              onClick={draftWithSam}
            >
              <Sam pose={drafting.isPending ? 'thinking' : 'mark'} className={clsx('size-4', drafting.isPending && 'ov-sam-think')} />
              {drafting.isPending ? 'Drafting…' : 'Draft with SAM'}
            </button>
            {drafting.isPending && (
              <button
                type="button"
                aria-label="Cancel draft"
                className="h-7 rounded-md px-2 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
                onClick={cancelDraft}
              >
                Cancel
              </button>
            )}
          </span>
        )}
      </div>
      <p id={hintId} className="text-xs leading-4 text-ink/70">
        Plain text, up to 280 characters, for executives. Say what drove the month and what is not explained.
      </p>

      {draftError && (
        <p role="alert" className="mt-2 text-xs leading-4 text-status-r">
          {draftError}{' '}
          <Link to="/settings/ask-sam" className="font-medium text-accent-deep underline">
            My settings → Ask SAM
          </Link>
        </p>
      )}
      {suggestion?.text !== undefined && suggestion.text !== '' && (
        <SamSuggestion
          text={suggestion.text}
          sources={draftSources(attribution, summary)}
          warnings={suggestion.warnings}
          onUse={() => {
            setUndo(text)
            setText(suggestion.text ?? '')
            setSuggestion(null)
            textareaRef.current?.focus()
          }}
          onDiscard={() => setSuggestion(null)}
        />
      )}

      <textarea
        ref={textareaRef}
        id={`${id}-text`}
        rows={3}
        dir="auto"
        maxLength={1200}
        value={text}
        aria-invalid={textError ? true : undefined}
        aria-describedby={describe(hintId, counterId, textError && textErrId)}
        className={clsx(inputClass, 'max-h-[136px] min-h-[76px] resize-none text-sm leading-5 [field-sizing:content]')}
        onChange={(e) => {
          setText(e.target.value)
          setUndo(null)
        }}
      />
      <div className="mt-1 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <FieldError id={textErrId} message={textError} />
          {undo !== null && (
            <button
              type="button"
              className="h-6 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
              onClick={() => {
                setText(undo)
                setUndo(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
        <p
          id={counterId}
          aria-live={count >= RCA_MAX - 20 ? 'polite' : undefined}
          className={clsx('shrink-0 text-xs leading-4 tabular-nums', over > 0 ? 'font-medium text-status-r' : 'text-ink/70')}
        >
          {over > 0 ? `${over} over` : `${count} / ${RCA_MAX}`}
        </p>
      </div>

      <fieldset className="mt-3" aria-describedby={linksError ? linksErrId : undefined}>
        <div className="flex items-baseline justify-between gap-2">
          <legend className="text-sm font-medium leading-5">
            Links <span className="font-normal text-ink/70">(optional)</span>
          </legend>
          <p className="shrink-0 text-xs leading-4 tabular-nums text-ink/70">
            {rows.length} / {RCA_LINKS_MAX} links
          </p>
        </div>
        <ul className="mt-1 space-y-2">
          {rows.map((row, n) => {
            const titleErr = rowError(row, 'title')
            const urlErr = rowError(row, 'url')
            const titleErrId = `${id}-l${row.id}-title-err`
            const urlErrId = `${id}-l${row.id}-url-err`
            const update = (patch: Partial<LinkRow>) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)))
            return (
              <li key={row.id} className="flex items-start gap-1">
                <div className="grid min-w-0 flex-1 gap-1 min-[480px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="min-w-0">
                    <input
                      type="text"
                      aria-label={`Link ${n + 1} title`}
                      placeholder="Title"
                      maxLength={80}
                      value={row.title}
                      aria-invalid={titleErr ? true : undefined}
                      aria-describedby={titleErr ? titleErrId : undefined}
                      className={clsx(inputClass, 'mt-0')}
                      onChange={(e) => update({ title: e.target.value })}
                      onBlur={() => touch(`title-${row.id}`)}
                    />
                    <FieldError id={titleErrId} message={titleErr} />
                  </div>
                  <div className="min-w-0">
                    <input
                      type="url"
                      inputMode="url"
                      aria-label={`Link ${n + 1} URL`}
                      placeholder="https://…"
                      maxLength={2048}
                      value={row.url}
                      aria-invalid={urlErr ? true : undefined}
                      aria-describedby={urlErr ? urlErrId : undefined}
                      className={clsx(inputClass, 'mt-0')}
                      onChange={(e) => update({ url: e.target.value })}
                      onBlur={() => touch(`url-${row.id}`)}
                    />
                    <FieldError id={urlErrId} message={urlErr} />
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove link ${n + 1}`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink/70 hover:bg-ink/[0.06] hover:text-ink"
                  onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </li>
            )
          })}
        </ul>
        <FieldError id={linksErrId} message={linksError} />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {rows.length < RCA_LINKS_MAX && (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
              onClick={() => setRows((rs) => [...rs, { id: rowSeq++, title: '', url: '' }])}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              Add link
            </button>
          )}
          {!pasting && (
            <button type="button" className={clsx(secondaryButton, 'h-7 px-2.5 py-0 text-xs')} onClick={() => setPasting(true)}>
              Paste links
            </button>
          )}
        </div>
        {pasting && (
          <PasteLinks
            existing={toLinks(rows)}
            onAdd={(links) => setRows((rs) => [...filled(rs), ...toRows(links)])}
            onClose={() => setPasting(false)}
          />
        )}
      </fieldset>
      <p className="mt-2 text-xs leading-4 text-ink/70">Imported incidents and records appear under Attribution; add anything else as a link.</p>

      {conflict && (
        <div role="alert" className="mt-3 rounded-md border border-status-r bg-status-r-bg px-2 py-1.5 text-xs leading-4 text-ink">
          <p className="font-medium">Someone else changed this exec summary while you were editing.</p>
          <button
            type="button"
            className="mt-1.5 h-7 rounded-md border border-ink/40 bg-white px-2.5 text-xs font-medium hover:bg-cream"
            onClick={showTheirs}
          >
            Show theirs
          </button>
        </div>
      )}
      {yourText !== null && (
        <section aria-label="Your text" className="mt-2 rounded-md border border-ink/15 bg-ink/[0.035] p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">Your text</p>
            <button
              type="button"
              className="h-6 rounded-md px-1.5 text-xs font-medium text-accent-deep hover:bg-white"
              onClick={() => void navigator.clipboard?.writeText(yourText)}
            >
              Copy
            </button>
          </div>
          <p dir="auto" className="mt-1 break-words text-sm leading-5">
            {yourText}
          </p>
        </section>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-xs font-medium leading-4 text-status-r">
          {failure}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-3">
        {confirmDelete ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <p className="w-full text-sm leading-5">
              {summary.requirement === 'required'
                ? `Delete this exec summary? ${period} can't be published again until a new one is written. The audit log keeps it.`
                : 'Delete this exec summary? The audit log keeps it.'}
            </p>
            <button
              type="button"
              className="h-8 rounded-md bg-status-r px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
              disabled={busy}
              onClick={remove}
            >
              Delete
            </button>
            <button ref={keepRef} type="button" className={clsx(secondaryButton, 'h-8')} onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </div>
        ) : (
          <>
            {base.revision > 0 && (
              <button
                type="button"
                className="mr-auto h-8 rounded-md px-2 text-sm font-medium text-status-r hover:bg-status-r-bg"
                onClick={() => setConfirmDelete(true)}
              >
                Delete exec summary
              </button>
            )}
            <button type="submit" className={clsx(primaryButton, 'h-8')} disabled={busy || over > 0 || problems.links !== undefined}>
              Save
            </button>
            <button type="button" className={clsx(secondaryButton, 'h-8')} onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    </form>
  )
}
