import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useBlocker, useLocation, useSearchParams } from 'react-router'
import {
  useCreateImportUpload,
  useImportTemplates,
  useInspect,
  useItems,
  useOrgUnits,
  usePutImportTemplate,
  useRecordTypes,
  type RecordsInspectResult,
} from '../../../api/queries'
import { getConfig } from '../../../config'
import { errorsFrom } from '../../admin/adminModel'
import { FormError, linkButton, primaryButton, secondaryButton, useFocusOnError } from '../../admin/formUi'
import { putFile } from '../../admin/importModel'
import { DropZone } from '../DropZone'
import type { SetupState } from '../RecordsImport'
import { contentTypeFor, defaultAsOf, failureText, noQuestions, todayISO } from '../recordsModel'
import { StepCalculate } from './StepCalculate'
import { StepColumns, validateColumns } from './StepColumns'
import { Artifacts, StepPreview, type Applied } from './StepPreview'
import { StepProducts } from './StepProducts'
import { StepType, validateType } from './StepType'
import { StepValues, validateValues } from './StepValues'
import {
  SETUP_STEPS,
  STEP_HEADINGS,
  STEP_LABELS,
  TEMPLATE_STEPS,
  initialState,
  stateFromTemplate,
  templateFrom,
  type StepErrors,
  type StepId,
  type WizardState,
} from './wizardModel'

function Spinner() {
  return <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
}

