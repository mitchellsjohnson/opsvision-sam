import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, FileSpreadsheet, Loader2, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router'
import {
  useApplyRecords,
  useCreateImportUpload,
  useFiscalYearStartMonth,
  useImportTemplates,
  useInspect,
  useItems,
  useOrgUnits,
  useRecordTypes,
  useRecordsPreview,
  useScorecards,
  useVersions,
  type ApplyImportRequest,
  type ChangeSetPreview,
  type RecordTemplate,
  type RecordsInspectResult,
  type RecordsPreview,
} from '../../api/queries'
import { getConfig } from '../../config'
import { SelectField, linkButton, primaryButton, secondaryButton } from '../admin/formUi'
import { fileSize, putFile } from '../admin/importModel'
import { DropZone } from './DropZone'
import type { SubjectOption } from './NeedsInput'
import {
  APPLY_CONFLICT_TEXT,
  answersFor,
  answersUpdateTemplate,
  applyConflict,
  buildAnswers,
  contentTypeFor,
  dateQuestion,
  defaultAsOf,
  emptyAnswers,
  failureText,
  formatCount,
  mergeQuestions,
  noQuestions,
  partitionFiles,
  recognitionParts,
  type AnswerState,
  type Questions,
} from './recordsModel'
import { StoryPreview } from './StoryPreview'

/** A file the setup has already uploaded and mapped, previewed with its new template. */
export interface PreparedFile {
  importId: string
  filename: string
  template: RecordTemplate
  /** The ID and name the template is saved under when the import is applied. */
  saveAs: { id: string; name: string }
}

type Entry = { key: string; file: File; prepared?: undefined } | { key: string; file?: undefined; prepared: PreparedFile }

/** What one file can do right now, as the Apply bar needs it. */
type FileStatus =
  | { state: 'busy' }
  | { state: 'blocked' }
  | { state: 'nothing' }
  | { state: 'ready'; importId: string; body: ApplyImportRequest }
  | { state: 'applied' }

type Outcome =
  | { kind: 'applied'; records: NonNullable<ChangeSetPreview['records']> }
  /** Applied before, from another tab or a double submit. */
  | { kind: 'already' }
  | { kind: 'failed'; message: string }

type Phase =
  | { step: 'uploading' }
  | { step: 'reading' }
  | { step: 'setup'; importId: string; result: RecordsInspectResult }
  | { step: 'ready'; importId: string; result?: RecordsInspectResult }
  | { step: 'failed'; message: string }

const DEBOUNCE_MS = 300

function Spinner() {
  return <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
}

/** Leaf units and tracked items records can belong to, and every unit's and item's name by ID. */
export function useSubjects() {
  const units = useOrgUnits()
  const items = useItems()
  return useMemo(() => {
    const all = units.data?.units ?? []
    const parents = new Set(all.map((u) => u.parentId).filter(Boolean))
    const options: SubjectOption[] = [
      ...all.filter((u) => !parents.has(u.id) && !u.retiredFrom).map((u) => ({ id: u.id, name: u.name })),
      ...(items.data ?? []).map((i) => ({ id: i.id, name: i.name })),
    ].sort((a, b) => a.name.localeCompare(b.name))
    const names = new Map<string, string>([...all.map((u) => [u.id, u.name] as const), ...(items.data ?? []).map((i) => [i.id, i.name] as const)])
    return { options, names }
  }, [units.data, items.data])
}

/** Measure names by key across a scorecard's versions, newest first. */
export function useMeasureNames(scorecardId: string) {
  const versions = useVersions(scorecardId)
  return useMemo(() => {
    const out = new Map<string, string>()
    for (const v of versions.data?.versions ?? []) {
      for (const m of v.content.measures) if (!out.has(m.key)) out.set(m.key, m.name)
    }
    return out
  }, [versions.data])
}

function appliedText(records: NonNullable<ChangeSetPreview['records']>) {
  const c = records.counts
  return `Applied: ${formatCount(c.new)} new and ${formatCount(c.changed)} changed records.`
}

