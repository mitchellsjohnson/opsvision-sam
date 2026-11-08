import { CircleHelp, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import type { RecordType } from '../../api/queries'
import { inputClass } from '../admin/formUi'
import {
  fieldLabel,
  formatCount,
  missingText,
  type AnswerState,
  type Questions,
  type SubjectQuestion,
  type ValueQuestion,
} from './recordsModel'

export interface SubjectOption {
  id: string
  name: string
}

export interface DateQuestion {
  column: string
  example: string
  monthFirst: string
  dayFirst: string
}

type SetAnswers = (update: (prev: AnswerState) => AnswerState) => void

const MISSING_SHOWN = 10

function rowsText(n: number) {
  return `${formatCount(n)} ${n === 1 ? 'row' : 'rows'}`
}

function SubjectPicker({
  q,
  choice,
  options,
  names,
  onChoose,
}: {
  q: SubjectQuestion
  choice: string
  options: readonly SubjectOption[]
  names: ReadonlyMap<string, string>
  onChoose: (choice: string) => void
}) {
  const id = useId()
  const best = [...new Set([q.suggestedId, ...q.candidates].filter((c) => c !== '' && names.has(c)))]
  const rest = options.filter((o) => !best.includes(o.id))
  const parentName = q.parentUnitId ? (names.get(q.parentUnitId) ?? q.value) : ''
  const hint = q.parentUnitId
    ? `“${parentName}” has teams under it, so its own rows would hide their numbers. Pick a team, or create “${parentName} (shared)” for work the teams share.`
    : choice === ''
      ? 'Not answered yet: these rows wait until you pick one.'
      : q.suggestedId !== '' && choice === `to:${q.suggestedId}`
        ? 'Our best guess. Change it if it’s wrong.'
        : ''
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        “{q.value}” · {rowsText(q.rows)}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-ink/80">
          {hint}
        </p>
      )}
      <select
        id={id}
        className={`${inputClass} max-w-md`}
        value={choice}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChoose(e.target.value)}
      >
        <option value="">Choose a product or team</option>
        {q.parentUnitId && <option value={`shared:${q.parentUnitId}`}>Create “{parentName} (shared)”</option>}
        {best.length > 0 && (
          <optgroup label="Best matches">
            {best.map((c) => (
              <option key={c} value={`to:${c}`}>
                {names.get(c)}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="All products and teams">
          {rest.map((o) => (
            <option key={o.id} value={`to:${o.id}`}>
              {o.name}
            </option>
          ))}
        </optgroup>
        <option value="ignore">Ignore these rows</option>
      </select>
    </div>
  )
}

const STATE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

function valueOptions(field: string, rt: RecordType | undefined): { value: string; label: string }[] | null {
  if (field === 'priority') {
    return [...(rt?.priorities ?? []).map((p) => ({ value: p, label: p })), { value: 'none', label: 'No priority' }]
  }
  if (field === 'state') return STATE_OPTIONS
  if (rt?.attributes.find((a) => a.key === field)?.type === 'bool') {
    return [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]
  }
  return null
}

function ValuePicker({
  q,
  value,
  recordType,
  onChoose,
}: {
  q: ValueQuestion
  value: string
  recordType: RecordType | undefined
  onChoose: (value: string) => void
}) {
  const id = useId()
  const word = q.field === 'state' ? 'status' : fieldLabel(q.field, recordType?.attributes).toLowerCase()
  const options = valueOptions(q.field, recordType)
  const label = (
    <label htmlFor={id} className="block text-sm font-medium">
      New {word} “{q.value}” · {rowsText(q.count)}
    </label>
  )
  return (
    <div>
      {label}
      {options ? (
        <select id={id} className={`${inputClass} max-w-xs`} value={value} onChange={(e) => onChoose(e.target.value)}>
          <option value="">Choose what it means</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} className={`${inputClass} max-w-xs`} value={value} onChange={(e) => onChoose(e.target.value)} />
      )}
    </div>
  )
}

/** The questions a preview asks, each answerable in place; answers re-run the preview. */
export function NeedsInput({
  questions,
  answers,
  setAnswers,
  subjectOptions,
  names,
  recordType,
  date,
  missing,
  fullExport,
  duplicates,
}: {
  questions: Questions
  answers: AnswerState
  setAnswers: SetAnswers
  subjectOptions: readonly SubjectOption[]
  names: ReadonlyMap<string, string>
  recordType: RecordType | undefined
  date: DateQuestion | null
  missing: readonly string[]
  fullExport: boolean
  /** Rows that share an ID; they can only be fixed in the export. */
  duplicates: readonly string[]
}) {
  const dateName = useId()
  const missingHint = useId()
  return (
    <div className="space-y-4">
      {questions.subjects.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="font-medium">Products and teams</legend>
          <p className="text-sm text-ink/80">
            These values aren’t linked to a product or team yet. We’ll remember your answer for next time.
          </p>
          {questions.subjects.map((q) => (
            <SubjectPicker
              key={q.value}
              q={q}
              choice={answers.subjects[q.value] ?? ''}
              options={subjectOptions}
              names={names}
              onChoose={(choice) => setAnswers((a) => ({ ...a, subjects: { ...a.subjects, [q.value]: choice } }))}
            />
          ))}
        </fieldset>
      )}

      {questions.values.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="font-medium">New values</legend>
          <p className="text-sm text-ink/80">The file uses values we haven’t seen. Tell us what they mean.</p>
          {questions.values.map((q) => (
            <ValuePicker
              key={`${q.field}-${q.value}`}
              q={q}
              value={answers.values[q.field]?.[q.value] ?? ''}
              recordType={recordType}
              onChoose={(v) =>
                setAnswers((a) => ({ ...a, values: { ...a.values, [q.field]: { ...a.values[q.field], [q.value]: v } } }))
              }
            />
          ))}
        </fieldset>
      )}

      {date && (
        <fieldset className="space-y-1">
          <legend className="font-medium">
            In “{date.column}”, is {date.example} {date.monthFirst} or {date.dayFirst}?
          </legend>
          {(
            [
              ['mdy', `${date.monthFirst} (month first)`],
              ['dmy', `${date.dayFirst} (day first)`],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={dateName}
                value={value}
                checked={answers.dateOrder === value}
                onChange={() => setAnswers((a) => ({ ...a, dateOrder: value }))}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}

      {duplicates.length > 0 && (
        <ul className="space-y-1">
          {duplicates.map((d) => (
            <li key={d} className="flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-y" />
              <span>{d}</span>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1 font-medium">
            <CircleHelp aria-hidden="true" className="size-4 text-accent-deep" />
            <span>{missingText(missing.length)}</span>
          </p>
          <p className="text-sm text-ink/80">
            {missing.slice(0, MISSING_SHOWN).join(', ')}
            {missing.length > MISSING_SHOWN ? ` and ${formatCount(missing.length - MISSING_SHOWN)} more` : ''}
          </p>
          {fullExport && (
            <>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={answers.markMissingCancelled}
                  aria-describedby={missingHint}
                  onChange={(e) => setAnswers((a) => ({ ...a, markMissingCancelled: e.target.checked }))}
                />
                Mark them cancelled
              </label>
              <p id={missingHint} className="text-sm text-ink/80">
                This file lists every record, so ones it leaves out were probably closed in the tracker.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