/** Where you are: "Step 2 of 6: Columns" over an ordered list of the steps. */
function StepIndicator({ steps, index, finished }: { steps: readonly StepId[]; index: number; finished: boolean }) {
  const done = finished ? steps.length : index
  return (
    <nav aria-label="Setup steps" className="space-y-2">
      <p className="text-sm font-semibold text-accent-deep">
        {finished ? `All ${steps.length} steps done` : `Step ${index + 1} of ${steps.length}: ${STEP_LABELS[steps[index] ?? 'type']}`}
      </p>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-ink/10">
        <div
          className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: `${Math.round(((finished ? steps.length : index + 1) / steps.length) * 100)}%` }}
        />
      </div>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {steps.map((s, i) => {
          const isDone = i < done
          const isCurrent = i === index && !finished
          return (
            <li key={s} aria-current={isCurrent ? 'step' : undefined} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className={clsx(
                  'flex size-6 items-center justify-center rounded-full border text-xs font-semibold motion-safe:transition-colors',
                  isDone && 'border-accent bg-accent text-white',
                  isCurrent && 'border-accent-deep bg-white text-accent-deep ring-2 ring-accent/40',
                  !isDone && !isCurrent && 'border-ink/40 bg-white text-ink/80',
                )}
              >
                {isDone ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={clsx(isCurrent ? 'font-semibold text-accent-deep' : 'text-ink/80')}>{STEP_LABELS[s]}</span>
              {isDone && <span className="sr-only">(done)</span>}
              {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-ink/30 sm:w-6" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Footer({ cancelTo, cancelLabel, onBack, primary, note }: { cancelTo: string; cancelLabel: string; onBack?: () => void; primary?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-4">
      <Link to={cancelTo} className={linkButton}>
        {cancelLabel}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {note}
        {onBack && (
          <button type="button" className={`${secondaryButton} inline-flex items-center gap-1 px-4 py-2`} onClick={onBack}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </button>
        )}
        {primary}
      </div>
    </div>
  )
}

const dangerButton = 'rounded-md bg-status-r px-3 py-1.5 text-sm font-medium text-white hover:bg-status-r/90'

/**
 * The guided setup for an export OpsVision has not seen (spec §7.1): what the
 * file is, which column is which, what values mean, which products and teams
 * they are, what to calculate, then the preview and Apply. With `template=`,
 * it reopens the columns and values of a saved template instead.
 */
export function SetupWizard() {
  const [params, setParams] = useSearchParams()
  const handedOver = (useLocation().state as Partial<SetupState> | null)?.asOf
  const uploadId = params.get('upload') ?? ''
  const templateId = params.get('template') ?? ''
  const mode: 'setup' | 'template' = templateId !== '' ? 'template' : 'setup'
  const steps = mode === 'template' ? TEMPLATE_STEPS : SETUP_STEPS

  const recordTypes = useRecordTypes()
  const units = useOrgUnits()
  const items = useItems()
  const templates = useImportTemplates()
  const { mutateAsync: inspect } = useInspect()
  const { mutateAsync: createUpload } = useCreateImportUpload()
  const putTemplate = usePutImportTemplate()

  const [inspected, setInspected] = useState<{ id: string; result: RecordsInspectResult } | null>(null)
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [state, setState] = useState<WizardState | null>(null)
  const [reached, setReached] = useState(0)
  const [touched, setTouched] = useState(false)
  const [errors, setErrors] = useState<StepErrors>({})
  const [questions, setQuestions] = useState(noQuestions)
  const [asOf, setAsOf] = useState(() => handedOver ?? todayISO())
  const [applied, setApplied] = useState<Applied | null>(null)
  const [ownTypeId, setOwnTypeId] = useState('')
  const [savedMapping, setSavedMapping] = useState(false)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [artifacts] = useState(() => new Artifacts())
  const requested = useRef('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const doneRef = useRef<HTMLDivElement>(null)
  const { formRef, focusErrors } = useFocusOnError<HTMLDivElement>()

  // Read the uploaded file: its columns, guesses, values and products.
  useEffect(() => {
    const key = `${uploadId}:${loadAttempt}`
    if (uploadId === '' || requested.current === key) return
    requested.current = key
    void (async () => {
      try {
        setInspected({ id: uploadId, result: await inspect(uploadId) })
      } catch (err) {
        setLoadError({ id: uploadId, message: failureText(err, 'read') })
      }
    })()
  }, [uploadId, loadAttempt, inspect])

  const result = inspected?.id === uploadId ? inspected.result : null
  const saved = templates.data?.find((t) => t.id === templateId && t.profile === 'records')
  if (state === null && result && recordTypes.data && units.data && items.data && templates.data && (mode === 'setup' || saved)) {
    setState(
      saved
        ? stateFromTemplate({ template: saved, result, recordTypes: recordTypes.data })
        : initialState({ result, recordTypes: recordTypes.data, units: units.data.units, items: items.data, templates: templates.data }),
    )
  }

  function validate(id: StepId, s: WizardState): StepErrors {
    if (id === 'type') return validateType(s, recordTypes.data ?? [], ownTypeId)
    if (id === 'columns') return validateColumns(s)
    if (id === 'values') return validateValues(s)
    return {}
  }

  // The URL can name a later step than the answers allow (browser Back and
  // Forward skip Next): show the first earlier step that no longer passes, with its messages.
  const requestedIndex = steps.indexOf(params.get('step') as StepId)
  const wanted = state ? Math.min(Math.max(requestedIndex, 0), reached) : 0
  let index = wanted
  let blocked: StepErrors | null = null
  for (let i = 0; state && i < wanted; i++) {
    const errs = validate(steps[i] ?? 'type', state)
    if (Object.keys(errs).length > 0) {
      index = i
      blocked = errs
      break
    }
  }
  const step = steps[index] ?? steps[0] ?? 'type'
  const finished = applied !== null || savedMapping
  // Kept as the step's messages, so they stay once the URL names this step.
  if (blocked && JSON.stringify(blocked) !== JSON.stringify(errors)) setErrors(blocked)
  const blockedStep = blocked ? step : ''
  useEffect(() => {
    if (blockedStep === '') return
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.set('step', blockedStep)
        return p
      },
      { replace: true },
    )
    focusErrors()
    // focusErrors is a new function each render; only a newly blocked step matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedStep, setParams])

  // Focus moves to the new step's heading.
  const shown = useRef(index)
  useEffect(() => {
    if (shown.current === index) return
    shown.current = index
    headingRef.current?.focus()
  }, [index])

  // Leaving with progress asks first.
  const dirty = touched && !finished
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)

  const update = useCallback((change: (s: WizardState) => WizardState) => {
    setState((s) => (s ? change(s) : s))
    setTouched(true)
  }, [])

  // A message stays until its field is fixed.
  const current = state ? validate(step, state) : {}
  const shownErrors = blocked ?? Object.fromEntries(Object.entries(errors).filter(([k]) => k in current))

  function go(i: number) {
    const target = steps[i]
    if (!target) return
    setErrors({})
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('step', target)
      return p
    })
  }

  function next() {
    if (!state) return
    const errs = validate(step, state)
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      focusErrors()
      return
    }
    setTouched(true)
    setReached((r) => Math.max(r, index + 1))
    go(index + 1)
  }

  async function upload(file: File) {
    setUploading(true)
    setUploadError('')
    setAsOf(defaultAsOf(file))
    try {
      const contentType = contentTypeFor(file)
      const created = await createUpload({ filename: file.name, contentType })
      // The URL is pre-signed: it is called as is, without the API token.
      await putFile(new URL(created.uploadUrl, getConfig().apiUrl).toString(), file, contentType)
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.set('upload', created.importId)
          return p
        },
        { replace: true },
      )
    } catch (err) {
      setUploadError(failureText(err, 'upload'))
    } finally {
      setUploading(false)
    }
  }

  async function saveMapping() {
    if (!state || !saved) return
    const errs = validateValues(state)
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      focusErrors()
      return
    }
    setSaveErrors([])
    try {
      await putTemplate.mutateAsync({
        id: saved.id,
        name: saved.name,
        profile: 'records',
        body: templateFrom(state) as unknown as Record<string, unknown>,
      })
      setSavedMapping(true)
      setTimeout(() => doneRef.current?.focus(), 0)
    } catch (err) {
      const e = errorsFrom(err)
      setSaveErrors([...e.general, ...Object.values(e.fields).flat()])
    }
  }

  const cancelTo = mode === 'template' ? '/admin/templates' : '/admin/import'
  const cancelLabel = mode === 'template' ? 'Cancel' : 'Cancel setup'
  const onBack = index > 0 ? () => go(index - 1) : undefined
  const last = index === steps.length - 1
  const nextButton = (
    <button type="button" className={`${primaryButton} inline-flex items-center gap-1 px-5 py-2`} onClick={next}>
      Next
      <ArrowRight aria-hidden="true" className="size-4" />
    </button>
  )
  const stepProps = state && result ? { state, update, result, recordTypes: recordTypes.data ?? [], errors: shownErrors } : null

  let body: ReactNode
  let footer: ReactNode = <Footer cancelTo={cancelTo} cancelLabel={cancelLabel} />
  if (savedMapping && saved) {
    body = (
      <div className="space-y-4">
        <div ref={doneRef} tabIndex={-1} role="status" className="ov-pop flex items-center gap-3 rounded-lg border-2 border-status-g bg-status-g-bg p-5">
          <CheckCircle2 aria-hidden="true" className="size-8 shrink-0 text-status-g" />
          <div>
            <p className="text-lg font-semibold">Saved the mapping for {saved.name}.</p>
            <p className="text-sm">Next month’s upload of this export uses it.</p>
          </div>
        </div>
        <Link to="/admin/templates" className={secondaryButton}>
          Back to Templates
        </Link>
      </div>
    )
    footer = null
  } else if (!stepProps) {
    const failed = loadError?.id === uploadId ? loadError.message : ''
    if (mode === 'template' && templates.data && !saved) {
      body = (
        <p role="alert" className="font-medium text-status-r">
          That template wasn’t found. It may have been renamed or removed.
        </p>
      )
    } else if (failed) {
      body = (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 font-medium text-status-r">
            <XCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span>{failed}</span>
          </p>
          <button type="button" className={secondaryButton} onClick={() => setLoadAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )
    } else if (uploadId === '' && (mode === 'setup' || saved)) {
      body = (
        <div className="space-y-3">
          <p className="text-sm">
            {mode === 'template'
              ? 'To edit this mapping, drop a recent export of it, so we can show its columns and sample values.'
              : 'Drop the export you want to set up, and we’ll guess what each column means.'}
          </p>
          <DropZone multiple={false} onFiles={(files) => files[0] && void upload(files[0])} />
          <p role="status" className="flex min-h-5 items-center gap-2 text-sm font-medium">
            {uploading && (
              <>
                <Spinner />
                Uploading…
              </>
            )}
          </p>
          {uploadError && (
            <p role="alert" className="text-sm font-medium text-status-r">
              {uploadError}
            </p>
          )}
        </div>
      )
    } else {
      body = (
        <p role="status" className="flex items-center gap-2 text-sm font-medium">
          <Spinner />
          Reading your file…
        </p>
      )
    }
  } else if (step === 'type') {
    body = <StepType {...stepProps} templates={templates.data ?? []} hiddenTypeId={ownTypeId} />
  } else if (step === 'columns') {
    body = <StepColumns {...stepProps} />
  } else if (step === 'values') {
    body = (
      <>
        <StepValues {...stepProps} />
        <FormError messages={saveErrors} />
      </>
    )
  } else if (step === 'products') {
    body = <StepProducts {...stepProps} />
  } else if (step === 'calculate') {
    body = <StepCalculate {...stepProps} />
  } else {
    body = (
      <StepPreview
        {...stepProps}
        importId={uploadId}
        templates={templates.data ?? []}
        artifacts={artifacts}
        questions={questions}
        setQuestions={setQuestions}
        asOf={asOf}
        setAsOf={setAsOf}
        applied={applied}
        onApplied={setApplied}
        onTypeSaved={setOwnTypeId}
        footer={(primary, note) => <Footer cancelTo={cancelTo} cancelLabel={cancelLabel} onBack={onBack} primary={primary} note={note} />}
      />
    )
    footer = null
  }
  if (stepProps && step !== 'preview' && !finished) {
    footer = (
      <Footer
        cancelTo={cancelTo}
        cancelLabel={cancelLabel}
        onBack={onBack}
        primary={
          mode === 'template' && last ? (
            <button
              type="button"
              className={`${primaryButton} px-5 py-2`}
              disabled={putTemplate.isPending}
              onClick={() => void saveMapping()}
            >
              {putTemplate.isPending ? 'Saving…' : 'Save mapping'}
            </button>
          ) : (
            nextButton
          )
        }
      />
    )
  }

  return (
    <section className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-accent-deep">
          {mode === 'template' ? (saved ? `Edit mapping: ${saved.name}` : 'Edit mapping') : 'Set up this export'}
        </h1>
        <p className="mt-1 text-sm text-ink/80">
          {mode === 'template'
            ? 'Change which column is which and what the values mean, then save.'
            : 'We guessed everything we could from the file. Check each step and change anything that looks wrong; it takes a couple of minutes.'}
        </p>
      </div>
      <StepIndicator steps={steps} index={index} finished={finished} />
      <div ref={formRef} key={step} className="ov-enter space-y-5 rounded-lg border border-ink/20 bg-white/80 p-5 shadow-sm">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
          {finished ? 'You’re all set' : STEP_HEADINGS[step]}
        </h2>
        {body}
        {footer}
      </div>

      <Dialog.Root open={blocker.state === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            role="alertdialog"
            className="fixed left-1/2 top-1/3 z-50 w-[min(94vw,28rem)] -translate-x-1/2 rounded-lg bg-white p-6 shadow-xl"
          >
            <Dialog.Title className="text-lg font-semibold text-accent-deep">Leave the setup?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm">
              Your answers so far will be lost. Nothing from this file has been applied yet.
              {artifacts.draft && ` Your draft “${artifacts.draft.version.name}” is kept in Methodology, where you can finish or delete it.`}
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={() => blocker.reset?.()}>
                Stay
              </button>
              <button type="button" className={dangerButton} onClick={() => blocker.proceed?.()}>
                Leave
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