function FileImport({
  entry,
  scorecardId,
  outcome,
  refresh,
  onStatus,
  onRemove,
  onNeedsSetup,
}: {
  entry: Entry
  scorecardId: string
  outcome: Outcome | undefined
  /** Grows each time Apply finds the preview out of date; a change previews again. */
  refresh: number
  onStatus: (key: string, status: FileStatus) => void
  onRemove: (key: string) => void
  onNeedsSetup?: (file: File, result: RecordsInspectResult, importId: string) => void
}) {
  const headingId = useId()
  const navigate = useNavigate()
  const { mutateAsync: createUpload } = useCreateImportUpload()
  const { mutateAsync: inspect } = useInspect()
  const { mutateAsync: requestPreview } = useRecordsPreview()
  const templates = useImportTemplates()
  const recordTypes = useRecordTypes()
  const fy = useFiscalYearStartMonth()
  const subjects = useSubjects()
  const measureNames = useMeasureNames(scorecardId)

  const filename = entry.file ? entry.file.name : entry.prepared.filename
  const [phase, setPhase] = useState<Phase>(() =>
    entry.prepared ? { step: 'ready', importId: entry.prepared.importId } : { step: 'uploading' },
  )
  const [attempt, setAttempt] = useState(0)
  const [asOf, setAsOf] = useState(() => defaultAsOf(entry.file))
  const [q, setQ] = useState<{ questions: Questions; answers: AnswerState }>({ questions: noQuestions(), answers: emptyAnswers() })
  const [result, setResult] = useState<{ key: string; preview: RecordsPreview } | null>(null)
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const started = useRef(-1)
  const seq = useRef(0)
  const previewed = useRef(false)

  // Upload, then inspect: a recognized file goes to the preview, a new one to the setup.
  useEffect(() => {
    const file = entry.file
    if (!file || started.current === attempt) return
    started.current = attempt
    void (async () => {
      let stage: 'upload' | 'read' = 'upload'
      try {
        const contentType = contentTypeFor(file)
        const created = await createUpload({ filename: file.name, contentType })
        // The URL is pre-signed: it is called as is, without the API token.
        await putFile(new URL(created.uploadUrl, getConfig().apiUrl).toString(), file, contentType)
        stage = 'read'
        setPhase({ step: 'reading' })
        const res = await inspect(created.importId)
        setPhase(
          res.inspection.matchedTemplateId
            ? { step: 'ready', importId: created.importId, result: res }
            : { step: 'setup', importId: created.importId, result: res },
        )
      } catch (err) {
        setPhase({ step: 'failed', message: failureText(err, stage) })
      }
    })()
  }, [entry.file, attempt, createUpload, inspect])

  const importId = phase.step === 'ready' ? phase.importId : ''
  const inspection = phase.step === 'ready' ? phase.result?.inspection : undefined
  const matchedId = inspection?.matchedTemplateId ?? ''
  const saved = templates.data?.find((t) => t.id === matchedId)
  const template: RecordTemplate | undefined = entry.prepared?.template ?? (saved?.body as RecordTemplate | undefined)
  const templateName = entry.prepared?.saveAs.name ?? saved?.name ?? 'saved export'
  const recordType = recordTypes.data?.find((rt) => rt.id === template?.recordType)
  const answers = answersFor(q, scorecardId)
  const answersJson = JSON.stringify(buildAnswers(answers))
  const inline = entry.prepared ? JSON.stringify(entry.prepared.template) : ''
  const applied = outcome?.kind === 'applied' ? outcome.records : undefined
  const isApplied = applied !== undefined || outcome?.kind === 'already'
  const requestKey = JSON.stringify([scorecardId, matchedId, inline, asOf, answersJson, refresh, retry])

  // Preview now, then again 300 ms after the last answer or date change.
  useEffect(() => {
    if (importId === '' || isApplied) {
      // An applied import cannot be previewed; drop any answer still on its way.
      seq.current++
      return
    }
    const mine = ++seq.current
    const delay = previewed.current ? DEBOUNCE_MS : 0
    previewed.current = true
    const timer = setTimeout(async () => {
      const answers = JSON.parse(answersJson)
      const source = inline ? { template: JSON.parse(inline) as RecordTemplate } : { templateId: matchedId }
      try {
        const p = await requestPreview({ id: importId, body: { scorecardId, asOf, ...source, answers } })
        if (mine !== seq.current) return
        setResult({ key: requestKey, preview: p })
        setPreviewError(null)
        setQ((prev) => mergeQuestions(prev, p, scorecardId))
      } catch (err) {
        if (mine !== seq.current) return
        setPreviewError({ key: requestKey, message: failureText(err, 'preview') })
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [importId, isApplied, matchedId, inline, scorecardId, asOf, answersJson, requestKey, requestPreview])

  const preview = result?.preview
  const current = result !== null && result.key === requestKey
  const failedNow = !isApplied && previewError !== null && previewError.key === requestKey

  const status: FileStatus = (() => {
    if (isApplied) return { state: 'applied' }
    if (phase.step === 'setup' || phase.step === 'failed') return { state: 'blocked' }
    if (phase.step !== 'ready') return { state: 'busy' }
    if (failedNow) return { state: 'blocked' }
    if (!current || !preview) return { state: 'busy' }
    if (preview.story.nothingChanged) return { state: 'nothing' }
    const answers = JSON.parse(answersJson) as ApplyImportRequest['answers']
    // The plan of the preview on screen; the API refuses any other.
    const body: ApplyImportRequest = { planId: preview.planId, answers }
    if (entry.prepared) body.saveTemplate = entry.prepared.saveAs
    else if (answers && answersUpdateTemplate(answers) && saved) body.saveTemplate = { id: saved.id, name: saved.name }
    return { state: 'ready', importId, body }
  })()
  const statusJson = JSON.stringify(status)
  useEffect(() => {
    onStatus(entry.key, JSON.parse(statusJson) as FileStatus)
  }, [entry.key, statusJson, onStatus])

  const working =
    phase.step === 'uploading'
      ? 'Uploading…'
      : phase.step === 'reading'
        ? 'Reading the file…'
        : phase.step === 'ready' && !isApplied && !failedNow && !current
          ? preview
            ? 'Updating the preview…'
            : 'Working out what changes…'
          : ''

  const recognition = (() => {
    if (!preview) return null
    if (entry.prepared) {
      return (
        <p>
          Set up as your <em className="font-semibold not-italic text-accent-deep">{templateName}</em>.
        </p>
      )
    }
    const parts = recognitionParts({
      name: templateName,
      rows: inspection?.rowCount ?? 0,
      changed: preview.counts.new + preview.counts.changed,
      lastUpload: inspection?.lastUploadAsOf,
    })
    return (
      <p>
        {parts.lead}
        <em className="font-semibold not-italic text-accent-deep">{parts.name}</em>
        {parts.rest}
      </p>
    )
  })()

  return (
    <section aria-labelledby={headingId} className="ov-enter space-y-4 rounded-lg border border-ink/20 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileSpreadsheet aria-hidden="true" className="size-5 text-accent-deep" />
          <h3 id={headingId} className="font-semibold">
            {filename}
          </h3>
          {entry.file && <span className="text-sm text-ink/80">{fileSize(entry.file.size)}</span>}
        </div>
        {!isApplied && (
          <button type="button" className={linkButton} aria-label={`Remove ${filename}`} onClick={() => onRemove(entry.key)}>
            Remove
          </button>
        )}
      </div>

      <p role="status" className="flex min-h-5 items-center gap-2 text-sm font-medium">
        {working && (
          <>
            <Spinner />
            {working}
          </>
        )}
      </p>

      {applied && (
        <p className="flex items-center gap-2 font-medium text-status-g">
          <CheckCircle2 aria-hidden="true" className="size-5" />
          <span>{appliedText(applied)}</span>
        </p>
      )}
      {outcome?.kind === 'already' && (
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 aria-hidden="true" className="size-5 text-status-g" />
          <span>{APPLY_CONFLICT_TEXT.already_applied}. This upload is already on the scorecard.</span>
        </p>
      )}

      {outcome?.kind === 'failed' && (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{outcome.message}</span>
        </p>
      )}

      {phase.step === 'failed' && (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
            <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{phase.message}</span>
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setPhase({ step: 'uploading' })
              setAttempt((a) => a + 1)
            }}
          >
            Try again
          </button>
        </div>
      )}

      {phase.step === 'setup' && (
        <div className="space-y-2 rounded-md border border-accent/40 bg-cream p-4">
          <p className="font-semibold">We haven’t seen this file before</p>
          <p className="text-sm">
            Tell us once what its columns mean, and every upload after that goes straight to the preview.
          </p>
          <button
            type="button"
            className={primaryButton}
            onClick={() => {
              if (onNeedsSetup && entry.file) onNeedsSetup(entry.file, phase.result, phase.importId)
              else
                void navigate(`/admin/import/setup?upload=${encodeURIComponent(phase.importId)}`, {
                  state: { asOf: defaultAsOf(entry.file) } satisfies SetupState,
                })
            }}
          >
            Set up this file
          </button>
        </div>
      )}

      {failedNow && (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
            <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{previewError.message}</span>
          </p>
          <button type="button" className={secondaryButton} onClick={() => setRetry((r) => r + 1)}>
            Try again
          </button>
        </div>
      )}

      {preview && !isApplied && (
        <StoryPreview
          preview={preview}
          recognition={recognition}
          asOf={asOf}
          onAsOfChange={setAsOf}
          questions={q.questions}
          answers={answers}
          setAnswers={(update) => setQ((prev) => ({ ...prev, answers: update(answersFor(prev, scorecardId)) }))}
          recordType={recordType}
          fullExport={template?.fullExport ?? false}
          fiscalYearStartMonth={fy}
          names={subjects.names}
          subjectOptions={subjects.options}
          measureNames={measureNames}
          date={dateQuestion(inspection?.ambiguousDates ?? [], inspection?.headers ?? [], inspection?.samples ?? [])}
        />
      )}
    </section>
  )
}

/** What the Import page hands the setup with an upload it could not place. */
export interface SetupState {
  /** The as-of date the file starts with. */
  asOf: string
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export interface RecordsImportProps {
  /** The scorecard previews evaluate; when absent, the tenant's scorecard (or a choice of them). */
  scorecardId?: string
  /** Files dropped before the import opened, e.g. on the scorecard page. */
  initialFiles?: readonly File[]
  /** Files the setup has uploaded and mapped. */
  prepared?: readonly PreparedFile[]
  /** Replaces the default hand-off to the setup page for an unrecognized file. */
  onNeedsSetup?: (file: File, result: RecordsInspectResult, importId: string) => void
  /** Told whether any file has a preview that is not applied yet (or is still on its way). */
  onPendingChange?: (pending: boolean) => void
  /**
   * Take files dropped anywhere on the page, so the browser never opens one
   * in place of the app; `onPageDrop` is told when files arrive that way.
   */
  catchPageDrops?: boolean
  onPageDrop?: () => void
}

/**
 * The records import: drop exports (several at once), read what each changes,
 * answer what it asks, then one Apply applies every ready file in order.
 */
export function RecordsImport({
  scorecardId: fixedScorecard,
  initialFiles = [],
  prepared = [],
  onNeedsSetup,
  onPendingChange,
  catchPageDrops = false,
  onPageDrop,
}: RecordsImportProps) {
  const scorecards = useScorecards()
  const apply = useApplyRecords()
  const [rejectedFiles, setRejectedFiles] = useState(() => partitionFiles(initialFiles).rejected)
  const [entries, setEntries] = useState<Entry[]>(() => [
    ...prepared.map((p) => ({ key: `p-${p.importId}`, prepared: p })),
    ...partitionFiles(initialFiles).accepted.map((file, i) => ({ key: `i-${i}`, file })),
  ])
  const added = useRef(0)
  const chooseRef = useRef<HTMLButtonElement>(null)
  const summaryRef = useRef<HTMLParagraphElement>(null)
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({})
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [staleCounts, setStaleCounts] = useState<Record<string, number>>({})
  const [applying, setApplying] = useState(false)
  const [summary, setSummary] = useState({ text: '', ok: true })
  const [chosenScorecard, setChosenScorecard] = useState('')

  const list = scorecards.data?.scorecards ?? []
  const scorecardId = fixedScorecard ?? (chosenScorecard || list[0]?.id || '')

  const onStatus = useCallback((key: string, status: FileStatus) => {
    setStatuses((prev) => ({ ...prev, [key]: status }))
  }, [])

  const addFiles = useCallback((files: File[]) => {
    setSummary({ text: '', ok: true })
    const keyed = files.map((file) => ({ key: `d-${++added.current}`, file }))
    setEntries((prev) => [...prev, ...keyed])
  }, [])

  // A file dropped outside the drop zone is taken too (the drop zone stops its own drops).
  const pageDrop = useRef(onPageDrop)
  useEffect(() => {
    pageDrop.current = onPageDrop
  })
  useEffect(() => {
    if (!catchPageDrops) return
    const nativeInput = (e: Event) => e.target instanceof HTMLInputElement && e.target.type === 'file'
    const over = (e: DragEvent) => {
      if (hasFiles(e) && !nativeInput(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || nativeInput(e) || e.defaultPrevented) return
      e.preventDefault()
      const { accepted, rejected } = partitionFiles(Array.from(e.dataTransfer?.files ?? []))
      setRejectedFiles(rejected)
      if (accepted.length > 0) addFiles(accepted)
      if (accepted.length + rejected.length > 0) pageDrop.current?.()
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [catchPageDrops, addFiles])

  function remove(key: string) {
    setEntries((prev) => prev.filter((e) => e.key !== key))
    setStatuses((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    chooseRef.current?.focus()
  }

  const live = entries.map((e) => ({ entry: e, status: statuses[e.key] ?? ({ state: 'busy' } as FileStatus) }))
  const ready = live.filter((x) => x.status.state === 'ready')
  const busy = live.some((x) => x.status.state === 'busy')
  const allNothing = live.length > 0 && live.every((x) => x.status.state === 'nothing')
  const pending = busy || ready.length > 0
  useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])

  async function applyAll() {
    setApplying(true)
    setSummary({ text: '', ok: true })
    let done = 0
    let failed = 0
    for (const { entry, status } of ready) {
      if (status.state !== 'ready') continue
      try {
        const res = await apply.mutateAsync({ id: status.importId, body: status.body })
        if (res.records) setOutcomes((prev) => ({ ...prev, [entry.key]: { kind: 'applied', records: res.records! } }))
        done++
      } catch (err) {
        const conflict = applyConflict(err)
        if (conflict === 'already_applied') {
          setOutcomes((prev) => ({ ...prev, [entry.key]: { kind: 'already' } }))
          done++
          continue
        }
        failed++
        if (conflict === 'preview_out_of_date') setStaleCounts((prev) => ({ ...prev, [entry.key]: (prev[entry.key] ?? 0) + 1 }))
        setOutcomes((prev) => ({
          ...prev,
          [entry.key]: { kind: 'failed', message: conflict ? APPLY_CONFLICT_TEXT[conflict] : failureText(err, 'apply') },
        }))
      }
    }
    setApplying(false)
    const parts: string[] = []
    if (done > 0) parts.push(`Applied ${done === 1 ? '1 file' : `${done} files`}. The scorecard now shows the new numbers.`)
    if (failed > 0) parts.push(`${failed === 1 ? '1 file' : `${failed} files`} still need${failed === 1 ? 's' : ''} attention.`)
    setSummary({ text: parts.join(' '), ok: failed === 0 })
    // The Apply button goes away once every file is applied; keep focus on what happened.
    setTimeout(() => summaryRef.current?.focus(), 0)
  }

  return (
    <div className="space-y-4">
      {!fixedScorecard && list.length > 1 && (
        <SelectField
          label="Scorecard"
          hint="The previews show changes on this scorecard."
          className="max-w-sm"
          value={scorecardId}
          options={list.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(e) => setChosenScorecard(e.target.value)}
        />
      )}
      <DropZone chooseRef={chooseRef} hasFilesAlready={entries.length > 0} onFiles={addFiles} />
      {rejectedFiles.length > 0 && (
        <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-3 text-sm font-medium text-status-r">
          <ul>
            {rejectedFiles.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {scorecardId !== '' && entries.length > 0 && (
        <ul className="space-y-4">
          {entries.map((entry) => (
            <li key={entry.key}>
              <FileImport
                entry={entry}
                scorecardId={scorecardId}
                outcome={outcomes[entry.key]}
                refresh={staleCounts[entry.key] ?? 0}
                onStatus={onStatus}
                onRemove={remove}
                onNeedsSetup={onNeedsSetup}
              />
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-lg border border-ink/20 bg-white/95 p-3 shadow-sm">
          {allNothing ? (
            <p className="text-sm font-medium">Nothing changed since your last upload</p>
          ) : ready.length > 0 || busy || applying ? (
            <>
              {/* Kept focusable while applying, so focus stays put; the live region says what is happening. */}
              <button
                type="button"
                className={`${primaryButton} aria-disabled:opacity-60`}
                disabled={!applying && (busy || ready.length === 0)}
                aria-disabled={applying ? true : undefined}
                onClick={() => {
                  if (!applying) void applyAll()
                }}
              >
                {applying ? 'Applying…' : 'Apply'}
              </button>
              <p role="status" className="flex items-center gap-2 text-sm text-ink/80">
                {(busy || applying) && <Spinner />}
                {applying
                  ? 'Applying… your files go in one at a time.'
                  : busy
                    ? 'Getting every preview ready…'
                    : ready.length > 1
                      ? `Applies ${ready.length} files in order. They aren’t brought in until then.`
                      : 'Your file isn’t brought in until you apply.'}
              </p>
            </>
          ) : null}
          <p
            ref={summaryRef}
            tabIndex={-1}
            role="status"
            aria-label="Import result"
            className={summary.text ? `basis-full text-sm font-medium ${summary.ok ? 'text-status-g' : 'text-ink'}` : 'sr-only'}>
            {summary.text}
          </p>
        </div>
      )}
    </div>
  )
}

const dangerButton =
  'rounded-md bg-status-r px-3 py-1.5 text-sm font-medium text-white hover:bg-status-r/90 disabled:opacity-60'

/**
 * The records import in a dialog, for the scorecard page. Closing it with
 * previews not yet applied asks first: they would be lost.
 */
export function UploadRecordsDialog({
  open,
  onOpenChange,
  scorecardId,
  initialFiles,
  returnFocusTo,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scorecardId: string
  initialFiles: readonly File[]
  /** Where focus goes on close; the dialog may open from a drop, without a trigger. */
  returnFocusTo: RefObject<HTMLElement | null>
}) {
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const resumeFocus = useRef<HTMLElement | null>(null)

  function requestOpenChange(next: boolean) {
    if (next || !pending) {
      onOpenChange(next)
      return
    }
    resumeFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConfirming(true)
  }

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocusTo.current?.focus()
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(96vw,60rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-cream p-6 shadow-xl">
          <Dialog.Title className="pr-8 text-lg font-semibold text-accent-deep">Upload records</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink/80">
            Drop your tracker exports to see what changes on this scorecard. Nothing is brought in until you apply.
          </Dialog.Description>
          <div className="mt-4">
            <RecordsImport scorecardId={scorecardId} initialFiles={initialFiles} onPendingChange={setPending} />
          </div>
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" className="absolute right-3 top-3 rounded-md p-1 hover:bg-white">
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>

          <Dialog.Root open={confirming} onOpenChange={setConfirming}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
              <Dialog.Content
                role="alertdialog"
                onCloseAutoFocus={(e) => {
                  e.preventDefault()
                  resumeFocus.current?.focus()
                }}
                className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl"
              >
                <Dialog.Title className="text-lg font-semibold text-accent-deep">Discard these uploads?</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-ink/80">
                  Nothing from them has been applied yet. To see these previews again, you’d drop the files again.
                </Dialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <button type="button" className={secondaryButton}>
                      Keep reviewing
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className={dangerButton}
                    onClick={() => {
                      // Focus goes back to the page, not into the dialog that is closing.
                      resumeFocus.current = null
                      setConfirming(false)
                      onOpenChange(false)
                    }}
                  >
                    Discard
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
