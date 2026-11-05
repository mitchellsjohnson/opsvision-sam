import { Archive, CheckCircle2, ClipboardCheck, Pencil } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import {
  useCreateVersion,
  useFiscalYearStartMonth,
  useScorecards,
  useVersions,
  type MethodologyVersion,
} from '../../api/queries'
import { NO_ERRORS, errorsFrom, forField, unclaimed, type FormErrors } from './adminModel'
import { DiffView } from './DiffView'
import { DraftEditor } from './DraftEditor'
import {
  FormActions,
  FormDialog,
  FormError,
  QueryState,
  SelectField,
  TextField,
  linkButton,
  primaryButton,
  useFocusOnError,
} from './formUi'
import {
  AGG_OPTIONS,
  DIRECTION_OPTIONS,
  FREQUENCY_OPTIONS,
  effectiveLabel,
  labelOf,
  ruleSummary,
  statusLabel,
  versionInForce,
} from './methodologyModel'

const CHIPS: Record<string, { icon: typeof Pencil; className: string }> = {
  draft: { icon: Pencil, className: 'bg-status-y-bg text-status-y' },
  in_review: { icon: ClipboardCheck, className: 'bg-status-y-bg text-status-y' },
  published: { icon: CheckCircle2, className: 'bg-status-g-bg text-status-g' },
  superseded: { icon: Archive, className: 'bg-status-na-bg text-ink' },
}

