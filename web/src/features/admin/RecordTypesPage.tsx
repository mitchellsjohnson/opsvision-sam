import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/errors'
import { useFiscalYearStartMonth, usePutRecordType, useRecordTypes, type RecordType } from '../../api/queries'
import type { components } from '../../api/schema'
import { currentMonth } from '../../lib/period'
import { NO_ERRORS, errorsFrom, forField, labelOfMonth, monthOptions, slugify, unclaimed, type FormErrors } from './adminModel'
import {
  FieldMessages,
  FormActions,
  FormDialog,
  FormError,
  QueryState,
  TextField,
  inputClass,
  linkButton,
  primaryButton,
  secondaryButton,
  useFocusOnError,
} from './formUi'

type AttributeDef = components['schemas']['AttributeDef']

const TYPE_OPTIONS: { value: AttributeDef['type']; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'bool', label: 'Yes or no' },
  { value: 'date', label: 'Date' },
]

const TYPE_TEXT: Record<AttributeDef['type'], string> = { string: 'text', number: 'number', bool: 'yes or no', date: 'date' }

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/

/** "Support incident" => "support_incident", the form record type IDs take. */
export function recordTypeId(name: string): string {
  const s = slugify(name).replace(/-/g, '_')
  return /^[a-z]/.test(s) ? s : s === '' ? '' : `t_${s}`
}

/** "Customer impact" => "customerImpact", the form custom field keys take. */
export function attributeKey(name: string): string {
  const words = slugify(name).split('-').filter(Boolean)
  const [first = '', ...rest] = words
  const key = first + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  return /^[a-z]/.test(key) ? key : key === '' ? '' : `f${key}`
}

function prioritiesText(t: RecordType) {
  return t.priorities.length > 0 ? t.priorities.join(', ') : 'None set'
}

function attributesText(t: RecordType) {
  return t.attributes.length > 0 ? t.attributes.map((a) => `${a.name || a.key} (${TYPE_TEXT[a.type] ?? a.type})`).join(', ') : 'None'
}

function trackedText(t: RecordType, fiscal: number) {
  const entries = Object.entries(t.trackedFrom)
  return entries.length > 0
    ? entries.map(([source, month]) => `${source}: from ${labelOfMonth(month, fiscal)}`).join('; ')
    : 'Not set yet'
}

function AddRecordTypeForm({ close, onCreated }: { close: () => void; onCreated: (t: RecordType) => void }) {
  const put = usePutRecordType()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const fields: Record<string, string[]> = {}
    if (name.trim() === '') fields.name = ['Enter a name, such as Defect or Epic.']
    if (!KEY_PATTERN.test(id)) fields.id = ["Use lowercase letters, digits and '_', starting with a letter."]
    if (Object.keys(fields).length > 0) {
      setErrors({ fields, general: [] })
      focusErrors()
      return
    }
    try {
      const created = await put.mutateAsync({ id, name: name.trim(), priorities: [], attributes: [], trackedFrom: {}, revision: 0 })
      onCreated(created)
      close()
    } catch (err) {
      setErrors(
        err instanceof ApiError && err.status === 409
          ? { fields: { id: ['A record type with this ID already exists.'] }, general: [] }
          : errorsFrom(err),
      )
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Name"
        value={name}
        errors={forField(errors, 'name')}
        onChange={(e) => {
          setName(e.target.value)
          if (!idEdited) setId(recordTypeId(e.target.value))
        }}
      />
      <TextField
        label="ID"
        hint="Lowercase letters, digits and '_'. It cannot change later."
        value={id}
        errors={forField(errors, 'id')}
        onChange={(e) => {
          setId(e.target.value)
          setIdEdited(true)
        }}
      />
      <FormError messages={unclaimed(errors, ['name', 'id'])} />
      <FormActions submitLabel="Add record type" pending={put.isPending} onCancel={close} />
    </form>
  )
}

interface AttrRow extends AttributeDef {
  /** Not saved yet: the key may still change, and follows the name until edited. */
  isNew: boolean
  keyEdited: boolean
}

