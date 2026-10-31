import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { ApiError } from '../../api/errors'
import {
  useCreateItem,
  useCreateItemKind,
  useItemKinds,
  useItems,
  useOrgLevels,
  useOrgUnits,
  useUpdateItem,
  type ItemKind,
  type Level,
  type OrgUnit,
  type TrackedItem,
} from '../../api/queries'
import {
  ID_PATTERN,
  NO_ERRORS,
  errorsFrom,
  fieldError,
  forField,
  formatSourceKeys,
  parseSourceKeys,
  sameList,
  slugify,
  unclaimed,
  type FormErrors,
} from './adminModel'
import {
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

interface Ctx {
  kinds: readonly ItemKind[]
  units: readonly OrgUnit[]
  levels: readonly Level[]
  onNotice: (message: string) => void
}

const ID_RULE = "Use 1 to 64 letters, digits, '-' or '_'."

/** "None" plus every active unit, and the unit the item is already attached to even if retired. */
function unitOptions(ctx: Ctx, current = '') {
  const levelName = new Map(ctx.levels.map((l) => [l.id, l.name]))
  return [
    { value: '', label: 'None (not attached)' },
    ...ctx.units
      .filter((u) => !u.retiredFrom || u.id === current)
      .map((u) => ({
        value: u.id,
        label: `${u.name} (${levelName.get(u.levelId) ?? u.levelId})${u.retiredFrom ? ' (retired)' : ''}`,
      })),
  ]
}

function AddKindForm({ ctx, close }: { ctx: Ctx; close: () => void }) {
  const create = useCreateItemKind()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const local: FormErrors = { fields: {}, general: [] }
    if (name.trim() === '') local.fields.name = ['Enter a name.']
    if (!ID_PATTERN.test(id)) local.fields.id = [ID_RULE]
    if (Object.keys(local.fields).length > 0) {
      setErrors(local)
      focusErrors()
      return
    }
    try {
      await create.mutateAsync({ id, name: name.trim() })
      ctx.onNotice(`Added the item kind ${name.trim()}.`)
      close()
    } catch (err) {
      setErrors(err instanceof ApiError && err.status === 409 ? fieldError('id', err.message) : errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Name"
        hint="What the items are called, such as Service or Vendor."
        value={name}
        errors={forField(errors, 'name')}
        onChange={(e) => {
          setName(e.target.value)
          if (!idEdited) setId(slugify(e.target.value))
        }}
      />
      <TextField
        label="ID"
        hint="Letters, digits, '-' and '_'."
        value={id}
        errors={forField(errors, 'id')}
        onChange={(e) => {
          setId(e.target.value)
          setIdEdited(true)
        }}
      />
      <FormError messages={unclaimed(errors, ['name', 'id'])} />
      <FormActions submitLabel="Add kind" pending={create.isPending} onCancel={close} />
    </form>
  )
}

function AddItemForm({ ctx, kindId, close }: { ctx: Ctx; kindId: string; close: () => void }) {
  const create = useCreateItem()
  const { formRef, focusErrors } = useFocusOnError()
  const [kind, setKind] = useState(kindId)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [orgUnitId, setOrgUnitId] = useState('')
  const [keys, setKeys] = useState('')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const local: FormErrors = { fields: {}, general: [] }
    if (name.trim() === '') local.fields.name = ['Enter a name.']
    if (!ID_PATTERN.test(id)) local.fields.id = [ID_RULE]
    if (Object.keys(local.fields).length > 0) {
      setErrors(local)
      focusErrors()
      return
    }
    try {
      await create.mutateAsync({
        id,
        kindId: kind,
        name: name.trim(),
        orgUnitId,
        sourceKeys: parseSourceKeys(keys),
      })
      ctx.onNotice(`Added ${name.trim()}.`)
      close()
    } catch (err) {
      setErrors(err instanceof ApiError && err.status === 409 ? fieldError('id', err.message) : errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <SelectField
        label="Kind"
        value={kind}
        options={ctx.kinds.map((k) => ({ value: k.id, label: k.name }))}
        errors={forField(errors, 'kindId')}
        onChange={(e) => setKind(e.target.value)}
      />
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
        hint="Letters, digits, '-' and '_'."
        value={id}
        errors={forField(errors, 'id')}
        onChange={(e) => {
          setId(e.target.value)
          setIdEdited(true)
        }}
      />
      <SelectField
        label="Org unit"
        value={orgUnitId}
        options={unitOptions(ctx)}
        errors={forField(errors, 'orgUnitId')}
        onChange={(e) => setOrgUnitId(e.target.value)}
      />
      <TextField
        label="Source keys"
        hint="Names this item goes by in source systems, separated by commas."
        value={keys}
        errors={forField(errors, 'sourceKeys')}
        onChange={(e) => setKeys(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['kindId', 'name', 'id', 'orgUnitId', 'sourceKeys'])} />
      <FormActions submitLabel="Add item" pending={create.isPending} onCancel={close} />
    </form>
  )
}

function EditItemForm({ ctx, item, close }: { ctx: Ctx; item: TrackedItem; close: () => void }) {
  const update = useUpdateItem()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState(item.name)
  const [orgUnitId, setOrgUnitId] = useState(item.orgUnitId)
  const [keys, setKeys] = useState(formatSourceKeys(item.sourceKeys))
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const kindName = ctx.kinds.find((k) => k.id === item.kindId)?.name ?? item.kindId

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') {
      setErrors(fieldError('name', 'Enter a name.'))
      focusErrors()
      return
    }
    const body: { name?: string; orgUnitId?: string; sourceKeys?: string[] } = {}
    if (name.trim() !== item.name) body.name = name.trim()
    if (orgUnitId !== item.orgUnitId) body.orgUnitId = orgUnitId
    const parsed = parseSourceKeys(keys)
    if (!sameList(parsed, item.sourceKeys)) body.sourceKeys = parsed
    if (Object.keys(body).length === 0) {
      close()
      return
    }
    try {
      await update.mutateAsync({ id: item.id, body })
      ctx.onNotice(`Saved ${body.name ?? item.name}.`)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">Kind: </span>
        {kindName}
      </p>
      <TextField label="Name" value={name} errors={forField(errors, 'name')} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label="Org unit"
        value={orgUnitId}
        options={unitOptions(ctx, item.orgUnitId)}
        errors={forField(errors, 'orgUnitId')}
        onChange={(e) => setOrgUnitId(e.target.value)}
      />
      <TextField
        label="Source keys"
        hint="Names this item goes by in source systems, separated by commas."
        value={keys}
        errors={forField(errors, 'sourceKeys')}
        onChange={(e) => setKeys(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['name', 'orgUnitId', 'sourceKeys'])} />
      <FormActions submitLabel="Save" pending={update.isPending} onCancel={close} />
    </form>
  )
}

function KindSection({
  ctx,
  kind,
  items,
  fallback,
}: {
  ctx: Ctx
  kind: ItemKind
  items: readonly TrackedItem[]
  fallback: RefObject<HTMLElement | null>
}) {
  const unitName = new Map(ctx.units.map((u) => [u.id, u.name]))
  const headingId = `kind-${kind.id}`
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          {kind.name}
        </h2>
        <FormDialog
          triggerLabel="Add item"
          triggerAriaLabel={`Add ${kind.name} item`}
          title="Add item"
          description={`Track a new ${kind.name.toLowerCase()} and attach it to an org unit.`}
          fallbackFocus={fallback}
        >
          {(close) => <AddItemForm ctx={ctx} kindId={kind.id} close={close} />}
        </FormDialog>
      </div>
      {items.length === 0 ? (
        <p className="text-sm">No items yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <caption className="sr-only">{kind.name} items</caption>
            <thead>
              <tr className="border-b border-ink/30">
                <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Org unit</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Source keys</th>
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-ink/10 align-top">
                  <th scope="row" className="py-2 pr-4 font-medium">{it.name}</th>
                  <td className="py-2 pr-4">
                    {it.orgUnitId ? (unitName.get(it.orgUnitId) ?? it.orgUnitId) : 'Not attached'}
                  </td>
                  <td className="py-2 pr-4">{it.sourceKeys.length > 0 ? formatSourceKeys(it.sourceKeys) : '—'}</td>
                  <td className="py-2">
                    <FormDialog
                      triggerLabel="Edit"
                      triggerAriaLabel={`Edit ${it.name}`}
                      title={`Edit ${it.name}`}
                      description="Rename the item, attach it to an org unit, or edit the names it goes by in source systems."
                      fallbackFocus={fallback}
                    >
                      {(close) => <EditItemForm ctx={ctx} item={it} close={close} />}
                    </FormDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function ItemsPage() {
  const kinds = useItemKinds()
  const items = useItems()
  const units = useOrgUnits()
  const levels = useOrgLevels()
  const [notice, setNotice] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)

  const pending = kinds.isPending || items.isPending || units.isPending || levels.isPending
  const error = kinds.error ?? items.error ?? units.error ?? levels.error
  const ready = kinds.data && items.data && units.data && levels.data
  const ctx: Ctx | undefined = ready
    ? { kinds: kinds.data, units: units.data.units, levels: levels.data, onNotice: setNotice }
    : undefined

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-accent-deep">
          Items
        </h1>
        {ctx && (
          <FormDialog
            triggerLabel="Add kind"
            triggerClassName={ctx.kinds.length === 0 ? primaryButton : secondaryButton}
            title="Add item kind"
            description="A kind groups tracked items, such as services or vendors."
            fallbackFocus={heading}
          >
            {(close) => <AddKindForm ctx={ctx} close={close} />}
          </FormDialog>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={pending && !error} error={error} what="items" />
      {ctx && items.data && (
        <>
          {ctx.kinds.length === 0 && (
            <p>No item kinds yet. Add a kind, such as Service or Vendor, then add items to it.</p>
          )}
          {ctx.kinds.map((k) => (
            <KindSection
              key={k.id}
              ctx={ctx}
              kind={k}
              items={items.data.filter((it) => it.kindId === k.id)}
              fallback={heading}
            />
          ))}
        </>
      )}
    </section>
  )
}
