import { ApiError } from '../../api/errors'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import {
  useCreateOrgMove,
  useCreateOrgUnit,
  useFiscalYearStartMonth,
  useOrgLevels,
  useOrgTree,
  useOrgUnits,
  usePutOrgLevels,
  useUpdateOrgUnit,
  type Level,
  type OrgTreeNode,
  type OrgUnit,
} from '../../api/queries'
import { currentMonth } from '../../lib/period'
import {
  ID_PATTERN,
  NO_ERRORS,
  errorsFrom,
  fieldError,
  flattenTree,
  forField,
  formatSourceKeys,
  labelOfMonth,
  monthOptions,
  parseSourceKeys,
  previewMove,
  sameList,
  slugify,
  subtreeIds,
  unclaimed,
  type FormErrors,
} from './adminModel'
import {
  FieldMessages,
  FormActions,
  FormDialog,
  FormError,
  QueryState,
  SelectField,
  TextField,
  primaryButton,
  secondaryButton,
  useFocusOnError,
} from './formUi'

// ---- Shared pieces ----------------------------------------------------------

function MonthField({
  label,
  value,
  onChange,
  now,
  fiscal,
  errors,
  hint,
}: {
  label: string
  value: string
  onChange: (month: string) => void
  now: string
  fiscal: number
  errors?: readonly string[]
  hint?: string
}) {
  return (
    <SelectField
      label={label}
      hint={hint}
      errors={errors}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={monthOptions(now, fiscal, value)}
    />
  )
}

/** A nested list of units with their level names. Actions are rendered per unit. */
function TreeView({
  roots,
  levelName,
  label,
  actions,
  highlightId,
}: {
  roots: readonly OrgTreeNode[]
  levelName: (levelId: string) => string
  label: string
  actions?: (node: OrgTreeNode) => ReactNode
  highlightId?: string
}) {
  const renderNodes = (nodes: readonly OrgTreeNode[]): ReactNode => (
    <>
      {nodes.map((n) => (
        <li key={n.id} className="mt-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span data-unit-name="" className={n.id === highlightId ? 'font-bold' : 'font-medium'}>
              {n.name}
            </span>
            <span className="rounded bg-status-na-bg px-1.5 py-0.5 text-xs text-ink">
              {levelName(n.levelId)}
            </span>
            {n.id === highlightId && (
              <span className="rounded border border-accent-deep px-1.5 py-0.5 text-xs font-medium text-accent-deep">
                (moved)
              </span>
            )}
            {actions?.(n)}
          </div>
          {n.children.length > 0 && (
            <ul className="ml-5 mt-1 border-l border-ink/20 pl-3">{renderNodes(n.children)}</ul>
          )}
        </li>
      ))}
    </>
  )
  return <ul aria-label={label}>{renderNodes(roots)}</ul>
}

// ---- Levels -----------------------------------------------------------------

interface LevelDraft {
  key: string
  id: string
  name: string
  isNew: boolean
  idEdited: boolean
}

function draftsFrom(levels: readonly Level[]): LevelDraft[] {
  return [...levels]
    .sort((a, b) => a.depth - b.depth)
    .map((l) => ({ key: l.id, id: l.id, name: l.name, isNew: false, idEdited: true }))
}

let newLevelCounter = 0