interface Draft {
  name: string
  priorities: string[]
  attributes: AttrRow[]
  tracked: [string, string][]
}

function draftOf(t: RecordType): Draft {
  return {
    name: t.name,
    priorities: [...t.priorities],
    attributes: t.attributes.map((a) => ({ ...a, isNew: false, keyEdited: true })),
    tracked: Object.entries(t.trackedFrom),
  }
}

function RecordTypeEditor({
  type,
  fiscal,
  onReload,
}: {
  type: RecordType
  fiscal: number
  /** Loads the latest saved record type. */
  onReload: () => Promise<RecordType | undefined>
}) {
  const put = usePutRecordType()
  const { formRef, focusErrors } = useFocusOnError<HTMLFormElement>()
  const [draft, setDraft] = useState(() => draftOf(type))
  const revision = useRef(type.revision)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const [stale, setStale] = useState(false)
  const [status, setStatus] = useState('')
  const [announce, setAnnounce] = useState('')
  const [newPriority, setNewPriority] = useState('')
  const [newPriorityError, setNewPriorityError] = useState('')
  const [newSource, setNewSource] = useState('')
  const now = currentMonth(fiscal)
  const [newSourceMonth, setNewSourceMonth] = useState(now)
  const listRef = useRef<HTMLOListElement>(null)
  const pendingFocus = useRef<{ index: number; dir: 'up' | 'down' } | null>(null)
  const priHeading = useRef<HTMLHeadingElement>(null)
  const headingId = `rt-${type.id}-h`
  const headingRef = useRef<HTMLHeadingElement>(null)
  const label = draft.name.trim() || type.id

  useEffect(() => {
    const f = pendingFocus.current
    if (!f) return
    pendingFocus.current = null
    const li = listRef.current?.querySelector(`[data-pri="${f.index}"]`)
    const target =
      li?.querySelector<HTMLButtonElement>(`button[data-dir="${f.dir}"]:not(:disabled)`) ??
      li?.querySelector<HTMLButtonElement>('button[data-dir]:not(:disabled)') ??
      priHeading.current
    target?.focus()
  })

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setStatus('')
  }

  function move(i: number, dir: 'up' | 'down') {
    const j = dir === 'up' ? i - 1 : i + 1
    const list = [...draft.priorities]
    const a = list[i]
    const b = list[j]
    if (a === undefined || b === undefined) return
    list[i] = b
    list[j] = a
    set({ priorities: list })
    pendingFocus.current = { index: j, dir }
    setAnnounce(`${a || `Priority ${i + 1}`} moved to position ${j + 1} of ${list.length}.`)
  }

  function addPriority() {
    const p = newPriority.trim()
    if (p === '') return setNewPriorityError('Enter a priority name.')
    if (p === 'none') return setNewPriorityError('No priority (none) is always there; you do not need to add it.')
    if (draft.priorities.includes(p)) return setNewPriorityError(`${p} is already in the list.`)
    set({ priorities: [...draft.priorities, p] })
    setNewPriority('')
    setNewPriorityError('')
  }

  const setAttr = (i: number, patch: Partial<AttrRow>) =>
    set({ attributes: draft.attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)) })

  async function save(e: FormEvent) {
    e.preventDefault()
    setStatus('')
    if (draft.name.trim() === '') {
      setErrors({ fields: { name: ['Enter a name.'] }, general: [] })
      focusErrors()
      return
    }
    const body: RecordType = {
      id: type.id,
      name: draft.name.trim(),
      priorities: draft.priorities.map((p) => p.trim()),
      attributes: draft.attributes.map((a) => ({ key: a.key, name: a.name, type: a.type })),
      trackedFrom: Object.fromEntries(draft.tracked),
      revision: revision.current,
    }
    try {
      const saved = await put.mutateAsync(body)
      revision.current = saved.revision
      setDraft(draftOf(saved))
      setErrors(NO_ERRORS)
      setStale(false)
      setStatus(`Saved ${saved.name}.`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setStale(true)
      else setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  async function reload() {
    const latest = await onReload()
    if (!latest) return
    revision.current = latest.revision
    setDraft(draftOf(latest))
    setErrors(NO_ERRORS)
    setStale(false)
    setStatus('')
    headingRef.current?.focus()
  }

  const claimed = [
    'name',
    ...draft.priorities.map((_, i) => `priorities[${i}]`),
    ...draft.attributes.flatMap((_, i) => [`attributes[${i}].key`, `attributes[${i}].name`, `attributes[${i}].type`]),
    ...draft.tracked.map(([s]) => `trackedFrom.${s}`),
  ]
  const at = (path: string) => errors.fields[path] ?? []

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg border border-ink/20 p-4">
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        Edit {type.name}
      </h2>
      <form ref={formRef} onSubmit={save} noValidate className="space-y-5">
        {stale && (
          <div role="alert" tabIndex={-1} data-form-error="" className="rounded-md border border-status-r bg-status-r-bg p-3 text-sm">
            <p className="font-medium text-status-r">
              This record type was changed somewhere else since you opened it, so your changes could not be saved.
            </p>
            <button type="button" className={`${secondaryButton} mt-2`} onClick={() => void reload()}>
              Reload {type.name}
            </button>
            <span className="ml-2">Loads the latest saved version and discards your unsaved changes.</span>
          </div>
        )}
        <FormError messages={unclaimed(errors, claimed)} />
        <TextField label="Name" className="max-w-sm" value={draft.name} errors={at('name')} onChange={(e) => set({ name: e.target.value })} />

        <div className="space-y-2">
          <h3 id={`${headingId}-pri`} ref={priHeading} tabIndex={-1} className="text-base font-semibold">
            Priorities, highest first
          </h3>
          <p className="text-sm text-ink/80">
            Records without a priority count as &ldquo;No priority&rdquo;, which is always the lowest.
          </p>
          {draft.priorities.length === 0 ? (
            <p className="text-sm">No priorities yet.</p>
          ) : (
            <ol ref={listRef} aria-labelledby={`${headingId}-pri`} className="space-y-1">
              {draft.priorities.map((p, i) => {
                const name = p || `priority ${i + 1}`
                const errs = at(`priorities[${i}]`)
                const errId = `${headingId}-pri-${i}-err`
                return (
                  <li key={i} data-pri={i} className="flex flex-wrap items-start gap-2">
                    <span aria-hidden="true" className="mt-2 w-6 text-right text-sm">
                      {i + 1}.
                    </span>
                    <div>
                      <input
                        aria-label={`Priority ${i + 1}`}
                        className={`${inputClass} w-40`}
                        value={p}
                        aria-invalid={errs.length > 0 ? true : undefined}
                        aria-describedby={errs.length > 0 ? errId : undefined}
                        onChange={(e) => set({ priorities: draft.priorities.map((x, j) => (j === i ? e.target.value : x)) })}
                      />
                      <FieldMessages id={errId} errors={errs} />
                    </div>
                    <button
                      type="button"
                      data-dir="up"
                      className={`${secondaryButton} mt-1`}
                      aria-label={`Move ${name} up`}
                      disabled={i === 0}
                      onClick={() => move(i, 'up')}
                    >
                      <ArrowUp aria-hidden="true" className="inline size-4" /> Up
                    </button>
                    <button
                      type="button"
                      data-dir="down"
                      className={`${secondaryButton} mt-1`}
                      aria-label={`Move ${name} down`}
                      disabled={i === draft.priorities.length - 1}
                      onClick={() => move(i, 'down')}
                    >
                      <ArrowDown aria-hidden="true" className="inline size-4" /> Down
                    </button>
                    <button
                      type="button"
                      className={`${secondaryButton} mt-1`}
                      aria-label={`Remove ${name}`}
                      onClick={() => {
                        set({ priorities: draft.priorities.filter((_, j) => j !== i) })
                        pendingFocus.current = { index: Math.min(i, draft.priorities.length - 2), dir: 'down' }
                        setAnnounce(`${name} removed.`)
                      }}
                    >
                      Remove
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
          <p role="status" className="sr-only">
            {announce}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label="New priority"
              className="w-48"
              value={newPriority}
              errors={newPriorityError ? [newPriorityError] : []}
              onChange={(e) => {
                setNewPriority(e.target.value)
                setNewPriorityError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addPriority()
                }
              }}
            />
            <button type="button" className={`${secondaryButton} mb-0.5`} onClick={addPriority}>
              Add priority
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-base font-semibold">Custom fields</h3>
          <p className="text-sm text-ink/80">Extra columns your exports carry, such as whether a customer ticket is linked.</p>
          {draft.attributes.length === 0 ? (
            <p className="text-sm">No custom fields.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Custom fields</caption>
              <thead>
                <tr>
                  <th scope="col" className="pr-2 font-medium">Name</th>
                  <th scope="col" className="pr-2 font-medium">Key</th>
                  <th scope="col" className="pr-2 font-medium">Type</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {draft.attributes.map((a, i) => {
                  const n = i + 1
                  const cell = (field: 'name' | 'key' | 'type') => {
                    const errs = at(`attributes[${i}].${field}`)
                    const errId = `${headingId}-attr-${i}-${field}-err`
                    return {
                      errs,
                      errId,
                      props: {
                        'aria-invalid': errs.length > 0 ? true : undefined,
                        'aria-describedby': errs.length > 0 ? errId : undefined,
                      },
                    }
                  }
                  const nameCell = cell('name')
                  const keyCell = cell('key')
                  const typeCell = cell('type')
                  return (
                    <tr key={i} className="align-top">
                      <td className="pr-2">
                        <input
                          aria-label={`Custom field ${n} name`}
                          className={inputClass}
                          value={a.name}
                          {...nameCell.props}
                          onChange={(e) =>
                            setAttr(i, {
                              name: e.target.value,
                              ...(a.isNew && !a.keyEdited ? { key: attributeKey(e.target.value) } : {}),
                            })
                          }
                        />
                        <FieldMessages id={nameCell.errId} errors={nameCell.errs} />
                      </td>
                      <td className="pr-2">
                        <input
                          aria-label={`Custom field ${n} key`}
                          className={`${inputClass} font-mono`}
                          value={a.key}
                          readOnly={!a.isNew}
                          {...keyCell.props}
                          onChange={(e) => setAttr(i, { key: e.target.value, keyEdited: true })}
                        />
                        <FieldMessages id={keyCell.errId} errors={keyCell.errs} />
                      </td>
                      <td className="pr-2">
                        <select
                          aria-label={`Custom field ${n} type`}
                          className={inputClass}
                          value={a.type}
                          {...typeCell.props}
                          onChange={(e) => setAttr(i, { type: e.target.value as AttributeDef['type'] })}
                        >
                          {TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <FieldMessages id={typeCell.errId} errors={typeCell.errs} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`${secondaryButton} mt-1`}
                          aria-label={`Remove custom field ${n}`}
                          onClick={() => set({ attributes: draft.attributes.filter((_, j) => j !== i) })}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <button
            type="button"
            className={secondaryButton}
            onClick={() =>
              set({ attributes: [...draft.attributes, { key: '', name: '', type: 'string', isNew: true, keyEdited: false }] })
            }
          >
            Add custom field
          </button>
        </div>

        <div className="space-y-2">
          <h3 className="text-base font-semibold">Tracked from</h3>
          <p className="text-sm text-ink/80">
            For each source system, the first month calculated values come from its records. Earlier months keep the
            numbers that were typed or imported.
          </p>
          {draft.tracked.length === 0 && <p className="text-sm">No source systems yet. They are added with the first upload.</p>}
          {draft.tracked.map(([source, month], i) => {
            const errs = at(`trackedFrom.${source}`)
            const errId = `${headingId}-tr-${i}-err`
            return (
              <div key={source} className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor={`${headingId}-tr-${i}`} className="block text-sm font-medium">
                    Tracked from for {source}
                  </label>
                  <select
                    id={`${headingId}-tr-${i}`}
                    className={inputClass}
                    value={month}
                    aria-invalid={errs.length > 0 ? true : undefined}
                    aria-describedby={errs.length > 0 ? errId : undefined}
                    onChange={(e) => set({ tracked: draft.tracked.map((t, j) => (j === i ? [source, e.target.value] : t)) })}
                  >
                    {monthOptions(month || now, fiscal, month).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <FieldMessages id={errId} errors={errs} />
                </div>
                <button
                  type="button"
                  className={`${secondaryButton} mb-0.5`}
                  aria-label={`Remove ${source}`}
                  onClick={() => set({ tracked: draft.tracked.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            )
          })}
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="New source system" className="w-48" value={newSource} onChange={(e) => setNewSource(e.target.value)} />
            <div>
              <label htmlFor={`${headingId}-new-month`} className="block text-sm font-medium">
                Tracked from
              </label>
              <select
                id={`${headingId}-new-month`}
                className={inputClass}
                value={newSourceMonth}
                onChange={(e) => setNewSourceMonth(e.target.value)}
              >
                {monthOptions(now, fiscal).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={`${secondaryButton} mb-0.5`}
              disabled={newSource.trim() === '' || draft.tracked.some(([s]) => s === newSource.trim())}
              onClick={() => {
                set({ tracked: [...draft.tracked, [newSource.trim(), newSourceMonth]] })
                setNewSource('')
              }}
            >
              Add source system
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={primaryButton} disabled={put.isPending}>
            {put.isPending ? 'Saving…' : `Save ${label}`}
          </button>
          <p role="status" className="text-sm font-medium text-status-g">
            {status}
          </p>
        </div>
      </form>
    </section>
  )
}

/** Admin → Record types: the kinds of records uploads bring in. */
export function RecordTypesPage() {
  const fiscal = useFiscalYearStartMonth()
  const types = useRecordTypes()
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const list = types.data ?? []
  const open = list.find((t) => t.id === selected)

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold text-accent-deep">Record types</h1>
        <FormDialog
          triggerLabel="Add record type"
          triggerClassName={primaryButton}
          title="Add record type"
          description="A kind of record your uploads bring in, such as defects or epics. You can add priorities and custom fields next."
        >
          {(close) => (
            <AddRecordTypeForm
              close={close}
              onCreated={(t) => {
                setNotice(`Added ${t.name}.`)
                setSelected(t.id)
              }}
            />
          )}
        </FormDialog>
      </div>
      <p className="text-sm text-ink/80">
        The kinds of records you upload, with their priorities, custom fields, and the month each source system is
        tracked from.
      </p>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={types.isPending} error={types.error} what="record types" />
      {types.data && list.length === 0 && (
        <p>No record types yet. Add one, or set one up from a file on the Import page.</p>
      )}
      {list.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Record types</caption>
          <thead>
            <tr className="border-b border-ink/20">
              <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Priorities, highest first</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Custom fields</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Tracked from</th>
              <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className="border-b border-ink/10 align-top">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {t.name}
                  {t.id === selected && <span className="ml-1 font-normal">(open)</span>}
                </th>
                <td className="py-2 pr-4">{prioritiesText(t)}</td>
                <td className="py-2 pr-4">{attributesText(t)}</td>
                <td className="py-2 pr-4">{trackedText(t, fiscal)}</td>
                <td className="py-2">
                  <button type="button" className={linkButton} aria-label={`Edit ${t.name}`} onClick={() => setSelected(t.id)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <RecordTypeEditor
          key={open.id}
          type={open}
          fiscal={fiscal}
          onReload={async () => (await types.refetch()).data?.find((t) => t.id === open.id)}
        />
      )}
    </section>
  )
}