/** A version's status as an icon and text, never color alone. */
export function VersionChip({ status }: { status: string }) {
  const chip = CHIPS[status] ?? { icon: Archive, className: 'bg-status-na-bg text-ink' }
  const Icon = chip.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-semibold ${chip.className}`}>
      <Icon aria-hidden="true" className="size-4" />
      {statusLabel(status)}
    </span>
  )
}

function NewDraftForm({
  sc,
  versions,
  fiscal,
  close,
  onCreated,
}: {
  sc: string
  versions: readonly MethodologyVersion[]
  fiscal: number
  close: () => void
  onCreated: (v: MethodologyVersion) => void
}) {
  const create = useCreateVersion(sc)
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() => versionInForce(versions)?.id ?? '')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') {
      setErrors({ fields: { name: ['Enter a name for the draft.'] }, general: [] })
      focusErrors()
      return
    }
    try {
      const created = await create.mutateAsync({ name: name.trim(), ...(from === '' ? {} : { cloneFrom: from }) })
      onCreated(created)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField label="Draft name" value={name} errors={forField(errors, 'name')} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label="Start from"
        hint="A copy of an existing version, or an empty draft."
        value={from}
        options={[
          { value: '', label: 'Empty draft' },
          ...versions.map((v) => ({
            value: v.id,
            label: `${v.name} (${statusLabel(v.status).toLowerCase()}, ${effectiveLabel(v.effectiveFrom, fiscal).toLowerCase()})`,
          })),
        ]}
        onChange={(e) => setFrom(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['name'])} />
      <FormActions submitLabel="Create draft" pending={create.isPending} onCancel={close} />
    </form>
  )
}

/** A published or superseded version: nothing to edit, with the changes it made. */
function ReadOnlyVersion({
  sc,
  version,
  versions,
  fiscal,
}: {
  sc: string
  version: MethodologyVersion
  versions: readonly MethodologyVersion[]
  fiscal: number
}) {
  const c = version.content
  const categoryName = new Map(c.categories.map((x) => [x.id, x.name]))
  return (
    <div className="space-y-6">
      <p className="text-sm">
        This version is {statusLabel(version.status).toLowerCase()} and cannot be edited. To change it, create a new
        draft from it.
      </p>
      <section aria-labelledby="ro-cat-h" className="space-y-2">
        <h2 id="ro-cat-h" className="text-lg font-semibold">
          Categories
        </h2>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Categories</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-2 font-medium">ID</th>
              <th scope="col" className="pr-2 font-medium">Name</th>
              <th scope="col" className="font-medium">Order</th>
            </tr>
          </thead>
          <tbody>
            {c.categories.map((x) => (
              <tr key={x.id} className="border-t border-ink/10">
                <th scope="row" className="py-1 pr-2 font-normal">{x.id}</th>
                <td className="py-1 pr-2">{x.name}</td>
                <td className="py-1">{x.order}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="ro-meas-h" className="space-y-2">
        <h2 id="ro-meas-h" className="text-lg font-semibold">
          Measures
        </h2>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Measures</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-2 font-medium">Key</th>
              <th scope="col" className="pr-2 font-medium">Name</th>
              <th scope="col" className="pr-2 font-medium">Unit</th>
              <th scope="col" className="pr-2 font-medium">Across org units</th>
              <th scope="col" className="font-medium">Across time</th>
            </tr>
          </thead>
          <tbody>
            {c.measures.map((m) => (
              <tr key={m.key} className="border-t border-ink/10">
                <th scope="row" className="py-1 pr-2 font-normal">{m.key}</th>
                <td className="py-1 pr-2">{m.name}</td>
                <td className="py-1 pr-2">{m.unit}</td>
                <td className="py-1 pr-2">{labelOf(AGG_OPTIONS, m.orgAgg)}</td>
                <td className="py-1">{labelOf(AGG_OPTIONS, m.timeAgg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="ro-met-h" className="space-y-2">
        <h2 id="ro-met-h" className="text-lg font-semibold">
          Metrics
        </h2>
        {c.metrics.length === 0 ? (
          <p className="text-sm">No metrics.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Metrics</caption>
              <thead>
                <tr>
                  <th scope="col" className="pr-2 font-medium">Metric</th>
                  <th scope="col" className="pr-2 font-medium">Category</th>
                  <th scope="col" className="pr-2 font-medium">Formula</th>
                  <th scope="col" className="pr-2 font-medium">Direction</th>
                  <th scope="col" className="pr-2 font-medium">Frequency</th>
                  <th scope="col" className="font-medium">Status rule</th>
                </tr>
              </thead>
              <tbody>
                {c.metrics.map((m) => (
                  <tr key={m.key} className="border-t border-ink/10 align-top">
                    <th scope="row" className="py-1 pr-2 font-medium">
                      {m.name}
                      <span className="block font-normal text-ink/80">{m.key}</span>
                    </th>
                    <td className="py-1 pr-2">{categoryName.get(m.categoryId) ?? m.categoryId}</td>
                    <td className="py-1 pr-2 font-mono">{m.formula}</td>
                    <td className="py-1 pr-2">{labelOf(DIRECTION_OPTIONS, m.direction)}</td>
                    <td className="py-1 pr-2">{labelOf(FREQUENCY_OPTIONS, m.frequency)}</td>
                    <td className="py-1">{ruleSummary(m.rule)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <DiffView sc={sc} version={version} versions={versions} fiscalYearStartMonth={fiscal} />
    </div>
  )
}

export function MethodologyPage() {
  const fiscal = useFiscalYearStartMonth()
  const scorecards = useScorecards()
  const [params, setParams] = useSearchParams()
  const heading = useRef<HTMLHeadingElement>(null)
  const [notice, setNotice] = useState('')
  const [reloads, setReloads] = useState(0)

  const list = scorecards.data?.scorecards ?? []
  const requested = params.get('sc') ?? ''
  const sc = list.find((s) => s.id === requested)?.id ?? list[0]?.id
  const versions = useVersions(sc)
  const rows = versions.data?.versions ?? []
  const selected = rows.find((v) => v.id === params.get('v'))

  function choose(next: { sc?: string; v?: string }) {
    const p = new URLSearchParams(params)
    if (next.sc !== undefined) p.set('sc', next.sc)
    if (next.v !== undefined) {
      if (next.v === '') p.delete('v')
      else p.set('v', next.v)
    }
    setParams(p)
  }

  async function reload() {
    await versions.refetch()
    setReloads((n) => n + 1)
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-accent-deep">
          Methodology
        </h1>
        {sc && versions.data && (
          <FormDialog
            triggerLabel="New draft from…"
            triggerClassName={primaryButton}
            title="New draft"
            description="Start a draft from an existing version or from scratch. Nothing changes for scorecards until you publish it."
          >
            {(close) => (
              <NewDraftForm
                sc={sc}
                versions={rows}
                fiscal={fiscal}
                close={close}
                onCreated={(v) => {
                  setNotice(`Created the draft ${v.name}.`)
                  choose({ v: v.id })
                }}
              />
            )}
          </FormDialog>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={scorecards.isPending} error={scorecards.error} what="scorecards" />
      {scorecards.data && list.length === 0 && <p>There are no scorecards yet.</p>}
      {sc && (
        <>
          <div className="max-w-sm">
            <label htmlFor="methodology-sc" className="block text-sm font-medium">
              Scorecard
            </label>
            <select
              id="methodology-sc"
              className="mt-1 block w-full rounded-md border border-ink/40 bg-white px-2 py-1.5 text-sm"
              value={sc}
              onChange={(e) => choose({ sc: e.target.value, v: '' })}
            >
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <QueryState isPending={versions.isPending} error={versions.error} what="versions" />
          {versions.data && (
            <section aria-labelledby="versions-h" className="space-y-2">
              <h2 id="versions-h" className="text-lg font-semibold">
                Versions
              </h2>
              {rows.length === 0 ? (
                <p className="text-sm">No versions yet. Create a draft to start.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Methodology versions, newest first</caption>
                  <thead>
                    <tr className="border-b border-ink/20">
                      <th scope="col" className="py-2 pr-4 font-semibold">Version</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Status</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Effective</th>
                      <th scope="col" className="py-2 font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => (
                      <tr key={v.id} className="border-b border-ink/10">
                        <th scope="row" className="py-2 pr-4 font-medium">
                          {v.name}
                          {v.id === selected?.id && <span className="ml-1 font-normal">(open)</span>}
                        </th>
                        <td className="py-2 pr-4">
                          <VersionChip status={v.status} />
                        </td>
                        <td className="py-2 pr-4">{effectiveLabel(v.effectiveFrom, fiscal).replace(/^Effective /, '')}</td>
                        <td className="py-2">
                          <button
                            type="button"
                            className={linkButton}
                            aria-label={`${v.status === 'draft' ? 'Edit' : 'View'} ${v.name}`}
                            onClick={() => choose({ v: v.id })}
                          >
                            {v.status === 'draft' ? 'Edit' : 'View'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
          {versions.data && params.get('v') && !selected && (
            <p role="alert" className="font-medium text-status-r">
              That version was not found.
            </p>
          )}
          {selected && (
            <section aria-labelledby="open-h" className="space-y-4 border-t border-ink/20 pt-6">
              <div className="flex flex-wrap items-center gap-3">
                <h2 id="open-h" className="text-xl font-semibold">
                  {selected.status === 'draft' ? 'Editing' : 'Viewing'} {selected.name}
                </h2>
                <VersionChip status={selected.status} />
              </div>
              {selected.status === 'draft' ? (
                <DraftEditor
                  key={`${selected.id}:${reloads}`}
                  sc={sc}
                  version={selected}
                  versions={rows}
                  onReload={() => void reload()}
                  onNotice={(message) => {
                    setNotice(message)
                    // The dialog and editor are gone once a version publishes; keep focus on the page.
                    setTimeout(() => heading.current?.focus(), 0)
                  }}
                />
              ) : (
                <ReadOnlyVersion sc={sc} version={selected} versions={rows} fiscal={fiscal} />
              )}
            </section>
          )}
        </>
      )}
    </section>
  )
}
