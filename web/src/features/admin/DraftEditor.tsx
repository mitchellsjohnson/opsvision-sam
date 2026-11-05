import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useBlocker } from 'react-router'
import { ApiError, type ErrorDetail } from '../../api/errors'
import {
  useFiscalYearStartMonth,
  useItemKinds,
  useMe,
  useOrgLevels,
  usePutVersion,
  useValidateVersion,
  type MethodologyVersion,
} from '../../api/queries'
import { currentMonth } from '../../lib/period'
import { DiffView } from './DiffView'
import { MetricForm } from './MetricForm'
import { PublishDialog } from './PublishDialog'
import { errorsFrom, NO_ERRORS, type FormErrors } from './adminModel'
import {
  FieldMessages,
  FormError,
  TextField,
  inputClass,
  primaryButton,
  secondaryButton,
  linkButton,
  useFocusOnError,
} from './formUi'
import {
  AGG_OPTIONS,
  atPath,
  contentOf,
  draftFrom,
  fingerprint,
  metricIndex,
  newMetric,
  nextUid,
  type DraftState,
  type MetricRow,
} from './methodologyModel'

export interface DraftEditorProps {
  sc: string
  version: MethodologyVersion
  versions: readonly MethodologyVersion[]
  /** Discards local edits and loads the draft again from the server. */
  onReload: () => void
  onNotice: (message: string) => void
}

