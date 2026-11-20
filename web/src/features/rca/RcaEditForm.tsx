import clsx from 'clsx'
import { AlertCircle, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  useCellRcaDraft,
  useDeleteCellRca,
  usePutCellRca,
  type CellRca,
  type CellRcaConflict,
  type CellRcaDraft,
  type RcaLink,
  type RcaNote,
} from '../../api/queries'
import { ApiError } from '../../api/errors'
import { Sam } from '../../ui/Sam'
import { inputClass, primaryButton, secondaryButton } from '../admin/formUi'
import { codePoints, linksBytes, RCA_LINKS_BYTES, RCA_LINKS_MAX, RCA_MAX, safeHref } from './rcaText'
import { SamSuggestion } from './SamSuggestion'
import { useWhyCardAnnounce } from './WhyCardProvider'

const MSG = {
  text: 'Write what caused the gap',
  tooLong: 'Write up to 280 characters',
  https: 'Use a link that starts with https://',
  title: 'Add a title for this link',
  duplicate: 'This link is already listed',
  budget: 'These links are too long together; shorten or remove one',
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
  if (linksBytes(toLinks(rows)) > RCA_LINKS_BYTES) problems.links = MSG.budget
  return problems
}

/** What SAM drafts from, in the suggestion's words. */
function draftSources(rca: CellRca): string {
  const n = rca.incidentsTotal
  if (n > 0) return `from ${n} ${n === 1 ? 'incident' : 'incidents'}${rca.unexplained ? ' and the remainder' : ''}`
  const missed = /^(\d+) of \d+ (.+) missed$/.exec(rca.recordsSummary ?? '')
  if (missed) return `from ${missed[1]} missed ${missed[2]}`
  if (rca.records.length > 0) return `from ${rca.recordsTotal} ${rca.recordsTotal === 1 ? 'record' : 'records'}`
  if (rca.children.length > 0) return `from ${rca.children.length} ${rca.children.length === 1 ? 'contributor' : 'contributors'}`
  return 'from the gap alone'
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
  /** The cell being written: its note (if any) is the starting text and the revision saved against. */
  rca: CellRca
  /** SAM is on for the organization: offer `Draft with SAM`. */
  samEnabled: boolean
  /** Start a SAM draft as the form opens (`Draft with SAM` from the card). */
  startDraft?: boolean
  onDone: (result: 'saved' | 'deleted', note: RcaNote | null) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

/** The RCA editor (spec §10.3–§10.4): plain text up to 280 code points and up to five https links. */
export function RcaEditForm({ scorecardId, rca, samEnabled, startDraft = false, onDone, onCancel, onDirtyChange }: RcaEditFormProps) {
  const id = useId()
  const announce = useWhyCardAnnounce()
  const ref = { metric: rca.metricKey, subject: rca.subjectId, period: rca.period }

  const [text, setText] = useState(rca.note?.text ?? '')
  const [rows, setRows] = useState<LinkRow[]>(() => toRows(rca.note?.links ?? []))
  const [base, setBase] = useState({ text: rca.note?.text ?? '', links: rca.note?.links ?? [], revision: rca.note?.revision ?? 0 })
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [server, setServer] = useState<Problems>({ rows: {} })
  const [failure, setFailure] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ current: RcaNote | null } | null>(null)
  const [yourText, setYourText] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<CellRcaDraft | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const put = usePutCellRca(scorecardId)
  const del = useDeleteCellRca(scorecardId)
  const drafting = useCellRcaDraft(scorecardId)
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
      { ref, signal: controller.signal },
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
      setConflict({ current: (e.body as CellRcaConflict | undefined)?.current ?? null })
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
    setFailure(e instanceof ApiError && e.status === 403 ? message : `Couldn't save the RCA: ${message}`)
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
        onSuccess: (note) => {
          setConflict(null)
          onDone('saved', note)
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
    const theirs = { text: current?.text ?? '', links: current?.links ?? [], revision: current?.revision ?? 0 }
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
      aria-label="Edit RCA"
      className="mt-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label htmlFor={`${id}-text`} className="text-sm font-semibold leading-5">
          What caused the gap?
        </label>
        {samEnabled && rca.canEdit && (
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
        Plain text, up to 280 characters. Name the incidents or records; say what is not explained.
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
          sources={draftSources(rca)}
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
        <legend className="text-sm font-medium leading-5">
          Links <span className="font-normal text-ink/70">(optional, up to 5)</span>
        </legend>
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
        {rows.length < RCA_LINKS_MAX && (
          <button
            type="button"
            className="mt-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-xs font-medium text-accent-deep hover:bg-accent/[0.06]"
            onClick={() => setRows((rs) => [...rs, { id: rowSeq++, title: '', url: '' }])}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            Add link
          </button>
        )}
      </fieldset>
      <p className="mt-2 text-xs leading-4 text-ink/70">Incidents and records come from imports; add anything else as a link.</p>

      {conflict && (
        <div role="alert" className="mt-3 rounded-md border border-status-r bg-status-r-bg px-2 py-1.5 text-xs leading-4 text-ink">
          <p className="font-medium">Someone else changed this RCA while you were editing.</p>
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
            <p className="w-full text-sm leading-5">Delete this RCA? It is removed for everyone; the audit log keeps it.</p>
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
                Delete RCA
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
