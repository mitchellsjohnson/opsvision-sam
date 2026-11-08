import { useEffect, useId, useRef, useState } from 'react'
import { useRecordValues } from '../../api/queries'
import {
  dateFieldsOf,
  defaultValue,
  isComplete,
  newRow,
  opsFor,
  type ConditionField,
  type ConditionOp,
  type ConditionRow,
} from './conditionModel'
import { FieldMessages, inputClass, secondaryButton } from './formUi'

export interface ConditionBuilderProps {
  legend: string
  fields: readonly ConditionField[]
  rows: readonly ConditionRow[]
  onChange: (rows: ConditionRow[]) => void
  /** The record type whose stored values the value pickers offer. */
  recordType?: string
  /** Values to offer for text fields when the stored records have none (such as products and teams). */
  knownValues?: Readonly<Record<string, readonly string[]>>
  /** Problems with the whole filter, such as one the server reported. */
  errors?: readonly string[]
}

/** A comma-separated list input that keeps what you type until it parses. */
function ListInput({
  label,
  describedBy,
  value,
  listId,
  onChange,
}: {
  label: string
  describedBy: string
  value: readonly string[]
  listId?: string
  onChange: (values: string[]) => void
}) {
  const parse = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '')
  const key = value.join('\u0000')
  const [text, setText] = useState(value.join(', '))
  const [seen, setSeen] = useState(key)
  if (key !== seen) {
    setSeen(key)
    if (parse(text).join('\u0000') !== key) setText(value.join(', '))
  }
  return (
    <input
      aria-label={label}
      aria-describedby={describedBy}
      className={inputClass}
      list={listId}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const next = parse(e.target.value)
        setSeen(next.join('\u0000'))
        onChange(next)
      }}
    />
  )
}

/**
 * Rows of field · operator · value that must all hold. Values are picked
 * from lists wherever the field has known values: the values stored records
 * hold, else `knownValues`. Unfinished rows are shown as such and left out of
 * the filter.
 */