function LevelRow({
  index,
  count,
  draft,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  draft: LevelDraft
  errors: FormErrors
  onChange: (patch: Partial<LevelDraft>) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const extraId = useId()
  const n = index + 1
  const who = draft.name.trim() || `level ${n}`
  const path = `levels[${index}]`
  const extra = [
    ...(draft.isNew ? [] : forField(errors, `${path}.id`)),
    ...forField(errors, `${path}.depth`),
  ]
  return (
    <li className="rounded-md border border-ink/20 bg-white p-3">
      <div className="flex flex-wrap items-start gap-3">
        <TextField
          className="min-w-48 flex-1"
          label={`Level ${n} name`}
          value={draft.name}
          errors={forField(errors, `${path}.name`)}
          onChange={(e) => {
            const name = e.target.value
            onChange(draft.isNew && !draft.idEdited ? { name, id: slugify(name) } : { name })
          }}
        />
        {draft.isNew ? (
          <TextField
            className="w-48"
            label={`Level ${n} ID`}
            value={draft.id}
            errors={forField(errors, `${path}.id`)}
            onChange={(e) => onChange({ id: e.target.value, idEdited: true })}
          />
        ) : (
          <p className="pt-6 text-sm text-ink/80">
            ID: <code>{draft.id}</code>
          </p>
        )}
        <div className="flex gap-1 pt-6">
          <button
            type="button"
            className={secondaryButton}
            aria-label={`Move ${who} level up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            className={secondaryButton}
            aria-label={`Move ${who} level down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            className={secondaryButton}
            aria-label={`Remove ${who} level`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <FieldMessages id={extraId} errors={extra} />
    </li>
  )
}

function LevelsEditor({ levels, onSaved }: { levels: readonly Level[]; onSaved: (message: string) => void }) {
  const [rows, setRows] = useState<LevelDraft[]>(() => draftsFrom(levels))
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const put = usePutOrgLevels()
  const { formRef, focusErrors } = useFocusOnError()

  const update = (i: number, patch: Partial<LevelDraft>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, delta: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs]
      const [row] = next.splice(i, 1)
      if (row) next.splice(i + delta, 0, row)
      return next
    })

  async function submit(e: FormEvent) {
    e.preventDefault()
    const local: FormErrors = { fields: {}, general: [] }
    rows.forEach((r, i) => {
      if (r.name.trim() === '') local.fields[`levels[${i}].name`] = ['Enter a name.']
      if (r.isNew && !ID_PATTERN.test(r.id)) {
        local.fields[`levels[${i}].id`] = ["Use 1 to 64 letters, digits, '-' or '_'."]
      }
    })
    if (Object.keys(local.fields).length > 0) {
      setErrors(local)
      focusErrors()
      return
    }
    try {
      const saved = await put.mutateAsync(rows.map((r, i) => ({ id: r.id, name: r.name.trim(), depth: i })))
      setRows(draftsFrom(saved))
      setErrors(NO_ERRORS)
      onSaved('Levels saved.')
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  // Fields with a place in the rows; everything else (including paths on `levels`) shows below.
  const claimed = rows.flatMap((_, i) => [`levels[${i}].name`, `levels[${i}].id`, `levels[${i}].depth`])
  const general = [...unclaimed(errors, [...claimed, 'levels']), ...forField(errors, 'levels')]

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Hierarchy levels</legend>
        <p className="text-sm text-ink/80">
          Shallowest first. A unit must sit at a deeper level than its parent.
        </p>
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <LevelRow
              key={r.key}
              index={i}
              count={rows.length}
              draft={r}
              errors={errors}
              onChange={(patch) => update(i, patch)}
              onMove={(d) => move(i, d)}
              onRemove={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      </fieldset>
      <div className="mt-3 space-y-2">
        <FormError messages={general} />
        <div className="flex gap-2">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              newLevelCounter += 1
              setRows((rs) => [
                ...rs,
                { key: `new-${newLevelCounter}`, id: '', name: '', isNew: true, idEdited: false },
              ])
            }}
          >
            Add level
          </button>
          <button type="submit" className={primaryButton} disabled={put.isPending}>
            {put.isPending ? 'Saving…' : 'Save levels'}
          </button>
        </div>
      </div>
    </form>
  )
}

// ---- Unit dialogs -----------------------------------------------------------

interface Ctx {
  levels: readonly Level[]
  units: readonly OrgUnit[]
  fiscal: number
  now: string
  onNotice: (message: string) => void
}

const levelOptions = (levels: readonly Level[]) => [
  { value: '', label: 'Choose a level' },
  ...[...levels].sort((a, b) => a.depth - b.depth).map((l) => ({ value: l.id, label: l.name })),
]

function AddUnitForm({ ctx, close }: { ctx: Ctx; close: () => void }) {
  const create = useCreateOrgUnit()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [levelId, setLevelId] = useState('')
  const [parentId, setParentId] = useState('')
  const [keys, setKeys] = useState('')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  const levelName = new Map(ctx.levels.map((l) => [l.id, l.name]))
  const parents = [
    { value: '', label: 'None (top level)' },
    ...ctx.units
      .filter((u) => !u.retiredFrom)
      .map((u) => ({ value: u.id, label: `${u.name} (${levelName.get(u.levelId) ?? u.levelId})` })),
  ]

  async function submit(e: FormEvent) {
    e.preventDefault()
    const local: FormErrors = { fields: {}, general: [] }
    if (name.trim() === '') local.fields.name = ['Enter a name.']
    if (!ID_PATTERN.test(id)) local.fields.id = ["Use 1 to 64 letters, digits, '-' or '_'."]
    if (levelId === '') local.fields.levelId = ['Choose a level.']
    if (Object.keys(local.fields).length > 0) {
      setErrors(local)
      focusErrors()
      return
    }
    try {
      await create.mutateAsync({
        id,
        name: name.trim(),
        levelId,
        parentId,
        sourceKeys: parseSourceKeys(keys),
      })
      ctx.onNotice(`Added ${name.trim()}.`)
      close()
    } catch (err) {
      // A duplicate ID comes back as a 409 with no field: it belongs to the ID.
      setErrors(err instanceof ApiError && err.status === 409 ? fieldError('id', err.message) : errorsFrom(err))
      focusErrors()
    }
  }

  const claimed = ['name', 'id', 'levelId', 'parentId', 'sourceKeys']
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Name"
        value={name}
        errors={forField(errors, 'name')}
        onChange={(e) => {
          setName(e.target.value)
          if (!idEdited) setId(slugify(e.target.value))
        }}
      />
      <TextField
        label="ID"
        hint="Used in links and imports. Letters, digits, '-' and '_'."
        value={id}
        errors={forField(errors, 'id')}
        onChange={(e) => {
          setId(e.target.value)
          setIdEdited(true)
        }}
      />
      <SelectField
        label="Level"
        value={levelId}
        options={levelOptions(ctx.levels)}
        errors={forField(errors, 'levelId')}
        onChange={(e) => setLevelId(e.target.value)}
      />
      <SelectField
        label="Parent"
        value={parentId}
        options={parents}
        errors={forField(errors, 'parentId')}
        onChange={(e) => setParentId(e.target.value)}
      />
      <TextField
        label="Source keys"
        hint="Names this unit goes by in source systems, separated by commas."
        value={keys}
        errors={forField(errors, 'sourceKeys')}
        onChange={(e) => setKeys(e.target.value)}
      />
      <FormError messages={unclaimed(errors, claimed)} />
      <FormActions submitLabel="Add unit" pending={create.isPending} onCancel={close} />
    </form>
  )
}

