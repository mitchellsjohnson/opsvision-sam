import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, UserCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { FieldMessages, inputClass } from '../../admin/formUi'
import { fieldLabel } from '../recordsModel'
import {
  MAIN_FIELDS,
  MORE_FIELDS,
  REQUIRED_FIELDS,
  chosenType,
  confidenceOf,
  missingRequired,
  samplesFor,
  type Confidence,
  type Inspection,
  type StepErrors,
  type StepProps,
  type WizardState,
} from './wizardModel'

const LABELS: Record<string, string> = { category: 'Category' }

const HINTS: Record<string, string> = {
  subjectKey: 'You match its values to your products and teams in a later step.',
  status: 'Also tells us which items are open, done or cancelled.',
}

const REQUIRED_MESSAGES: Record<string, string> = {
  externalId: 'Choose the column with each item’s ID.',
  subjectKey: 'Choose the column with the product or team.',
  createdAt: 'Choose the column with the date each item was created.',
}

export function validateColumns(state: WizardState): StepErrors {
  return Object.fromEntries(missingRequired(state).map((f) => [f, REQUIRED_MESSAGES[f] ?? 'Choose a column.']))
}

const CHIPS: Record<Exclude<Confidence, 'none'>, { label: string; icon: typeof CheckCircle2; className: string }> = {
  likely: { label: 'Likely', icon: CheckCircle2, className: 'bg-status-g-bg text-status-g' },
  check: { label: 'Check this', icon: AlertTriangle, className: 'bg-status-y-bg text-status-y' },
  chosen: { label: 'Your choice', icon: UserCheck, className: 'bg-cream text-accent-deep' },
}

/** How sure we are, as an icon and words (never color alone). */
function ConfidenceChip({ id, kind }: { id: string; kind: Confidence }) {
  if (kind === 'none') return null
  const chip = CHIPS[kind]
  const Icon = chip.icon
  return (
    <span id={id} className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', chip.className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {chip.label}
    </span>
  )
}

function FieldRow({
  field,
  label,
  column,
  guessColumn,
  kind,
  samples,
  headers,
  required,
  hint,
  error,
  onChange,
}: {
  field: string
  label: string
  column: string
  /** The column OpsVision guessed, if any. */
  guessColumn: string
  kind: Confidence
  samples: readonly string[]
  headers: readonly string[]
  required: boolean
  hint?: string
  error?: string
  onChange: (column: string) => void
}) {
  const id = useId()
  const guessText = guessColumn
    ? `We think this is “${guessColumn}”.`
    : required
      ? 'We couldn’t find this one. Choose its column.'
      : 'Optional.'
  const describedBy = [`${id}-guess`, kind !== 'none' ? `${id}-conf` : '', hint ? `${id}-hint` : '', error ? `${id}-err` : '']
    .filter(Boolean)
    .join(' ')
  const options = column && !headers.includes(column) ? [...headers, column] : headers
  return (
    <li
      data-field={field}
      className={clsx(
        'grid gap-x-4 gap-y-2 rounded-md border bg-white p-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]',
        error ? 'border-status-r' : kind === 'check' ? 'border-status-y/60' : 'border-ink/20',
      )}
    >
      <div>
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <select
          id={id}
          className={inputClass}
          value={column}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not in this file</option>
          {options.map((h) => (
            <option key={h} value={h}>
              {headers.includes(h) ? h : `${h} (not in this file)`}
            </option>
          ))}
        </select>
        <FieldMessages id={`${id}-err`} errors={error ? [error] : []} />
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span id={`${id}-guess`}>
            {guessText}
            {required && <span className="font-medium"> Required.</span>}
          </span>
          <ConfidenceChip id={`${id}-conf`} kind={kind} />
        </p>
        {hint && (
          <p id={`${id}-hint`} className="text-sm text-ink/80">
            {hint}
          </p>
        )}
        {samples.length > 0 && (
          <ul aria-label={`Sample values from ${column}`} className="flex flex-wrap gap-1.5">
            {samples.map((s) => (
              <li key={s} className="max-w-[16rem] truncate rounded-md bg-cream px-2 py-0.5 font-mono text-xs" title={s}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function rowProps(field: string, state: WizardState, ins: Inspection) {
  const column = state.columns[field] ?? ''
  return {
    column,
    guessColumn: ins.guesses.find((g) => g.field === field)?.column ?? '',
    kind: confidenceOf(field, column, ins.guesses),
    samples: samplesFor(field, column, ins),
  }
}

export function StepColumns({ state, update, result, recordTypes, errors }: StepProps) {
  const ins = result.inspection
  const headers = [...new Set(ins.headers.map((h) => h.trim()).filter(Boolean))]
  const rt = chosenType(state, recordTypes)
  const attributes = rt?.attributes ?? []
  const setColumn = (field: string, column: string) => update((s) => ({ ...s, columns: { ...s.columns, [field]: column } }))
  const setAttribute = (key: string, column: string) => update((s) => ({ ...s, attributes: { ...s.attributes, [key]: column } }))
  const moreInUse =
    MORE_FIELDS.some((f) => state.columns[f]) || attributes.some((a) => state.attributes[a.key]) || MORE_FIELDS.some((f) => errors[f])
  const [moreOpen, setMoreOpen] = useState(moreInUse)
  const toCheck = MAIN_FIELDS.filter((f) => confidenceOf(f, state.columns[f] ?? '', ins.guesses) === 'check').length
  const required = new Set<string>(REQUIRED_FIELDS)

  return (
    <div className="space-y-4">
      <p className="text-sm">
        We matched each field to a column and show a few values from it.{' '}
        {toCheck > 0
          ? `Look at the ${toCheck === 1 ? 'one' : toCheck} marked “Check this”, then carry on.`
          : 'Change anything that looks wrong.'}
      </p>
      <ul className="space-y-2">
        {MAIN_FIELDS.map((f) => (
          <FieldRow
            key={f}
            field={f}
            label={LABELS[f] ?? fieldLabel(f)}
            headers={headers}
            required={required.has(f)}
            hint={HINTS[f]}
            error={errors[f]}
            onChange={(c) => setColumn(f, c)}
            {...rowProps(f, state, ins)}
          />
        ))}
      </ul>
      <details open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)} className="rounded-md border border-ink/20 bg-white/60">
        <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium">More fields</summary>
        <ul className="space-y-2 p-3 pt-1">
          {MORE_FIELDS.map((f) => (
            <FieldRow
              key={f}
              field={f}
              label={fieldLabel(f)}
              headers={headers}
              required={false}
              error={errors[f]}
              onChange={(c) => setColumn(f, c)}
              {...rowProps(f, state, ins)}
            />
          ))}
          {attributes.map((a) => {
            const column = state.attributes[a.key] ?? ''
            const label = a.name || a.key
            const byName = headers.find((h) => h.toLowerCase() === label.trim().toLowerCase()) ?? ''
            return (
              <FieldRow
                key={`attr-${a.key}`}
                field={a.key}
                label={label}
                column={column}
                guessColumn={byName}
                kind={column === '' ? 'none' : column === byName ? 'likely' : 'chosen'}
                samples={samplesFor(a.key, column, ins)}
                headers={headers}
                required={false}
                onChange={(c) => setAttribute(a.key, c)}
              />
            )
          })}
        </ul>
      </details>
    </div>
  )
}
