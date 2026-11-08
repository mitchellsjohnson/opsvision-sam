import { AlertTriangle, CheckCircle2, Loader2, PartyPopper, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../../api/errors'
import {
  useApplyRecords,
  useCreateVersion,
  useFiscalYearStartMonth,
  useMe,
  useOrgLevels,
  usePutRecordType,
  usePutVersion,
  useRecordsPreview,
  type ImportTemplate,
  type Methodology,
  type MethodologyVersion,
  type RecordType,
  type RecordsPreview,
} from '../../../api/queries'
import { currentMonth } from '../../../lib/period'
import { labelOfMonth, sameList } from '../../admin/adminModel'
import { TextField, linkButton, primaryButton, secondaryButton } from '../../admin/formUi'
import { PublishDialog } from '../../admin/PublishDialog'
import { useMeasureNames, useSubjects } from '../RecordsImport'
import { APPLY_CONFLICT_TEXT, applyConflict, failureText, formatCount, mergeQuestions, type AnswerState, type Questions } from '../recordsModel'
import { StoryPreview } from '../StoryPreview'
import { usePresetPlan } from './StepCalculate'
import {
  NEW_TYPE,
  answersFrom,
  chosenType,
  draftContent,
  draftNeeded,
  metricsChanged,
  pluralName,
  successText,
  templateFrom,
  trackedFromMonth,
  typeName,
  typePriorities,
  uniqueTemplate,
  type PresetContext,
  type StepProps,
} from './wizardModel'

const DEBOUNCE_MS = 300

/** What the setup saved before Apply, kept across Back and Next so nothing is created twice. */
export class Artifacts {
  type?: RecordType
  draft?: { version: MethodologyVersion; base: Methodology; sc: string }
  private chain: Promise<unknown> = Promise.resolve()

  /** Runs `job` after any earlier one, so a repeated run finds what the last one saved. */
  queue<T>(job: (saved: Artifacts) => Promise<T>): Promise<T> {
    const run = this.chain.then(
      () => job(this),
      () => job(this),
    )
    this.chain = run.catch(() => undefined)
    return run
  }
}

/** What Apply did, for the success view. */
export interface Applied {
  typeId: string
  typeName: string
  source: string
  sc: string
  asOf: string
  changed: number
  newRecords: number
  templateName: string
  /** The draft holding the new calculations; absent when none were chosen. */
  draft?: MethodologyVersion
  /** Names of measures (and metrics) the draft makes come from records. */
  draftChanges: string[]
}

function Spinner() {
  return <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
}

function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The measures a draft newly derives from records, and the metrics it adds, by name. */
function draftChanges(base: Methodology, next: Methodology): string[] {
  const was = new Map(base.measures.map((m) => [m.key, m]))
  const measures = next.measures
    .filter((m) => m.source === 'derived' && was.get(m.key)?.source !== 'derived')
    .map((m) => m.name || m.key)
  const metrics = next.metrics.filter((m) => !base.metrics.some((b) => b.key === m.key)).map((m) => `the metric ${m.name || m.key}`)
  return [...measures, ...metrics]
}

type Prep = { key: string; status: 'working' } | { key: string; status: 'ready'; draftId?: string } | { key: string; status: 'failed'; message: string }

export function StepPreview({
  state,
  update,
  recordTypes,
  importId,
  templates,
  artifacts,
  questions,
  setQuestions,
  asOf,
  setAsOf,
  applied,
  onApplied,
  onTypeSaved,
  footer,
}: StepProps & {
  importId: string
  templates: readonly ImportTemplate[]
  artifacts: Artifacts
  questions: Questions
  setQuestions: (q: Questions) => void
  asOf: string
  setAsOf: (asOf: string) => void
  applied: Applied | null
  onApplied: (a: Applied) => void
  onTypeSaved: (id: string) => void
  footer: (primary: ReactNode, note?: ReactNode) => ReactNode
}) {
  const fiscal = useFiscalYearStartMonth()
  const me = useMe()
  const levels = useOrgLevels()
  const plan = usePresetPlan(state, recordTypes)
  const sc = plan.sc
  const subjects = useSubjects()
  const measureNames = useMeasureNames(sc)
  const { mutateAsync: putType } = usePutRecordType()
  const { mutateAsync: createVersion } = useCreateVersion(sc)
  const { mutateAsync: putVersion } = usePutVersion(sc)
  const { mutateAsync: requestPreview } = useRecordsPreview()
  const apply = useApplyRecords()

  const name = typeName(state, recordTypes)
  const rt = chosenType(state, recordTypes)
  const typeId = rt?.id ?? ''
  const picks = plan.choices.filter((c) => plan.chosen.includes(c.id)).map((c) => ({ id: c.id, keyPrefix: c.keyPrefix }))
  const deepest = [...(levels.data ?? [])].sort((a, b) => b.depth - a.depth)[0]
  const statusKeys = (me.data?.tenant?.statusScale ?? []).map((s) => s.key)
  const needsContext = picks.length > 0
  const contextReady = !needsContext || (levels.data !== undefined && me.data !== undefined)
  const contextFailed = needsContext && !contextReady && (levels.isError || me.isError)
  const prepKey = JSON.stringify({
    type: state.recordType === NEW_TYPE ? [typeId, rt?.name, rt?.priorities] : typeId,
    sc,
    picks,
    priorities: typePriorities(state, recordTypes),
    completed: Boolean(state.columns.completedAt),
  })
  const [prep, setPrep] = useState<Prep>({ key: '', status: 'working' })
  const [attempt, setAttempt] = useState(0)

  // Save what the preview needs first: a new record type, and the draft with the chosen calculations.
  useEffect(() => {
    if (applied || plan.loading || !contextReady) return
    const want = state.recordType === NEW_TYPE ? chosenType(state, recordTypes) : undefined
    const ctx: PresetContext = {
      recordType: typeId,
      recordTypeName: name,
      priorities: typePriorities(state, recordTypes),
      statusKeys,
      reportedAt: deepest ? [{ kind: 'level' as const, id: deepest.id }] : [],
      hasCompleted: Boolean(state.columns.completedAt),
    }
    const source = plan.inForce ?? plan.versions[0]
    const cloneFrom = source?.id
    const sourceContent = source?.content ?? { categories: [], measures: [], metrics: [] }
    let live = true
    const run = async (a: Artifacts): Promise<string | undefined> => {
      if (want) {
        const mine = a.type?.id === want.id ? a.type : undefined
        const savedType =
          mine && mine.name === want.name && sameList(mine.priorities, want.priorities)
            ? mine
            : await putType({
                ...want,
                attributes: mine?.attributes ?? [],
                trackedFrom: mine?.trackedFrom ?? {},
                revision: mine?.revision ?? 0,
              })
        a.type = savedType
        onTypeSaved(savedType.id)
      }
      // Presets that change nothing (their measures already come from records) need no draft.
      const base = a.draft && a.draft.sc === sc ? a.draft.base : sourceContent
      if (!draftNeeded(base, picks, ctx)) return undefined
      if (!a.draft || a.draft.sc !== sc) {
        const created = await createVersion({ name: `${pluralName(name)} from records`, ...(cloneFrom ? { cloneFrom } : {}) })
        a.draft = { version: created, base: created.content, sc }
      }
      const content = draftContent(a.draft.base, picks, ctx)
      if (JSON.stringify(content) !== JSON.stringify(a.draft.version.content)) {
        a.draft.version = await putVersion({ v: a.draft.version.id, body: { revision: a.draft.version.revision, content } })
      }
      return a.draft.version.id
    }
    artifacts.queue(run).then(
      (draftId) => live && setPrep({ key: prepKey, status: 'ready', draftId }),
      (err: unknown) =>
        live &&
        setPrep({
          key: prepKey,
          status: 'failed',
          message:
            err instanceof ApiError && err.status === 409
              ? 'Something changed while we were saving your setup. Try again.'
              : 'We couldn’t get your setup ready. Try again in a moment.',
        }),
    )
    return () => {
      live = false
    }
    // prepKey covers everything the run reads from the wizard's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepKey, attempt, applied, plan.loading, contextReady])

  // Then preview now, and again 300 ms after the last change.
  const [preview, setPreview] = useState<{ key: string; preview: RecordsPreview } | null>(null)
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null)
  const [applyError, setApplyError] = useState('')
  const [alreadyApplied, setAlreadyApplied] = useState(false)
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLDivElement>(null)
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)
  const previewed = useRef(false)
  const latest = useRef<{ questions: Questions; answers: AnswerState }>({ questions, answers: state.answers })
  useEffect(() => {
    latest.current = { questions, answers: state.answers }
  })

  const ready = prep.key === prepKey && prep.status === 'ready'
  const draftId = ready ? prep.draftId : undefined
  // The saved name comes with Apply; the previewed template keeps one, so typing it does not re-preview.
  const template = { ...templateFrom(state), name: `${pluralName(name)} export` }
  const templateJson = JSON.stringify(template)
  const answersJson = JSON.stringify(answersFrom(state))
  const requestKey = JSON.stringify([importId, sc, asOf, templateJson, answersJson, ready ? (draftId ?? '') : null, retry])

  useEffect(() => {
    if (!ready || applied) {
      seq.current++
      return
    }
    const mine = ++seq.current
    const delay = previewed.current ? DEBOUNCE_MS : 0
    previewed.current = true
    const timer = setTimeout(async () => {
      try {
        const p = await requestPreview({
          id: importId,
          body: {
            scorecardId: sc,
            asOf,
            template: JSON.parse(templateJson),
            answers: JSON.parse(answersJson),
            ...(draftId ? { draftVersionId: draftId } : {}),
          },
        })
        if (mine !== seq.current) return
        setPreview({ key: requestKey, preview: p })
        setPreviewError(null)
        const merged = mergeQuestions(latest.current, p, sc)
        setQuestions(merged.questions)
        if (JSON.stringify(merged.answers) !== JSON.stringify(latest.current.answers)) {
          const asked = latest.current.questions
          update((s) => ({ ...s, answers: mergeQuestions({ questions: asked, answers: s.answers }, p, sc).answers }))
        }
      } catch (err) {
        if (mine !== seq.current) return
        setPreviewError({ key: requestKey, message: failureText(err, 'preview') })
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [ready, applied, importId, sc, asOf, templateJson, answersJson, draftId, requestKey, requestPreview, setQuestions, update])

  const shown = preview?.preview
  const current = preview !== null && preview.key === requestKey
  const failedNow = previewError !== null && previewError.key === requestKey
  const prepFailed = prep.key === prepKey && prep.status === 'failed' ? prep.message : ''

  const doneRef = useRef<HTMLDivElement>(null)

  async function doApply() {
    const saveName = state.templateName.trim()
    if (saveName === '') {
      setNameError('Enter a name for this setup.')
      nameRef.current?.querySelector('input')?.focus()
      return
    }
    if (!current || !shown) return
    setApplyError('')
    const save = uniqueTemplate(saveName, templates)
    try {
      const res = await apply.mutateAsync({
        id: importId,
        // The plan of the preview on screen; the API refuses any other.
        body: { planId: shown.planId, answers: JSON.parse(answersJson), saveTemplate: { id: save.id, name: saveName } },
      })
      const draft = draftId ? artifacts.draft : undefined
      onApplied({
        typeId,
        typeName: name,
        source: state.source.trim(),
        sc,
        asOf,
        changed: metricsChanged(shown),
        newRecords: res.records?.counts.new ?? shown.counts.new,
        templateName: saveName,
        draft: draft?.version,
        draftChanges: draft ? draftChanges(draft.base, draft.version.content) : [],
      })
      setTimeout(() => doneRef.current?.focus(), 0)
    } catch (err) {
      const conflict = applyConflict(err)
      if (conflict === 'already_applied') {
        setApplyError('')
        setAlreadyApplied(true)
        return
      }
      if (conflict === 'preview_out_of_date') setRetry((r) => r + 1)
      setApplyError(conflict ? APPLY_CONFLICT_TEXT[conflict] : failureText(err, 'apply'))
    }
  }

  if (applied) return <Success applied={applied} recordTypes={recordTypes} fiscal={fiscal} doneRef={doneRef} />
  if (alreadyApplied) {
    return (
      <div className="space-y-4">
        <p role="status" className="flex items-center gap-2 font-medium">
          <CheckCircle2 aria-hidden="true" className="size-5 text-status-g" />
          {APPLY_CONFLICT_TEXT.already_applied}. This upload is already on the scorecard.
        </p>
        <Link to="/admin/import" className={secondaryButton}>
          Back to Import
        </Link>
      </div>
    )
  }

  const working = contextFailed
    ? ''
    : !ready && !prepFailed
    ? 'Getting your preview ready…'
    : ready && !current && !failedNow
      ? shown
        ? 'Updating the preview…'
        : 'Working out what changes…'
      : ''

  return (
    <div className="space-y-5">
      <div ref={nameRef}>
        <TextField
          label="Save this setup as"
          hint="You’ll see this name when next month’s upload is recognized."
          className="max-w-md"
          value={state.templateName}
          errors={nameError ? [nameError] : []}
          onChange={(e) => {
            const templateName = e.target.value
            setNameError('')
            update((s) => ({ ...s, templateName, nameEdited: true }))
          }}
        />
      </div>

      <p role="status" className="flex min-h-5 items-center gap-2 text-sm font-medium">
        {working && (
          <>
            <Spinner />
            {working}
          </>
        )}
      </p>

      {contextFailed && (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
            <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>We couldn’t load your organization’s settings. Try again in a moment.</span>
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              if (levels.isError) void levels.refetch()
              if (me.isError) void me.refetch()
            }}
          >
            Try again
          </button>
        </div>
      )}

      {(prepFailed || failedNow) && (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
            <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{prepFailed || previewError?.message}</span>
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => (prepFailed ? setAttempt((n) => n + 1) : setRetry((n) => n + 1))}
          >
            Try again
          </button>
        </div>
      )}

      {shown && (
        <section aria-labelledby="setup-preview-h" className="space-y-3">
          <h3 id="setup-preview-h" className="text-lg font-semibold">
            What this upload brings in
          </h3>
          <StoryPreview
            preview={shown}
            recognition={
              <p>
                The first upload of your <em className="font-semibold not-italic text-accent-deep">{state.templateName.trim() || 'new export'}</em>
                {draftId ? ', with the new calculations from your draft.' : '.'}
              </p>
            }
            asOf={asOf}
            onAsOfChange={setAsOf}
            questions={questions}
            answers={state.answers}
            setAnswers={(change) => update((s) => ({ ...s, answers: change(s.answers) }))}
            recordType={rt}
            fullExport={state.fullExport}
            fiscalYearStartMonth={fiscal}
            names={subjects.names}
            subjectOptions={subjects.options}
            measureNames={measureNames}
            date={null}
          />
        </section>
      )}

      {applyError && (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-status-r">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{applyError}</span>
        </p>
      )}

      {footer(
        <button
          type="button"
          className={`${primaryButton} px-5 py-2 aria-disabled:opacity-60`}
          disabled={!apply.isPending && (!current || !shown)}
          aria-disabled={apply.isPending ? true : undefined}
          onClick={() => {
            if (!apply.isPending) void doApply()
          }}
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
        </button>,
        <span role="status" className="text-sm text-ink/80">
          {apply.isPending ? 'Applying…' : 'Your file isn’t brought in until you apply.'}
        </span>,
      )}
    </div>
  )
}

function Success({
  applied,
  recordTypes,
  fiscal,
  doneRef,
}: {
  applied: Applied
  recordTypes: readonly RecordType[]
  fiscal: number
  doneRef: RefObject<HTMLDivElement | null>
}) {
  const [published, setPublished] = useState({ text: '', ok: true })
  const rt = recordTypes.find((t) => t.id === applied.typeId)
  const month = trackedFromMonth(rt, applied.source, applied.asOf, fiscal)
  const draft = applied.draft
  const noun = applied.newRecords === 1 ? applied.typeName.trim().toLowerCase() || 'record' : pluralName(applied.typeName).toLowerCase()
  return (
    <div className="space-y-5">
      <div
        ref={doneRef}
        tabIndex={-1}
        role="status"
        className="ov-pop flex items-start gap-4 rounded-lg border-2 border-status-g bg-status-g-bg p-5"
      >
        <PartyPopper aria-hidden="true" className="size-9 shrink-0 text-status-g" />
        <div className="space-y-1">
          <p className="text-lg font-semibold">
            {successText(applied.typeName, applied.changed, { waitsForPublish: draft !== undefined })}
          </p>
          <p className="text-sm">
            {formatCount(applied.newRecords)} new {noun} saved, and your{' '}
            {applied.templateName} setup is remembered: next month, drop the same export on the Import page and it goes
            straight to the preview.
          </p>
        </div>
      </div>

      {draft && !published.text && (
        <div className="space-y-2 rounded-lg border border-accent/40 bg-cream p-4">
          <p className="font-medium">Your new calculations start once you publish them.</p>
          {applied.draftChanges.length > 0 && (
            <p className="text-sm">
              Publishing {draft.name} makes {andList(applied.draftChanges)} come from your records, from{' '}
              {labelOfMonth(month, fiscal)}.
            </p>
          )}
          <PublishDialog
            sc={applied.sc}
            version={draft}
            fiscal={fiscal}
            now={currentMonth(fiscal)}
            disabled={false}
            triggerLabel="Publish now"
            defaultMonth={month}
            onPublished={(message, ok) =>
              setPublished({ text: ok ? `${message} The scorecard now shows numbers from your records.` : message, ok })
            }
          />
        </div>
      )}
      <p
        role="status"
        className={published.text ? `flex items-start gap-2 font-medium ${published.ok ? 'text-status-g' : 'text-ink'}` : 'sr-only'}
      >
        {published.text &&
          (published.ok ? (
            <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-y" />
          ))}
        {published.text}
      </p>

      <div className="flex flex-wrap gap-3">
        <Link to="/admin/import" className={secondaryButton}>
          Back to Import
        </Link>
        <Link to={`/scorecards/${encodeURIComponent(applied.sc)}`} className={linkButton}>
          Open the scorecard
        </Link>
      </div>
    </div>
  )
}