export function ConditionBuilder({
  legend,
  fields,
  rows,
  onChange,
  recordType = '',
  knownValues = {},
  errors = [],
}: ConditionBuilderProps) {
  const id = useId()
  const addRef = useRef<HTMLButtonElement>(null)
  const focusRow = useRef<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const dates = dateFieldsOf(fields)
  const errId = `${id}-err`

  useEffect(() => {
    if (focusRow.current === null) return
    const i = focusRow.current
    focusRow.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"] select`)?.focus()
  })

  const setRow = (i: number, row: ConditionRow) => onChange(rows.map((r, j) => (j === i ? row : r)))

  function changeField(i: number, key: string) {
    const f = byKey.get(key)
    if (f) setRow(i, newRow(f, fields))
  }

  function changeOp(i: number, row: ConditionRow, op: ConditionOp) {
    const f = byKey.get(row.field)
    if (!f) return
    setRow(i, { field: row.field, op, value: defaultValue(f, op, fields, row.value) })
  }

  return (
    <fieldset className="space-y-2 rounded-md border border-ink/20 p-3" aria-describedby={errors.length > 0 ? errId : undefined}>
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <p id={`${id}-hint`} className="text-sm text-ink/80">
        {rows.length === 0 ? 'No conditions: every record counts.' : 'A record counts when it matches every condition.'}
      </p>
      {rows.length > 0 && (
        <ol ref={listRef} className="space-y-2">
          {rows.map((row, i) => {
            const n = i + 1
            const f = byKey.get(row.field)
            const kind = f?.kind ?? 'text'
            const ops = opsFor(kind)
            const done = isComplete(row, dates)
            return (
              <li key={i} data-row={i} className="flex flex-wrap items-start gap-2">
                <select
                  aria-label={`Condition ${n} field`}
                  className={`${inputClass} w-auto`}
                  value={row.field}
                  onChange={(e) => changeField(i, e.target.value)}
                >
                  {!f && <option value={row.field}>{row.field}</option>}
                  {fields.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Condition ${n} operator`}
                  className={`${inputClass} w-auto`}
                  value={row.op}
                  onChange={(e) => changeOp(i, row, e.target.value as ConditionOp)}
                >
                  {ops.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <ValueEditor
                  n={n}
                  row={row}
                  field={f}
                  fields={fields}
                  recordType={recordType}
                  known={f ? knownValues[f.key] : undefined}
                  listId={`${id}-values-${i}`}
                  hintId={`${id}-list-hint`}
                  onChange={(value) => setRow(i, { ...row, value })}
                />
                <button
                  type="button"
                  className={`${secondaryButton} mt-1`}
                  aria-label={`Remove condition ${n}`}
                  onClick={() => {
                    onChange(rows.filter((_, j) => j !== i))
                    addRef.current?.focus()
                  }}
                >
                  Remove
                </button>
                {!done && <p className="basis-full text-sm text-ink/80">Not used until it has a value.</p>}
              </li>
            )
          })}
        </ol>
      )}
      <p id={`${id}-list-hint`} className="sr-only">
        Separate values with commas.
      </p>
      <button
        ref={addRef}
        type="button"
        className={secondaryButton}
        onClick={() => {
          const first = fields[0]
          if (!first) return
          focusRow.current = rows.length
          onChange([...rows, newRow(first, fields)])
        }}
      >
        Add condition
      </button>
      <FieldMessages id={errId} errors={errors} />
    </fieldset>
  )
}

/** How many stored values "is one of" offers as checkboxes. */
const CHECKBOX_LIMIT = 20

interface Suggestion {
  value: string
  count?: number
}

/** The values to offer for a text field: what stored records hold, else the known values. */
function useSuggestions(recordType: string, field: ConditionField | undefined, known: readonly string[] | undefined): Suggestion[] {
  const suggestable = field?.kind === 'text' && field.key !== 'title'
  const stored = useRecordValues(recordType, field?.key ?? '', suggestable)
  if (!suggestable) return []
  if (stored.data && stored.data.length > 0) return stored.data
  return (known ?? []).map((value) => ({ value }))
}

function countLabel(s: Suggestion): string {
  return s.count === undefined ? s.value : `${s.value} (${s.count.toLocaleString('en-US')})`
}

function ValueEditor({
  n,
  row,
  field,
  fields,
  recordType,
  known,
  listId,
  hintId,
  onChange,
}: {
  n: number
  row: ConditionRow
  field: ConditionField | undefined
  fields: readonly ConditionField[]
  recordType: string
  known: readonly string[] | undefined
  listId: string
  hintId: string
  onChange: (value: ConditionRow['value']) => void
}) {
  const suggestions = useSuggestions(recordType, field, known)
  const label = `Condition ${n} value`
  if (row.op === 'is_empty' || row.op === 'not_empty' || !field) return null
  const text = typeof row.value === 'string' ? row.value : ''

  if (field.kind === 'bool') {
    return (
      <select
        aria-label={label}
        className={`${inputClass} w-auto`}
        value={row.value === false ? 'no' : 'yes'}
        onChange={(e) => onChange(e.target.value === 'yes')}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    )
  }
  if (field.kind === 'date') {
    return (
      <select aria-label={label} className={`${inputClass} w-auto`} value={text} onChange={(e) => onChange(e.target.value)}>
        {text === '' && <option value="">Choose a date</option>}
        {fields
          .filter((x) => x.kind === 'date' && x.key !== field.key)
          .map((x) => (
            <option key={x.key} value={x.key}>
              the {x.label.toLowerCase()}
            </option>
          ))}
      </select>
    )
  }
  if (field.kind === 'choice') {
    const options = field.options ?? []
    if (row.op === 'one_of') {
      const chosen = new Set(Array.isArray(row.value) ? row.value : [])
      return (
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1 pt-2">
          <legend className="sr-only">{`Condition ${n} values`}</legend>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={chosen.has(o.value)}
                onChange={(e) =>
                  onChange(options.map((x) => x.value).filter((v) => (v === o.value ? e.target.checked : chosen.has(v))))
                }
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      )
    }
    return (
      <select aria-label={label} className={`${inputClass} w-auto`} value={text} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.kind === 'number') {
    return (
      <input
        aria-label={label}
        inputMode="decimal"
        className={`${inputClass} w-28`}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  const datalist =
    suggestions.length > 0 ? (
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.value} value={s.value} label={countLabel(s)} />
        ))}
      </datalist>
    ) : null
  const list = datalist ? listId : undefined

  if (row.op === 'one_of') {
    const chosen = Array.isArray(row.value) ? row.value : []
    const offered = suggestions.slice(0, CHECKBOX_LIMIT)
    if (offered.length === 0) {
      return <ListInput label={`Condition ${n} values`} describedBy={hintId} value={chosen} onChange={onChange} />
    }
    const offeredValues = new Set(offered.map((s) => s.value))
    const others = chosen.filter((v) => !offeredValues.has(v))
    return (
      <div className="space-y-1 pt-2">
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="sr-only">{`Condition ${n} values`}</legend>
          {offered.map((s) => (
            <label key={s.value} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(s.value)}
                onChange={(e) =>
                  onChange([
                    ...offered.map((x) => x.value).filter((v) => (v === s.value ? e.target.checked : chosen.includes(v))),
                    ...others,
                  ])
                }
              />
              {countLabel(s)}
            </label>
          ))}
        </fieldset>
        <ListInput
          label={`Condition ${n} other values`}
          describedBy={hintId}
          listId={list}
          value={others}
          onChange={(next) => onChange([...chosen.filter((v) => offeredValues.has(v)), ...next])}
        />
        {datalist}
      </div>
    )
  }
  return (
    <>
      <input aria-label={label} className={`${inputClass} w-auto`} list={list} value={text} onChange={(e) => onChange(e.target.value)} />
      {datalist}
    </>
  )
}
