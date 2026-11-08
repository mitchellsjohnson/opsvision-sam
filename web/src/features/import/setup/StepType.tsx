import { FileSpreadsheet, Sparkles } from 'lucide-react'
import { useId } from 'react'
import type { ImportTemplate, RecordType } from '../../../api/queries'
import { TextField } from '../../admin/formUi'
import { recordTypeId } from '../../admin/RecordTypesPage'
import { formatCount } from '../recordsModel'
import { NEW_TYPE, chooseType, renameDefault, setNewType, type StepErrors, type StepProps, type WizardState } from './wizardModel'

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/

const optionClass =
  'flex items-start gap-3 rounded-md border border-ink/30 bg-white p-3 motion-safe:transition-shadow has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/40'

/**
 * What the type step needs before moving on. `ownTypeId` is a type this
 * setup already created (after going back), which is not a clash.
 */
export function validateType(state: WizardState, types: readonly RecordType[], ownTypeId: string): StepErrors {
  const errors: StepErrors = {}
  if (state.recordType === NEW_TYPE) {
    const name = state.newType.name.trim()
    const id = recordTypeId(name)
    const taken = types.find((t) => t.id === id && t.id !== ownTypeId)
    if (name === '') errors.newTypeName = 'Enter a name, such as Defect or Epic.'
    else if (!KEY_PATTERN.test(id)) errors.newTypeName = 'Start the name with a letter.'
    else if (taken) errors.newTypeName = `You already have ${taken.name}. Choose it above, or use another name.`
  }
  if (state.source.trim() === '') errors.source = 'Enter where the file comes from, such as tracker.'
  return errors
}

export function StepType({
  state,
  update,
  result,
  recordTypes,
  errors,
  templates,
  hiddenTypeId,
}: StepProps & {
  templates: readonly ImportTemplate[]
  /** A type this setup created, listed as the new type rather than as an existing one. */
  hiddenTypeId: string
}) {
  const id = useId()
  const ins = result.inspection
  const suggested = ins.suggestedType
  const types = recordTypes.filter((t) => t.id !== hiddenTypeId)
  const pick = (typeId: string) => update((s) => renameDefault(chooseType(s, typeId, recordTypes, ins.headers), recordTypes, templates))
  const isNew = state.recordType === NEW_TYPE

  return (
    <div className="space-y-5">
      <p className="flex items-center gap-2 text-sm">
        <FileSpreadsheet aria-hidden="true" className="size-5 text-accent-deep" />
        We read {formatCount(ins.rowCount)} {ins.rowCount === 1 ? 'row' : 'rows'} and {formatCount(ins.headers.length)}{' '}
        {ins.headers.length === 1 ? 'column' : 'columns'}.
      </p>

      <fieldset className="space-y-2">
        <legend className="font-medium">What kind of records does it hold?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {[...types.map((t) => ({ value: t.id, name: t.name })), { value: NEW_TYPE, name: 'A new type' }].map((o) => {
            const hint = o.value === suggested ? 'We think it’s this one.' : ''
            const inputId = `${id}-${o.value}`
            return (
              <div key={o.value} className={optionClass}>
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-type`}
                  className="mt-1"
                  checked={state.recordType === o.value}
                  aria-describedby={hint ? `${inputId}-hint` : undefined}
                  onChange={() => pick(o.value)}
                />
                <div>
                  <label htmlFor={inputId} className="block cursor-pointer font-medium">
                    {o.name}
                  </label>
                  {hint && (
                    <p id={`${inputId}-hint`} className="flex items-center gap-1 text-sm text-ink/80">
                      <Sparkles aria-hidden="true" className="size-4 text-accent-deep" />
                      {hint}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </fieldset>

      {isNew && (
        <div className="ov-enter grid gap-3 rounded-md border border-accent/40 bg-cream p-4 sm:grid-cols-2">
          <TextField
            label="Name"
            hint="One item, such as Defect, Epic or Incident."
            value={state.newType.name}
            errors={errors.newTypeName ? [errors.newTypeName] : []}
            onChange={(e) => {
              const name = e.target.value
              update((s) => renameDefault(setNewType(s, { name }, recordTypes), recordTypes, templates))
            }}
          />
          <TextField
            label="Priorities, highest first"
            hint="From the file’s values. Separate them with commas; leave it empty if there are none."
            value={state.newType.priorities}
            onChange={(e) => {
              const priorities = e.target.value
              update((s) => setNewType(s, { priorities }, recordTypes))
            }}
          />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Exported from"
          hint="The system the file comes from, such as tracker. Items are matched by this name and their ID."
          value={state.source}
          errors={errors.source ? [errors.source] : []}
          onChange={(e) => {
            const source = e.target.value
            update((s) => ({ ...s, source }))
          }}
        />
        <div className="space-y-1">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="mt-1"
              checked={state.fullExport}
              aria-describedby={`${id}-full-hint`}
              onChange={(e) => {
                const fullExport = e.target.checked
                update((s) => ({ ...s, fullExport }))
              }}
            />
            This file lists every item, not only recent changes
          </label>
          <p id={`${id}-full-hint`} className="text-sm text-ink/80">
            Then an open item missing from a later upload can be marked cancelled.
          </p>
        </div>
      </div>
    </div>
  )
}