function Section({
  id,
  title,
  headingRef,
  children,
}: {
  id: string
  title: string
  headingRef?: RefObject<HTMLHeadingElement | null>
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function CellError({ id, messages }: { id: string; messages: readonly string[] }) {
  return <FieldMessages id={id} errors={messages} />
}

/**
 * Edits a draft: categories, measures and metrics. Edits stay local until
 * Save draft. Validate saves first and then validates,
 * because the API validates the stored draft.
 */
export function DraftEditor({ sc, version, versions, onReload, onNotice }: DraftEditorProps) {
  const fiscal = useFiscalYearStartMonth()
  const now = currentMonth(fiscal)
  const me = useMe()
  const levels = useOrgLevels()
  const kinds = useItemKinds()
  const put = usePutVersion(sc)
  const validate = useValidateVersion(sc)
  const statusScale = me.data?.tenant?.statusScale ?? []

  const [draft, setDraftState] = useState<DraftState>(() => draftFrom(version))
  const draftRef = useRef(draft)
  const revisionRef = useRef(version.revision)
  const [baseline, setBaseline] = useState(() => fingerprint(draft))
  const baselineRef = useRef(baseline)
  const [selected, setSelected] = useState<string | null>(null)
  const [problems, setProblems] = useState<ErrorDetail[]>([])
  const [saveErrors, setSaveErrors] = useState<FormErrors>(NO_ERRORS)
  const [nameError, setNameError] = useState('')
  const [stale, setStale] = useState(false)
  const [status, setStatus] = useState('')
  const [checking, setChecking] = useState(false)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const { formRef, focusErrors } = useFocusOnError<HTMLDivElement>()

  function update(next: DraftState) {
    draftRef.current = next
    setDraftState(next)
  }

  const dirty = fingerprint(draft) !== baseline
  const advancedBroken = draft.metrics.some((r) => r.advancedError)

  // Unsaved-changes guard: leaving the page, or switching version or scorecard (the URL), is confirmed.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  )

  /** Runs after any save or check already in flight, so revisions never race. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.current.then(job, job)
    chain.current = run.catch(() => undefined)
    return run
  }

  /** Saves when there are changes. Returns false when the draft could not be saved. */
  async function saveNow(): Promise<boolean> {
    const d = draftRef.current
    if (d.name.trim() === '') {
      setNameError('Enter a name for the draft.')
      return false
    }
    setNameError('')
    if (d.metrics.some((r) => r.advancedError)) {
      setSaveErrors({ fields: {}, general: ['Fix the JSON in the Advanced panel before saving.'] })
      return false
    }
    const fp = fingerprint(d)
    if (fp === baselineRef.current) return true
    try {
      const saved = await put.mutateAsync({
        v: version.id,
        body: { revision: revisionRef.current, name: d.name.trim(), content: contentOf(d) },
      })
      revisionRef.current = saved.revision
      baselineRef.current = fp
      setBaseline(fp)
      setSaveErrors(NO_ERRORS)
      setStale(false)
      // Metrics that were just stored have fixed keys from now on.
      const sent = new Set(d.metrics.map((r) => r.uid))
      update({
        ...draftRef.current,
        metrics: draftRef.current.metrics.map((r) => (sent.has(r.uid) && r.isNew ? { ...r, isNew: false } : r)),
      })
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setStale(true)
      else setSaveErrors(errorsFrom(err))
      return false
    }
  }

  async function save() {
    setStatus('')
    const ok = await enqueue(saveNow)
    if (ok) setStatus('Draft saved.')
    else focusErrors()
  }

  async function check() {
    setChecking(true)
    setStatus('')
    try {
      await enqueue(async () => {
        if (!(await saveNow())) {
          focusErrors()
          return
        }
        try {
          const result = await validate.mutateAsync(version.id)
          setProblems(result.errors)
          setStatus(
            result.valid
              ? 'Validated: no problems found. The draft is saved.'
              : `Validated: ${result.errors.length} ${result.errors.length === 1 ? 'problem' : 'problems'} found. The draft is saved.`,
          )
          if (!result.valid) focusErrors()
        } catch (err) {
          setSaveErrors(errorsFrom(err))
        }
      })
    } finally {
      setChecking(false)
    }
  }

  // ---- edits ----

  function setMetric(uid: string, row: MetricRow) {
    const index = draftRef.current.metrics.findIndex((r) => r.uid === uid)
    // The last check no longer describes this metric.
    setProblems((p) => p.filter((e) => metricIndex(e.path) !== index))
    update({ ...draftRef.current, metrics: draftRef.current.metrics.map((r) => (r.uid === uid ? row : r)) })
  }

  function addMetric() {
    const row: MetricRow = {
      uid: nextUid(),
      isNew: true,
      metric: newMetric(
        draft.categories[0]?.id ?? '',
        statusScale.map((s) => s.key),
      ),
    }
    setProblems([])
    update({ ...draft, metrics: [...draft.metrics, row] })
    setSelected(row.uid)
  }

  function removeMetric(uid: string) {
    setProblems([])
    update({ ...draft, metrics: draft.metrics.filter((r) => r.uid !== uid) })
    if (selected === uid) setSelected(null)
    metricsHeading.current?.focus()
  }

  const metricsHeading = useRef<HTMLHeadingElement>(null)
  const metricFormHeading = useRef<HTMLHeadingElement>(null)
  const categoriesHeading = useRef<HTMLHeadingElement>(null)
  const measuresHeading = useRef<HTMLHeadingElement>(null)

  function setCategories(categories: DraftState['categories']) {
    setProblems((p) => p.filter((e) => !e.path.startsWith('categories')))
    update({ ...draft, categories })
  }
  function setMeasures(measures: DraftState['measures']) {
    setProblems((p) => p.filter((e) => !e.path.startsWith('measures')))
    update({ ...draft, measures })
  }

  const selectedIndex = draft.metrics.findIndex((r) => r.uid === selected)
  const selectedRow = selectedIndex >= 0 ? draft.metrics[selectedIndex] : undefined
  const metricLabel = (i: number) => {
    const m = draft.metrics[i]?.metric
    return m && (m.name || m.key) ? m.name || m.key : `Metric ${i + 1}`
  }
  // Problems in metrics that are not open, categories and measures are shown in rows; these are the rest.
  const otherProblems = problems
    .filter((e) => {
      const i = metricIndex(e.path)
      return i !== undefined && i !== selectedIndex
    })
    .map((e) => {
      const i = metricIndex(e.path) ?? 0
      return `${metricLabel(i)}: ${e.path.replace(/^metrics\[\d+\]\.?/, '')}${e.path.replace(/^metrics\[\d+\]\.?/, '') ? ': ' : ''}${e.message}`
    })
  const unplaced = problems
    .filter(
      (e) =>
        metricIndex(e.path) === undefined &&
        !/^categories\[\d+\]\.id$/.test(e.path) &&
        !/^measures\[\d+\]\.key$/.test(e.path),
    )
    .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))

  return (
    <div ref={formRef} className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            label="Draft name"
            className="min-w-64 flex-1"
            value={draft.name}
            errors={nameError ? [nameError] : []}
            onChange={(e) => {
              update({ ...draft, name: e.target.value })
              setNameError('')
            }}
          />
          <button type="button" className={primaryButton} disabled={put.isPending || !dirty} onClick={save}>
            {put.isPending ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={checking || put.isPending}
            onClick={() => void check()}
          >
            {checking ? 'Validating…' : 'Validate'}
          </button>
          <PublishDialog
            sc={sc}
            version={version}
            fiscal={fiscal}
            now={now}
            disabled={dirty || advancedBroken}
            onPublished={onNotice}
          />
        </div>
        <p className="text-sm text-ink/80">
          {dirty ? 'You have unsaved changes. Save the draft before publishing.' : 'All changes are saved.'}
        </p>
        <p role="status" className="min-h-5 text-sm font-medium text-status-g">
          {status}
        </p>
        {stale && (
          <div role="alert" tabIndex={-1} data-form-error="" className="rounded-md border border-status-r bg-status-r-bg p-3 text-sm">
            <p className="font-medium text-status-r">
              This draft was changed somewhere else since you opened it, so your changes could not be saved.
            </p>
            <button type="button" className={`${secondaryButton} mt-2`} onClick={onReload}>
              Reload draft
            </button>
            <span className="ml-2">Loads the latest saved draft and discards your unsaved changes.</span>
          </div>
        )}
        <FormError messages={[...saveErrors.general, ...Object.entries(saveErrors.fields).flatMap(([p, m]) => m.map((x) => `${p}: ${x}`))]} />
        <FormError messages={[...unplaced, ...otherProblems]} />
      </div>

      <Section id="categories-h" title="Categories" headingRef={categoriesHeading}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Categories</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-2 font-medium">ID</th>
              <th scope="col" className="pr-2 font-medium">Name</th>
              <th scope="col" className="pr-2 font-medium">Order</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {draft.categories.map((c, i) => {
              const idErr = atPath(problems, `categories[${i}].id`)
              const errId = `cat-${i}-id-err`
              return (
                <tr key={i} className="align-top">
                  <td className="pr-2">
                    <input
                      aria-label={`Category ${i + 1} ID`}
                      className={inputClass}
                      value={c.id}
                      aria-invalid={idErr.length > 0 ? true : undefined}
                      aria-describedby={idErr.length > 0 ? errId : undefined}
                      onChange={(e) => setCategories(draft.categories.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
                    />
                    <CellError id={errId} messages={idErr} />
                  </td>
                  <td className="pr-2">
                    <input
                      aria-label={`Category ${i + 1} name`}
                      className={inputClass}
                      value={c.name}
                      onChange={(e) => setCategories(draft.categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      aria-label={`Category ${i + 1} order`}
                      type="number"
                      className={inputClass}
                      value={c.order}
                      onChange={(e) =>
                        setCategories(draft.categories.map((x, j) => (j === i ? { ...x, order: Math.trunc(Number(e.target.value)) || 0 } : x)))
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`${secondaryButton} mt-1`}
                      aria-label={`Remove category ${c.name || c.id || i + 1}`}
                      onClick={() => {
                        setCategories(draft.categories.filter((_, j) => j !== i))
                        categoriesHeading.current?.focus()
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <button
          type="button"
          className={secondaryButton}
          onClick={() =>
            setCategories([...draft.categories, { id: '', name: '', order: (draft.categories.at(-1)?.order ?? 0) + 1 }])
          }
        >
          Add category
        </button>
      </Section>

      <Section id="measures-h" title="Measures" headingRef={measuresHeading}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Measures</caption>
            <thead>
              <tr>
                <th scope="col" className="pr-2 font-medium">Key</th>
                <th scope="col" className="pr-2 font-medium">Name</th>
                <th scope="col" className="pr-2 font-medium">Unit</th>
                <th scope="col" className="pr-2 font-medium">Across org units</th>
                <th scope="col" className="pr-2 font-medium">Across time</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {draft.measures.map((m, i) => {
                const keyErr = atPath(problems, `measures[${i}].key`)
                const errId = `meas-${i}-key-err`
                const set = (patch: Partial<typeof m>) =>
                  setMeasures(draft.measures.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-2">
                      <input
                        aria-label={`Measure ${i + 1} key`}
                        className={inputClass}
                        value={m.key}
                        aria-invalid={keyErr.length > 0 ? true : undefined}
                        aria-describedby={keyErr.length > 0 ? errId : undefined}
                        onChange={(e) => set({ key: e.target.value })}
                      />
                      <CellError id={errId} messages={keyErr} />
                    </td>
                    <td className="pr-2">
                      <input aria-label={`Measure ${i + 1} name`} className={inputClass} value={m.name} onChange={(e) => set({ name: e.target.value })} />
                    </td>
                    <td className="pr-2">
                      <input aria-label={`Measure ${i + 1} unit`} className={inputClass} value={m.unit} onChange={(e) => set({ unit: e.target.value })} />
                    </td>
                    <td className="pr-2">
                      <select
                        aria-label={`Measure ${i + 1} org aggregation`}
                        className={inputClass}
                        value={m.orgAgg}
                        onChange={(e) => set({ orgAgg: e.target.value as typeof m.orgAgg })}
                      >
                        {AGG_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="pr-2">
                      <select
                        aria-label={`Measure ${i + 1} time aggregation`}
                        className={inputClass}
                        value={m.timeAgg}
                        onChange={(e) => set({ timeAgg: e.target.value as typeof m.timeAgg })}
                      >
                        {AGG_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`${secondaryButton} mt-1`}
                        aria-label={`Remove measure ${m.name || m.key || i + 1}`}
                        onClick={() => {
                          setMeasures(draft.measures.filter((_, j) => j !== i))
                          measuresHeading.current?.focus()
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className={secondaryButton}
          onClick={() =>
            setMeasures([...draft.measures, { key: '', name: '', unit: '', orgAgg: 'sum', timeAgg: 'sum' }])
          }
        >
          Add measure
        </button>
      </Section>

      <Section id="metrics-h" title="Metrics" headingRef={metricsHeading}>
        {draft.metrics.length === 0 ? (
          <p className="text-sm">No metrics yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Metrics</caption>
            <thead>
              <tr>
                <th scope="col" className="pr-2 font-medium">Metric</th>
                <th scope="col" className="pr-2 font-medium">Key</th>
                <th scope="col" className="pr-2 font-medium">Problems</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {draft.metrics.map((r, i) => {
                const count = problems.filter((e) => metricIndex(e.path) === i).length
                return (
                  <tr key={r.uid} className="border-t border-ink/10">
                    <th scope="row" className="py-1 pr-2 font-medium">
                      {metricLabel(i)}
                      {selected === r.uid && <span className="ml-1 font-normal">(editing)</span>}
                    </th>
                    <td className="py-1 pr-2">{r.metric.key || '(new)'}</td>
                    <td className="py-1 pr-2">{count > 0 ? `${count} ${count === 1 ? 'problem' : 'problems'}` : ''}</td>
                    <td className="py-1">
                      <span className="flex gap-1">
                        <button
                          type="button"
                          className={linkButton}
                          aria-label={`Edit ${metricLabel(i)}`}
                          onClick={() => {
                            setSelected(r.uid)
                            setTimeout(() => metricFormHeading.current?.focus(), 0)
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={linkButton}
                          aria-label={`Remove ${metricLabel(i)}`}
                          onClick={() => removeMetric(r.uid)}
                        >
                          Remove
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <button type="button" className={secondaryButton} onClick={addMetric}>
          Add metric
        </button>

        {selectedRow && (
          <section aria-labelledby="metric-form-h" className="space-y-3 rounded-lg border border-ink/20 p-4">
            <h3 id="metric-form-h" ref={metricFormHeading} tabIndex={-1} className="text-base font-semibold">
              Edit metric: {metricLabel(selectedIndex)}
            </h3>
            <MetricForm
              row={selectedRow}
              index={selectedIndex}
              categories={draft.categories}
              statusScale={statusScale}
              levels={levels.data ?? []}
              kinds={kinds.data ?? []}
              errors={problems}
              onChange={(row) => setMetric(selectedRow.uid, row)}
              onCheck={() => void check()}
              checking={checking}
            />
          </section>
        )}
      </Section>

      {!dirty && <DiffView sc={sc} version={version} versions={versions} fiscalYearStartMonth={fiscal} />}
      {dirty && (
        <p className="text-sm text-ink/80">Save the draft to see how it differs from the version in force.</p>
      )}

      <Dialog.Root open={blocker.state === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content className="fixed left-1/2 top-1/3 z-50 w-full max-w-md -translate-x-1/2 rounded-md bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold text-accent-deep">Leave without saving?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm">
              You have unsaved changes to {draft.name || 'this draft'}. If you leave now they are lost.
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => blocker.reset?.()} className={secondaryButton}>
                Stay and keep editing
              </button>
              <button type="button" onClick={() => blocker.proceed?.()} className={primaryButton}>
                Discard and leave
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