function EditUnitForm({ ctx, unit, close }: { ctx: Ctx; unit: OrgUnit; close: () => void }) {
  const update = useUpdateOrgUnit()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState(unit.name)
  const [levelId, setLevelId] = useState(unit.levelId)
  const [keys, setKeys] = useState(formatSourceKeys(unit.sourceKeys))
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') {
      setErrors(fieldError('name', 'Enter a name.'))
      focusErrors()
      return
    }
    const body: { name?: string; levelId?: string; sourceKeys?: string[] } = {}
    if (name.trim() !== unit.name) body.name = name.trim()
    if (levelId !== unit.levelId) body.levelId = levelId
    const parsed = parseSourceKeys(keys)
    if (!sameList(parsed, unit.sourceKeys)) body.sourceKeys = parsed
    if (Object.keys(body).length === 0) {
      close()
      return
    }
    try {
      await update.mutateAsync({ id: unit.id, body })
      ctx.onNotice(`Saved ${body.name ?? unit.name}.`)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField label="Name" value={name} errors={forField(errors, 'name')} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label="Level"
        value={levelId}
        options={levelOptions(ctx.levels).slice(1)}
        errors={forField(errors, 'levelId')}
        onChange={(e) => setLevelId(e.target.value)}
      />
      <TextField
        label="Source keys"
        hint="Names this unit goes by in source systems, separated by commas."
        value={keys}
        errors={forField(errors, 'sourceKeys')}
        onChange={(e) => setKeys(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['name', 'levelId', 'sourceKeys'])} />
      <FormActions submitLabel="Save" pending={update.isPending} onCancel={close} />
    </form>
  )
}

function RetireUnitForm({ ctx, unit, close }: { ctx: Ctx; unit: OrgUnit; close: () => void }) {
  const update = useUpdateOrgUnit()
  const { formRef, focusErrors } = useFocusOnError()
  const [month, setMonth] = useState(ctx.now)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await update.mutateAsync({ id: unit.id, body: { retiredFrom: month } })
      ctx.onNotice(`Retired ${unit.name} from ${labelOfMonth(month, ctx.fiscal)}.`)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  // Whatever the API objects to (children still under the unit, a bad month)
  // is about the month chosen, so it shows beside that field.
  const messages = [...forField(errors, 'retiredFrom'), ...unclaimed(errors, ['retiredFrom'])]
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <MonthField
        label="Retire from"
        hint="From this month the unit no longer appears in the structure. Earlier months and its data are kept."
        value={month}
        onChange={setMonth}
        now={ctx.now}
        fiscal={ctx.fiscal}
        errors={messages}
      />
      <FormActions submitLabel="Retire unit" pending={update.isPending} onCancel={close} />
    </form>
  )
}

