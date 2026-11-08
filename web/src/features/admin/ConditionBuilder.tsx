import { useEffect, useId, useRef, useState } from 'react'
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
  /** Values seen for text fields (such as products and teams), offered as suggestions. */
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
  const [text, setText] = useState(value.join(', '))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (parse(text).join('\u0000') !== value.join('\u0000')) setText(value.join(', '))
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
        setSeen(next)
        onChange(next)
      }}
    />
  )
}

/**
 * Rows of field · operator · value that must all hold. Values are picked
 * from lists wherever the field has known values. Unfinished rows are shown
 * as such and left out of the filter.
 */
export function ConditionBuilder({ legend, fields, rows, onChange, knownValues = {}, errors = [] }: ConditionBuilderProps) {
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
            const listId = f && knownValues[f.key]?.length ? `${id}-values-${f.key}` : undefined
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
                  listId={listId}
                  hintId={`${id}-list-hint`}
                  onChange={(value) => setRow(i, { ...row, value })}
                />
                {listId && f && (
                  <datalist id={listId}>
                    {(knownValues[f.key] ?? []).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                )}
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

function ValueEditor({
  n,
  row,
  field,
  fields,
  listId,
  hintId,
  onChange,
}: {
  n: number
  row: ConditionRow
  field: ConditionField | undefined
  fields: readonly ConditionField[]
  listId?: string
  hintId: string
  onChange: (value: ConditionRow['value']) => void
}) {
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
  if (row.op === 'one_of') {
    return (
      <ListInput
        label={`Condition ${n} values`}
        describedBy={hintId}
        listId={listId}
        value={Array.isArray(row.value) ? row.value : []}
        onChange={onChange}
      />
    )
  }
  return <input aria-label={label} className={`${inputClass} w-auto`} list={listId} value={text} onChange={(e) => onChange(e.target.value)} />
}
