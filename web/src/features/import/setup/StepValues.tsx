import { CalendarDays, Info } from 'lucide-react'
import { useId } from 'react'
import { FieldMessages, inputClass } from '../../admin/formUi'
import { dateQuestion, formatCount } from '../recordsModel'
import {
  ambiguousInUse,
  chosenType,
  typePriorities,
  valueRows,
  yesNoMeaning,
  yesNoRows,
  type StepErrors,
  type StepProps,
  type WizardState,
} from './wizardModel'

export function validateValues(state: WizardState): StepErrors {
  return ambiguousInUse(state).length > 0 && state.answers.dateOrder === '' ? { dateOrder: 'Choose how to read these dates.' } : {}
}

const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
]

const STATE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

function rowsText(n: number) {
  return `${formatCount(n)} ${n === 1 ? 'row' : 'rows'}`
}

function quoted(names: readonly string[]): string {
  const q = names.map((n) => `“${n}”`)
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`
}

function ValueTable({
  title,
  hint,
  rows,
  fromSamples,
  options,
  meanings,
  onChoose,
}: {
  title: string
  hint: string
  rows: readonly { value: string; count: number }[]
  fromSamples: boolean
  options: readonly { value: string; label: string }[]
  meanings: Record<string, string>
  onChoose: (value: string, meaning: string) => void
}) {
  const id = useId()
  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-hint`}>
      <legend className="font-medium">{title}</legend>
      <p id={`${id}-hint`} className="text-sm text-ink/80">
        {hint}
        {fromSamples && ' This column wasn’t our guess, so these are from the first rows only; the preview asks about any others.'}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((r, i) => {
          const inputId = `${id}-${i}`
          return (
            <li key={r.value} className="flex flex-wrap items-end justify-between gap-2 rounded-md border border-ink/20 bg-white p-3">
              <label htmlFor={inputId} className="min-w-0 text-sm font-medium">
                {r.value === '' ? 'Blank' : `“${r.value}”`} · <span className="font-normal text-ink/80">{rowsText(r.count)}</span>
              </label>
              <select
                id={inputId}
                className={`${inputClass} w-40`}
                value={meanings[r.value] ?? ''}
                onChange={(e) => onChoose(r.value, e.target.value)}
              >
                <option value="">Choose what it means</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

export function StepValues({ state, update, result, recordTypes, errors }: StepProps) {
  const id = useId()
  const ins = result.inspection
  const ambiguous = ambiguousInUse(state)
  const date = dateQuestion(ambiguous, ins.headers, ins.samples)
  const priority = valueRows('priority', state, ins)
  const status = valueRows('state', state, ins)
  const priorities = typePriorities(state, recordTypes)
  const setMeaning = (field: 'priority' | 'state', value: string, meaning: string) =>
    update((s) => ({ ...s, maps: { ...s.maps, [field]: { ...s.maps[field], [value]: meaning } } }))
  const yesNoFields = (chosenType(state, recordTypes)?.attributes ?? [])
    .filter((a) => a.key in state.maps.yesNo)
    .map((a) => ({ key: a.key, name: a.name || a.key, rows: yesNoRows(a.key, state, ins) }))
    .filter((f) => f.rows.length > 0)
  const nothing = !date && priority.rows.length === 0 && status.rows.length === 0 && yesNoFields.length === 0

  return (
    <div className="space-y-6">
      {nothing && (
        <p className="flex items-start gap-2 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-deep" />
          Nothing to check here: this file has no priority, status or yes/no column, and its dates read only one way.
        </p>
      )}

      {date && (
        <fieldset className="space-y-2 rounded-md border border-accent/40 bg-cream p-4" aria-describedby={`${id}-date-hint`}>
          <legend className="flex items-center gap-2 px-1 font-medium">
            <CalendarDays aria-hidden="true" className="size-5 text-accent-deep" />
            Is {date.example} {date.monthFirst} or {date.dayFirst}?
          </legend>
          <p id={`${id}-date-hint`} className="text-sm text-ink/80">
            In {quoted(ambiguous)}, dates like this could be read either way. We ask once and remember.
          </p>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['mdy', `${date.monthFirst} (month first)`],
                ['dmy', `${date.dayFirst} (day first)`],
              ] as const
            ).map(([value, label], i) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-date`}
                  value={value}
                  checked={state.answers.dateOrder === value}
                  aria-invalid={i === 0 && errors.dateOrder ? true : undefined}
                  aria-describedby={errors.dateOrder ? `${id}-date-err` : undefined}
                  onChange={() => update((s) => ({ ...s, answers: { ...s.answers, dateOrder: value } }))}
                />
                {label}
              </label>
            ))}
          </div>
          <FieldMessages id={`${id}-date-err`} errors={errors.dateOrder ? [errors.dateOrder] : []} />
        </fieldset>
      )}

      {priority.rows.length > 0 && (
        <ValueTable
          title="Priority"
          hint={
            priorities.length > 0
              ? `Each value in the file, with how many rows have it, matched to your priorities (${priorities.join(', ')}).`
              : 'This type has no priorities, so every value counts as no priority.'
          }
          rows={priority.rows}
          fromSamples={priority.fromSamples}
          options={[...priorities.map((p) => ({ value: p, label: p })), { value: 'none', label: 'No priority' }]}
          meanings={state.maps.priority}
          onChoose={(v, m) => setMeaning('priority', v, m)}
        />
      )}

      {status.rows.length > 0 && (
        <ValueTable
          title="Open or closed"
          hint="Which statuses mean the work is done or cancelled. Anything new later counts as open."
          rows={status.rows}
          fromSamples={status.fromSamples}
          options={STATE_OPTIONS}
          meanings={state.maps.state}
          onChoose={(v, m) => setMeaning('state', v, m)}
        />
      )}

      {yesNoFields.map((f) => (
        <ValueTable
          key={f.key}
          title={f.name}
          hint="Which values mean yes and which mean no. These come from the first rows of the file; the preview asks about any others."
          rows={f.rows}
          fromSamples={false}
          options={YES_NO_OPTIONS}
          meanings={Object.fromEntries(f.rows.map((r) => [r.value, yesNoMeaning(state, f.key, r.value)]))}
          onChoose={(value, meaning) =>
            update((s) => ({
              ...s,
              maps: { ...s.maps, yesNo: { ...s.maps.yesNo, [f.key]: { ...s.maps.yesNo[f.key], [value]: meaning } } },
            }))
          }
        />
      ))}
    </div>
  )
}