function MoveUnitForm({ ctx, unit, close }: { ctx: Ctx; unit: OrgUnit; close: () => void }) {
  const move = useCreateOrgMove()
  const { formRef, focusErrors } = useFocusOnError()
  const [parentId, setParentId] = useState('')
  const [month, setMonth] = useState(ctx.now)
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const tree = useOrgTree(month)

  const levelDepth = new Map(ctx.levels.map((l) => [l.id, l.depth]))
  const levelName = new Map(ctx.levels.map((l) => [l.id, l.name]))
  const myDepth = levelDepth.get(unit.levelId) ?? 0
  const roots = tree.data?.roots ?? []
  const excluded = subtreeIds(roots, unit.id)
  const candidates = flattenTree(roots).filter(
    (n) => !excluded.has(n.id) && (levelDepth.get(n.levelId) ?? 0) < myDepth,
  )
  const options = [
    { value: '', label: 'Choose a parent' },
    ...candidates.map((n) => ({ value: n.id, label: `${n.name} (${levelName.get(n.levelId) ?? n.levelId})` })),
  ]
  const parentValue = candidates.some((c) => c.id === parentId) ? parentId : ''
  const parentName = candidates.find((c) => c.id === parentValue)?.name

  const monthLabel = labelOfMonth(month, ctx.fiscal)
  const preview = parentValue !== '' && tree.data ? previewMove(roots, unit.id, parentValue) : undefined

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (parentValue === '') {
      setErrors(fieldError('newParentId', 'Choose a new parent.'))
      focusErrors()
      return
    }
    try {
      await move.mutateAsync({
        id: unit.id,
        body: { newParentId: parentValue, effectiveMonth: month, ...(note.trim() ? { note: note.trim() } : {}) },
      })
      ctx.onNotice(
        `Moved ${unit.name} under ${parentName ?? parentValue}, effective ${monthLabel}. ` +
          'Change "Show structure as of" to see the structure in other months.',
      )
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  const previewId = useId()
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <SelectField
        label="New parent"
        value={parentValue}
        options={options}
        errors={forField(errors, 'newParentId')}
        onChange={(e) => setParentId(e.target.value)}
      />
      <MonthField
        label="Effective month"
        hint="The unit reports to the new parent from this month. Earlier months keep the old structure."
        value={month}
        onChange={setMonth}
        now={ctx.now}
        fiscal={ctx.fiscal}
        errors={[...forField(errors, 'effectiveMonth'), ...errors.general]}
      />
      <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <section aria-labelledby={previewId} className="rounded-md border border-ink/20 bg-cream p-3">
        <h3 id={previewId} className="text-sm font-semibold">
          Preview: structure as of {monthLabel}
        </h3>
        {parentValue === '' ? (
          <p className="mt-1 text-sm text-ink/80">Choose a new parent to see the result.</p>
        ) : tree.isPending ? (
          <p role="status" className="mt-1 text-sm">Loading preview…</p>
        ) : preview?.ok ? (
          <div className="mt-1 text-sm">
            <TreeView
              roots={preview.roots}
              levelName={(id) => levelName.get(id) ?? id}
              label={`Preview of the structure as of ${monthLabel}`}
              highlightId={unit.id}
            />
          </div>
        ) : (
          <p className="mt-1 text-sm font-medium text-status-r">{preview?.reason ?? 'The preview is not available.'}</p>
        )}
      </section>
      <FormError messages={unclaimed(errors, ['newParentId', 'effectiveMonth']).filter((m) => !errors.general.includes(m))} />
      <FormActions submitLabel="Move unit" pending={move.isPending} onCancel={close} />
    </form>
  )
}

// ---- Page -------------------------------------------------------------------

