import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { Lock, Pencil, TriangleAlert } from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { useBlocker } from 'react-router'
import { ApiError } from '../../api/errors'
import { useEntry, useMe, usePreview, useSaveData, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { StatusBadge } from '../../ui/StatusBadge'
import { plainNumber } from '../scorecard/viewHelpers'
import {
  MAX_REASON_LENGTH,
  MAX_WRITES,
  analyze,
  commitDraft,
  describeSaved,
  draftOf,
  formatNumber,
  effectiveRow,
  omit,
  rowKey,
  savedOf,
  toWrite,
  type Analysis,
  type Base,
  type DataPoint,
  type DataWrite,
  type Draft,
  type EntryRow,
  type Field,
  type Saved,
} from './entryModel'
import { parseEntryValue, parsePaste } from './pasteParser'

type Cell = components['schemas']['Cell']

/** How long edits must rest before the preview is recomputed. */
export const PREVIEW_DEBOUNCE_MS = 400

export interface EntryGridProps {
  scorecardId: string
  scorecardName: string
  /** The month being entered, e.g. `2026-M10`. */
  period: string
  /** Human label for the month, e.g. `Oct 2026`. */
  periodLabel: string
}

/** A row joined with what is saved, what is typed, and what that means. */
interface Item {
  index: number
  key: string
  row: EntryRow
  saved: Saved
  draft: Draft
  /** Whether the person has edited this row; untouched rows are never analyzed. */
  touched: boolean
  analysis: Analysis
  /** The metric whose preview this row shows: the first one that uses the measure. */
  metricKey: string
}

interface Conflict {
  current?: DataPoint
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.value === b.value && a.reason === b.reason && a.na === b.na && a.baseRevision === b.baseRevision
}

function previewKey(metricKey: string, subjectId: string, period: string): string {
  return `${metricKey}|${subjectId}|${period}`
}

/** Messages for the writes a 400/403 response lists, by the row the write came from. */
function rowMessages(error: ApiError, sentKeys: string[]): Record<string, string> {
  const messages: Record<string, string> = {}
  for (const d of error.details) {
    const m = /^writes\[(\d+)\]/.exec(d.path)
    const key = m ? sentKeys[Number(m[1])] : undefined
    if (key !== undefined && messages[key] === undefined) messages[key] = d.message
  }
  return messages
}

function conflictsOf(error: ApiError): Record<string, Conflict> | null {
  const body = error.body as { conflicts?: { write?: DataWrite; current?: DataPoint }[] } | undefined
  if (error.status !== 409 || !Array.isArray(body?.conflicts)) return null
  const out: Record<string, Conflict> = {}
  for (const c of body.conflicts) {
    if (c.write) out[rowKey(c.write)] = { current: c.current }
  }
  return out
}

/** A saved value as text, for a row shown without inputs. */
function savedText(saved: Saved): string {
  if (saved.kind === 'value') return plainNumber(saved.value)
  if (saved.kind === 'na') return `not applicable (${saved.reason})`
  return '—'
}

const derivedBadge = 'ml-2 inline-flex rounded-full border border-accent/50 px-2 py-0.5 text-xs font-medium text-accent-deep'

const inputBase =
  'w-32 rounded-md border px-2 py-1 text-sm tabular-nums disabled:opacity-60'

/**
 * The data-entry grid for one month: a native table of inputs, one row per
 * measure and subject, grouped by the metric the measure feeds. It is built
 * to be faster than a spreadsheet: arrow keys and Enter move between rows,
 * blocks paste in, edits preview their effect, and one Save sends everything
 * together with the revisions the rows were loaded at.
 */
export function EntryGrid({ scorecardId, scorecardName, period, periodLabel }: EntryGridProps) {
  const entry = useEntry(scorecardId, period)
  if (entry.isPending) return <p role="status">Loading…</p>
  if (entry.isError) {
    return (
      <div role="alert" className="space-y-2">
        <p>Could not load the entry grid: {entry.error.message}</p>
        <button
          type="button"
          onClick={() => void entry.refetch()}
          className="rounded-md border border-ink/30 bg-white px-3 py-1 text-sm font-medium hover:bg-cream"
        >
          Retry
        </button>
      </div>
    )
  }
  if (entry.data.rows.length === 0) {
    return (
      <p className="text-sm text-ink/80">
        There is nothing to enter for {scorecardName} in {periodLabel}.
      </p>
    )
  }
  return (
    <GridBody
      scorecardId={scorecardId}
      scorecardName={scorecardName}
      period={period}
      periodLabel={periodLabel}
      rows={entry.data.rows}
    />
  )
}

function GridBody({
  scorecardId,
  scorecardName,
  period,
  periodLabel,
  rows,
}: EntryGridProps & { rows: EntryRow[] }) {
  const uid = useId()
  const tableRef = useRef<HTMLTableElement>(null)
  const me = useMe()
  const view = useView(scorecardId, { periods: [period] })
  const save = useSaveData(scorecardId)
  const preview = usePreview(scorecardId)

  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [bases, setBases] = useState<Record<string, Base>>({})
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({})
  const [serverMessages, setServerMessages] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<{ message: string; retry: boolean } | null>(null)
  const [status, setStatus] = useState('')
  /** The input being typed in; its problems are not shown until the person moves on. */
  const [typing, setTyping] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<{ writes: string; cells: Record<string, Cell> }>({
    writes: '',
    cells: {},
  })

  const metricNames = useMemo(
    () => new Map((view.data?.rows ?? []).map((r) => [r.metricKey, r.metricName])),
    [view.data],
  )
  const statusLabels = useMemo(
    () => new Map((me.data?.tenant?.statusScale ?? []).map((s) => [s.key, s.label])),
    [me.data],
  )

  const items = useMemo<Item[]>(
    () =>
      rows.map((fetched, index) => {
        const key = rowKey(fetched)
        const { row, saved } = effectiveRow(fetched, bases[key])
        const touched = key in drafts
        const draft = drafts[key] ?? draftOf(saved, row.revision)
        return {
          index,
          key,
          row,
          saved,
          draft,
          touched,
          // Only edited rows are analyzed, so saved data can never show as an error.
          analysis: touched ? analyze(draft, saved) : { dirty: false },
          metricKey: row.metricKeys[0] ?? '',
        }
      }),
    [rows, bases, drafts],
  )

  const dirtyItems = items.filter((i) => i.analysis.dirty)
  const writes = dirtyItems.map((i) => toWrite(i.row, i.draft, i.analysis) as DataWrite)
  const writesJson = JSON.stringify(writes)
  const issues = items.filter((i) => i.analysis.issue)
  const visibleIssues = issues.filter((i) => typing !== `${i.key}:${i.analysis.issue?.field}`)
  const conflictCount = Object.keys(conflicts).length
  const tooMany = writes.length > MAX_WRITES
  const hasUnsaved = writes.length > 0 || issues.length > 0
  const canEditAny = items.some((i) => i.row.canEdit)

  // Debounced preview of what the edits would do to the metrics.
  const { mutate: requestPreview } = preview
  useEffect(() => {
    if (writes.length === 0 || tooMany) return
    const timer = setTimeout(() => {
      requestPreview(
        { writes },
        {
          onSuccess: (result) => {
            const cells: Record<string, Cell> = {}
            for (const c of result.cells) {
              if (!c.ytd) cells[previewKey(c.metricKey, c.subjectId, c.period)] = c
            }
            setPreviewState({ writes: writesJson, cells })
          },
        },
      )
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `writes` is derived from `writesJson`; the JSON is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writesJson, tooMany, requestPreview])
  const previewStale = previewState.writes !== writesJson
  const showPreview = writes.length > 0

  // Leaving with unsaved edits: the browser's own prompt for reload/close, and
  // a dialog for in-app navigation (including changing month or scorecard).
  useEffect(() => {
    if (!hasUnsaved) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsaved])
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsaved &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  )

  const inputId = (index: number, field: Field) => `${uid}-${index}-${field}`
  const noteId = (index: number) => `${uid}-${index}-note`

  const setDraft = useCallback((key: string, draft: Draft) => {
    setDrafts((prev) => ({ ...prev, [key]: draft }))
    setServerMessages((prev) => (key in prev ? omit(prev, key) : prev))
  }, [])

  function inputs(column: Field): HTMLInputElement[] {
    const table = tableRef.current
    return table
      ? Array.from(table.querySelectorAll<HTMLInputElement>(`input[data-col="${column}"]:not([readonly])`))
      : []
  }

  /** Moves to the same column of the nearest editable row above or below. */
  function moveRow(from: HTMLInputElement, direction: 1 | -1) {
    const all = inputs(from.dataset.col as Field)
    const target =
      direction === 1
        ? all.find((c) => from.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
        : [...all].reverse().find((c) => from.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING)
    target?.focus()
  }

  function focusField(index: number, field: Field) {
    tableRef.current?.querySelector<HTMLInputElement>(`input[data-row-index="${index}"][data-col="${field}"]`)?.focus()
  }

  function onChange(item: Item, field: Field, e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value
    setStatus('') // a "Saved" or "Pasted" message is about the past, not these edits
    setTyping(`${item.key}:${field}`)
    if (field === 'value') {
      const next: Draft = { ...item.draft, value: text }
      // A number replaces not-applicable; other text (even invalid) leaves the reason alone.
      if (parseEntryValue(text).kind === 'value') {
        next.na = false
        next.reason = ''
      }
      setDraft(item.key, next)
    } else {
      const na = item.draft.na || (text.trim() !== '' && item.draft.value.trim() === '')
      setDraft(item.key, { ...item.draft, reason: text, na })
    }
  }

  function commit(item: Item) {
    setTyping(null)
    if (!item.touched) return item.draft // nothing was edited: leave the saved text alone
    const next = commitDraft(item.draft)
    if (next.value !== item.draft.value || next.na !== item.draft.na) setDraft(item.key, next)
    return next
  }

  function onKeyDown(item: Item, field: Field, e: KeyboardEvent<HTMLInputElement>) {
    const input = e.currentTarget
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'Enter': {
        e.preventDefault()
        const next = item.row.canEdit ? commit(item) : item.draft
        if (field === 'value' && next.na && next.reason.trim() === '' && item.row.canEdit) {
          focusField(item.index, 'reason') // not applicable needs a reason: ask for it
          return
        }
        moveRow(input, e.shiftKey ? -1 : 1)
        return
      }
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        if (item.row.canEdit) commit(item)
        moveRow(input, e.key === 'ArrowDown' ? 1 : -1)
        return
      case 'ArrowRight':
      case 'ArrowLeft': {
        // Only at the edge of the text, so the caret still moves within it.
        const { selectionStart: start, selectionEnd: end, value } = input
        const atEnd = start === value.length && end === value.length
        const atStart = start === 0 && end === 0
        if (e.key === 'ArrowRight' && field === 'value' && atEnd) {
          e.preventDefault()
          if (item.row.canEdit) commit(item)
          focusField(item.index, 'reason')
        } else if (e.key === 'ArrowLeft' && field === 'reason' && atStart) {
          e.preventDefault()
          focusField(item.index, 'value')
        }
        return
      }
      case 'Escape':
        if (!item.row.canEdit) return
        e.preventDefault()
        setTyping(null)
        setDrafts((prev) => omit(prev, item.key))
        return
    }
  }

  function onPaste(item: Item, field: Field, e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text/plain')
    const block = parsePaste(text)
    const single = block.length <= 1 && (block[0]?.length ?? 0) <= 1
    if (single) return // one value: let the input take it like typed text
    e.preventDefault()
    if (!item.row.canEdit) return

    // The block fills this row and the editable rows after it; read-only rows
    // are passed over without using up a line of the block.
    const targets = items.slice(item.index).filter((i) => i.row.canEdit)
    const twoColumns = field === 'value' && block.some((r) => r.length >= 2)
    const updates: Record<string, Draft> = {}
    const count = Math.min(block.length, targets.length)
    for (let n = 0; n < count; n++) {
      const target = targets[n] as Item
      const cells = block[n] as string[]
      const d = target.draft
      if (field === 'reason') {
        const reason = (cells[0] ?? '').trim()
        updates[target.key] = { ...d, reason, na: d.na || (reason !== '' && d.value.trim() === '') }
        continue
      }
      const raw = cells[0] ?? ''
      const parsed = parseEntryValue(raw)
      const reason = twoColumns ? (cells[1] ?? '').trim() : undefined
      if (parsed.kind === 'value') {
        updates[target.key] = { ...d, value: formatNumber(parsed.value), reason: reason ?? '', na: false }
      } else if (parsed.kind === 'na') {
        updates[target.key] = { ...d, value: '', reason: reason ?? d.reason, na: true }
      } else if (parsed.kind === 'empty') {
        const next = reason ?? d.reason
        updates[target.key] = { ...d, value: '', reason: next, na: reason === undefined ? d.na : next !== '' }
      } else {
        // Keep the text so it can be seen and fixed; it is an error, not a change.
        updates[target.key] = { ...d, value: raw.trim() }
      }
    }
    setTyping(null)
    setDrafts((prev) => ({ ...prev, ...updates }))
    setServerMessages((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(updates)) delete next[k]
      return next
    })
    const ignored = block.length - count
    const lastIndex = count > 0 ? (targets[count - 1] as Item).index : item.index
    const skipped = items.slice(item.index, lastIndex).filter((i) => !i.row.canEdit).length
    setStatus(
      `Pasted ${count} ${count === 1 ? 'row' : 'rows'}${
        skipped > 0 ? `; skipped ${skipped} read-only ${skipped === 1 ? 'row' : 'rows'}` : ''
      }${
        ignored > 0 ? `; ${ignored} more ${ignored === 1 ? 'row' : 'rows'} did not fit and ${ignored === 1 ? 'was' : 'were'} ignored` : ''
      }.`,
    )
  }

  function adopt(key: string, current: DataPoint | undefined) {
    const fetched = rows.find((r) => rowKey(r) === key)
    setBases((prev) => ({
      ...prev,
      [key]: {
        supersedes: Math.max(fetched?.revision ?? 0, current?.revision ?? 0),
        revision: current?.revision ?? 0,
        saved: current ? savedOf(current) : { kind: 'blank' },
      },
    }))
    setConflicts((prev) => omit(prev, key))
  }

  function keepMine(key: string) {
    const current = conflicts[key]?.current
    adopt(key, current)
    // The edit now builds on the version that conflicted, so the next Save replaces it.
    setDrafts((prev) => {
      const draft = prev[key]
      return draft ? { ...prev, [key]: { ...draft, baseRevision: current?.revision ?? 0 } } : prev
    })
  }

  function takeTheirs(key: string) {
    adopt(key, conflicts[key]?.current)
    setDrafts((prev) => omit(prev, key))
  }

  /** Use records: clears the typed value so the value records give comes back. */
  function restoreFromRecords(item: Item) {
    const { row } = item
    setBanner(null)
    setStatus('')
    save.mutate(
      { writes: [{ measureKey: row.measureKey, subjectId: row.subjectId, period: row.period, expectedRevision: row.revision, clear: true }] },
      {
        onSuccess: (result) => {
          setBases((prev) => {
            const next = { ...prev }
            for (const point of result.saved) {
              next[rowKey(point)] = {
                supersedes: Math.max(row.revision, point.revision),
                revision: point.revision,
                saved: point.deleted ? { kind: 'blank' } : savedOf(point),
              }
            }
            return next
          })
          setDrafts((prev) => omit(prev, item.key))
          setStatus(`${row.measureName}, ${row.subjectName} now uses the value from records.`)
        },
        onError: (error) => {
          const conflicting = error instanceof ApiError ? conflictsOf(error) : null
          if (conflicting) setConflicts((prev) => ({ ...prev, ...conflicting }))
          setBanner({
            message: conflicting
              ? 'Nothing was changed. This value was changed by someone else; choose Use theirs or Keep mine.'
              : `Nothing was changed. ${error instanceof Error ? error.message : 'Something went wrong.'}`,
            retry: false,
          })
        },
      },
    )
  }

  function revertAll() {
    setDrafts({})
    setConflicts({})
    setServerMessages({})
    setBanner(null)
    setTyping(null)
    setStatus('Discarded all unsaved changes.')
  }

  function doSave() {
    setBanner(null)
    setStatus('')
    setServerMessages({})
    const sentKeys = dirtyItems.map((i) => i.key)
    const sentWrites = writes
    const sentDrafts = new Map(dirtyItems.map((i) => [i.key, i.draft]))
    save.mutate(
      { writes: sentWrites },
      {
        onSuccess: (result) => {
          setBases((prev) => {
            const next = { ...prev }
            for (const point of result.saved) {
              const key = rowKey(point)
              const fetched = rows.find((r) => rowKey(r) === key)
              next[key] = {
                supersedes: Math.max(fetched?.revision ?? 0, point.revision),
                revision: point.revision,
                saved: savedOf(point),
              }
            }
            return next
          })
          // Clear only what was sent and not touched since. Edits made while the save
          // was in flight stay, rebased onto the revision just saved.
          const savedRevision = new Map(result.saved.map((p) => [rowKey(p), p.revision]))
          setDrafts((prev) => {
            const next: Record<string, Draft> = {}
            for (const [key, draft] of Object.entries(prev)) {
              const sent = sentDrafts.get(key)
              if (!sent) next[key] = draft
              else if (!sameDraft(sent, draft)) {
                next[key] = { ...draft, baseRevision: savedRevision.get(key) ?? draft.baseRevision }
              }
            }
            return next
          })
          setConflicts({})
          setStatus(`Saved ${sentWrites.length} ${sentWrites.length === 1 ? 'value' : 'values'}.`)
        },
        onError: (error) => {
          const conflicting = error instanceof ApiError ? conflictsOf(error) : null
          if (conflicting) {
            setConflicts(conflicting)
            const n = Object.keys(conflicting).length
            setBanner({
              message: `Nothing was saved. ${n} ${n === 1 ? 'value was' : 'values were'} changed by someone else; choose Use theirs or Keep mine for each.`,
              retry: false,
            })
          } else if (error instanceof ApiError && (error.status === 403 || error.status === 400)) {
            setServerMessages(rowMessages(error, sentKeys))
            setBanner({ message: `Nothing was saved. ${error.message}`, retry: false })
          } else {
            setBanner({
              message: `Nothing was saved. ${error instanceof Error ? error.message : 'Something went wrong.'}`,
              retry: true,
            })
          }
        },
      },
    )
  }

  const blockedReason = tooMany
    ? `Too many changes to save at once (${writes.length}); the limit is ${MAX_WRITES}. Save or discard some first.`
    : conflictCount > 0
      ? 'Resolve the conflicts before saving.'
      : issues.length > 0
        ? 'Fix the entries marked below before saving.'
        : ''
  const saveDisabled = writes.length === 0 || blockedReason !== '' || save.isPending

  const noteFor = (item: Item): string[] => {
    const notes: string[] = []
    const issue = item.analysis.issue
    if (issue && typing !== `${item.key}:${issue.field}`) notes.push(issue.message)
    const server = serverMessages[item.key]
    if (server) notes.push(server)
    return notes
  }

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-20 -mx-1 space-y-2 bg-cream px-1 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={doSave}
            disabled={saveDisabled}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : `Save changes (${writes.length})`}
          </button>
          <button
            type="button"
            onClick={revertAll}
            disabled={!hasUnsaved && conflictCount === 0}
            className="rounded-md border border-ink/30 bg-white px-3 py-2 text-sm font-medium hover:bg-cream disabled:opacity-50"
          >
            Discard changes
          </button>
          <p role="status" className="text-sm font-medium text-ink">
            {status}
          </p>
        </div>
        {blockedReason !== '' && (writes.length > 0 || issues.length > 0 || conflictCount > 0) && (
          <p className="text-sm text-ink/80">{blockedReason}</p>
        )}
        {!canEditAny && (
          <p className="text-sm text-ink/80">
            <Lock aria-hidden="true" size={14} className="mr-1 inline" />
            You can view these values but not change them.
          </p>
        )}
        {banner && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-status-r bg-status-r-bg px-3 py-2 text-sm text-ink">
            <p>{banner.message}</p>
            {banner.retry && (
              <button
                type="button"
                onClick={doSave}
                className="rounded-md border border-ink/30 bg-white px-3 py-1 font-medium hover:bg-cream"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {visibleIssues.length > 0 && (
          <div role="alert" className="rounded-md border border-status-r bg-status-r-bg px-3 py-2 text-sm text-ink">
            <p className="font-semibold">
              {visibleIssues.length === 1 ? '1 entry needs fixing' : `${visibleIssues.length} entries need fixing`}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {visibleIssues.map((i) => {
                const field = i.analysis.issue?.field ?? 'value'
                const id = inputId(i.index, field)
                return (
                  <li key={i.key}>
                    <a
                      href={`#${id}`}
                      className="font-medium underline"
                      onClick={(e) => {
                        e.preventDefault()
                        document.getElementById(id)?.focus()
                      }}
                    >
                      {i.row.measureName}, {i.row.subjectName}
                    </a>
                    : {i.analysis.issue?.message}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {preview.isError && showPreview && (
          <p className="text-sm text-ink/80">The preview could not be computed. You can still save.</p>
        )}
      </div>

      <div
        role="region"
        aria-label={`${scorecardName} entry grid`}
        // A scrolling region must be reachable by keyboard so wide tables can be panned (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-ink/20 bg-white"
      >
        <table ref={tableRef} className="w-full border-collapse text-sm">
          <caption className="px-3 py-2 text-left text-sm font-medium">
            {scorecardName}, {periodLabel}
          </caption>
          <thead>
            <tr className="border-b border-ink/30">
              <th scope="col" className="px-3 py-2 text-left font-semibold">Subject</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Measure</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Value</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Not-applicable reason</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Preview</th>
            </tr>
          </thead>
          {groupTbodies()}
        </table>
      </div>

      <Dialog.Root open={blocker.state === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content className="fixed left-1/2 top-1/3 z-50 w-full max-w-md -translate-x-1/2 rounded-md bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold text-accent-deep">Leave without saving?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm">
              You have unsaved changes for {periodLabel}. If you leave now they are lost.
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => blocker.reset?.()}
                className="rounded-md border border-ink/30 bg-white px-3 py-2 text-sm font-medium hover:bg-cream"
              >
                Stay and keep editing
              </button>
              <button
                type="button"
                onClick={() => blocker.proceed?.()}
                className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-deep"
              >
                Discard and leave
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )

  function groupTbodies() {
    // Consecutive rows that feed the same first metric share a group, as the API orders them.
    const groups: { key: string; items: Item[] }[] = []
    for (const item of items) {
      const last = groups[groups.length - 1]
      if (last && last.key === item.metricKey) last.items.push(item)
      else groups.push({ key: item.metricKey, items: [item] })
    }
    return groups.map((g, gi) => (
      <tbody key={`${g.key}-${gi}`} className="border-t border-ink/20">
        <tr className="bg-cream/60">
          <th scope="rowgroup" colSpan={5} className="px-3 py-2 text-left font-semibold text-accent-deep">
            {g.key === '' ? 'Not used by a metric' : (metricNames.get(g.key) ?? g.key)}
          </th>
        </tr>
        {g.items.map((item) => renderRow(item))}
      </tbody>
    ))
  }

  /** "From records", or for a typed value "Typed · records give 47" when records differ. */
  function derivedLabel(item: Item): string | null {
    const { row, saved } = item
    if (!row.derived) return null
    if (row.source === undefined || row.source === 'records') return 'From records'
    const differs = row.recordsValue !== undefined && !(saved.kind === 'value' && saved.value === row.recordsValue)
    return differs ? `Typed · records give ${plainNumber(row.recordsValue as number)}` : 'Typed'
  }

  function renderRow(item: Item) {
    const { row, draft, analysis } = item
    const readOnly = !row.canEdit
    const derived = derivedLabel(item)
    const typedOverRecords = row.derived === true && row.source !== undefined && row.source !== 'records'
    const dirty = analysis.dirty
    const conflict = conflicts[item.key]
    const notes = noteFor(item)
    const hasNote = notes.length > 0 || conflict !== undefined
    const cell = showPreview
      ? previewState.cells[previewKey(item.metricKey, row.subjectId, row.period)]
      : undefined

    const field = (name: Field, label: string) => {
      const issue = analysis.issue?.field === name && typing !== `${item.key}:${name}`
      return (
        <input
          id={inputId(item.index, name)}
          type="text"
          inputMode={name === 'value' ? 'decimal' : 'text'}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${label}, ${row.measureName}, ${row.subjectName}`}
          aria-invalid={issue || undefined}
          aria-readonly={readOnly || undefined}
          aria-describedby={hasNote ? noteId(item.index) : undefined}
          readOnly={readOnly}
          maxLength={name === 'reason' ? MAX_REASON_LENGTH : undefined}
          data-col={name}
          data-row-index={item.index}
          value={name === 'value' ? draft.value : draft.reason}
          onChange={(e) => onChange(item, name, e)}
          onKeyDown={(e) => onKeyDown(item, name, e)}
          onPaste={(e) => onPaste(item, name, e)}
          onFocus={(e) => !readOnly && e.currentTarget.select()}
          onBlur={() => !readOnly && commit(item)}
          className={clsx(
            inputBase,
            name === 'reason' && 'w-64',
            name === 'value' && 'text-right',
            readOnly && 'cursor-default border-dashed border-ink/40 bg-status-na-bg text-ink/80',
            !readOnly && !issue && !dirty && 'border-ink/40 bg-white',
            !readOnly && dirty && !issue && 'border-2 border-accent bg-cream',
            issue && 'border-2 border-status-r bg-status-r-bg',
          )}
        />
      )
    }

    return (
      <Fragment key={item.key}>
        <tr data-dirty={dirty || undefined} className={clsx('border-t border-ink/10', dirty && 'bg-cream/50')}>
          <th scope="row" className="px-3 py-2 text-left font-medium">
            {row.subjectName}
            {dirty && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-accent-deep">
                <Pencil aria-hidden="true" size={12} />
                <span className="sr-only">edited</span>
                <span aria-hidden="true">edited</span>
              </span>
            )}
            {readOnly && !derived && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-ink/80">
                <Lock aria-hidden="true" size={12} />
                <span>read-only</span>
              </span>
            )}
          </th>
          <td className="px-3 py-2">{row.measureName}</td>
          <td className="px-3 py-2">
            {derived && readOnly ? (
              <span className="tabular-nums">{savedText(item.saved)}</span>
            ) : (
              field('value', 'Value')
            )}
            {derived && <span className={derivedBadge}>{derived}</span>}
            {typedOverRecords && row.canEdit && (
              <button
                type="button"
                onClick={() => restoreFromRecords(item)}
                disabled={save.isPending}
                aria-label={`Use records, ${row.measureName}, ${row.subjectName}`}
                className="ml-2 rounded-md border border-ink/30 bg-white px-2 py-1 text-xs font-medium hover:bg-cream disabled:opacity-60"
              >
                Use records
              </button>
            )}
          </td>
          <td className="px-3 py-2">{derived && readOnly ? null : field('reason', 'Not-applicable reason')}</td>
          <td className={clsx('px-3 py-2', showPreview && previewStale && 'opacity-60')}>
            {cell ? (
              <span className="inline-flex items-center gap-2" aria-busy={previewStale || undefined}>
                <span className="tabular-nums">{cell.display || '—'}</span>
                {cell.status && <StatusBadge status={cell.status} label={statusLabels.get(cell.status)} />}
              </span>
            ) : (
              <span aria-hidden="true" className="text-ink/60">—</span>
            )}
          </td>
        </tr>
        {hasNote && (
          <tr id={noteId(item.index)} className="bg-white">
            <td colSpan={5} className="px-3 pb-2 text-sm">
              {notes.map((n) => (
                <p key={n} className="flex items-center gap-1 text-status-r">
                  <TriangleAlert aria-hidden="true" size={14} />
                  {n}
                </p>
              ))}
              {conflict && (
                <div className="flex flex-wrap items-center gap-2 text-ink">
                  <p className="flex items-center gap-1 font-medium">
                    <TriangleAlert aria-hidden="true" size={14} />
                    Changed by someone else: now {describeSaved(conflict.current, plainNumber)}
                  </p>
                  <button
                    type="button"
                    onClick={() => takeTheirs(item.key)}
                    aria-label={`Use theirs, ${row.measureName}, ${row.subjectName}`}
                    className="rounded-md border border-ink/30 bg-white px-2 py-1 text-xs font-medium hover:bg-cream"
                  >
                    Use theirs
                  </button>
                  <button
                    type="button"
                    onClick={() => keepMine(item.key)}
                    aria-label={`Keep mine, ${row.measureName}, ${row.subjectName}`}
                    className="rounded-md border border-ink/30 bg-white px-2 py-1 text-xs font-medium hover:bg-cream"
                  >
                    Keep mine
                  </button>
                </div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    )
  }
}