export function OrgPage() {
  const fiscal = useFiscalYearStartMonth()
  const now = currentMonth(fiscal)
  const [asOfChoice, setAsOf] = useState<string | null>(null)
  const asOf = asOfChoice ?? now
  const [notice, setNotice] = useState('')
  const levels = useOrgLevels()
  const units = useOrgUnits()
  const tree = useOrgTree(asOf)
  const unitsHeading = useRef<HTMLHeadingElement>(null)

  const ctx: Ctx | undefined =
    levels.data && units.data
      ? { levels: levels.data, units: units.data.units, fiscal, now, onNotice: setNotice }
      : undefined
  const levelName = (id: string) => levels.data?.find((l) => l.id === id)?.name ?? id
  const unitById = new Map(units.data?.units.map((u) => [u.id, u]) ?? [])
  const retired = (units.data?.units ?? []).filter((u) => u.retiredFrom)
  const asOfLabel = labelOfMonth(asOf, fiscal)

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-accent-deep">Org structure</h1>
        <p role="status" className="mt-1 min-h-5 text-sm font-medium text-status-g">
          {notice}
        </p>
      </div>

      <section aria-labelledby="levels-heading" className="space-y-3">
        <h2 id="levels-heading" className="text-lg font-semibold">
          Levels
        </h2>
        <QueryState isPending={levels.isPending} error={levels.error} what="levels" />
        {levels.data && <LevelsEditor levels={levels.data} onSaved={setNotice} />}
      </section>

      <section aria-labelledby="units-heading" className="space-y-3">
        <h2 id="units-heading" ref={unitsHeading} tabIndex={-1} className="text-lg font-semibold">
          Units
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          <MonthField
            label="Show structure as of"
            value={asOf}
            onChange={setAsOf}
            now={now}
            fiscal={fiscal}
          />
          {ctx && (
            <FormDialog
              triggerLabel="Add unit"
              triggerClassName={primaryButton}
              title="Add unit"
              description="Add a unit to the structure under a parent, or at the top level."
              fallbackFocus={unitsHeading}
            >
              {(close) => <AddUnitForm ctx={ctx} close={close} />}
            </FormDialog>
          )}
        </div>
        <QueryState isPending={tree.isPending || units.isPending} error={tree.error ?? units.error} what="the structure" />
        {tree.data && ctx && (
          tree.data.roots.length === 0 ? (
            <p>No units are active in {asOfLabel}. Add a unit to get started.</p>
          ) : (
            <TreeView
              roots={tree.data.roots}
              levelName={levelName}
              label={`Org structure as of ${asOfLabel}`}
              actions={(n) => {
                const unit = unitById.get(n.id)
                return unit ? <UnitActions ctx={ctx} unit={unit} fallback={unitsHeading} /> : null
              }}
            />
          )
        )}
      </section>

      <section aria-labelledby="retired-heading" className="space-y-2">
        <h2 id="retired-heading" className="text-lg font-semibold">
          Retired units
        </h2>
        {units.data &&
          (retired.length === 0 ? (
            <p className="text-sm">No units are retired.</p>
          ) : (
            <ul className="list-disc pl-5 text-sm">
              {retired.map((u) => (
                <li key={u.id}>
                  <span className="font-medium">{u.name}</span> ({levelName(u.levelId)}):{' '}
                  {(u.retiredFrom ?? '') <= now ? 'retired from' : 'retires from'}{' '}
                  {labelOfMonth(u.retiredFrom ?? '', fiscal)}
                </li>
              ))}
            </ul>
          ))}
      </section>
    </section>
  )
}

function UnitActions({
  ctx,
  unit,
  fallback,
}: {
  ctx: Ctx
  unit: OrgUnit
  fallback: RefObject<HTMLElement | null>
}) {
  return (
    <span className="flex gap-1">
      <FormDialog
        triggerLabel="Edit"
        triggerAriaLabel={`Edit ${unit.name}`}
        title={`Edit ${unit.name}`}
        description="Rename the unit, change its level, or edit the names it goes by in source systems."
        fallbackFocus={fallback}
      >
        {(close) => <EditUnitForm ctx={ctx} unit={unit} close={close} />}
      </FormDialog>
      <FormDialog
        triggerLabel="Move…"
        triggerAriaLabel={`Move ${unit.name}`}
        title={`Move ${unit.name}`}
        description="Reparent the unit from a month. Everything below it moves with it."
        fallbackFocus={fallback}
        wide
      >
        {(close) => <MoveUnitForm ctx={ctx} unit={unit} close={close} />}
      </FormDialog>
      <FormDialog
        triggerLabel="Retire"
        triggerAriaLabel={`Retire ${unit.name}`}
        title={`Retire ${unit.name}`}
        description="Stop the unit appearing in the structure from a month."
        fallbackFocus={fallback}
      >
        {(close) => <RetireUnitForm ctx={ctx} unit={unit} close={close} />}
      </FormDialog>
    </span>
  )
}
