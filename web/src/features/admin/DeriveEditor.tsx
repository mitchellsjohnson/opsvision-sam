import { useEffect, useId, useState } from 'react'
import { ApiError, type ErrorDetail } from '../../api/errors'
import { useFiscalYearStartMonth, useRecordsSample, type RecordType } from '../../api/queries'
import { currentMonth } from '../../lib/period'
import { addMonths } from './adminModel'
import { ConditionBuilder } from './ConditionBuilder'
import {
  allPriorities,
  conditionFields,
  dateFieldsOf,
  priorityLabel,
  rowsFor,
  toWhere,
  type ConditionField,
  type ConditionRow,
} from './conditionModel'
import { SelectField, TextAreaField, TextField, inputClass, linkButton, secondaryButton } from './formUi'
import { atPath, underPath, type DeriveRule, type Measure } from './methodologyModel'
import { PRESETS, applyPreset, defaultWeights, presetInfo, type PresetId, type PresetParams } from './presets'

// ---- Shared parts -------------------------------------------------------------

type Known = Readonly<Record<string, readonly string[]>>

/** A value that follows `value` once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const key = JSON.stringify(value)
  const [settled, setSettled] = useState(key)
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), ms)
    return () => clearTimeout(t)
  }, [key, ms])
  return JSON.parse(settled) as T
}

const count = (n: number) => n.toLocaleString('en-US')

/** "Last month this matches 212 records (Checkout 41, Billing 18, …)" for a filter, as you edit it. */
export function SampleLine({
  sc,
  recordType,
  bucketBy,
  where,
}: {
  sc: string
  recordType: string
  bucketBy: string
  where: string
}) {
  const fiscal = useFiscalYearStartMonth()
  const period = addMonths(currentMonth(fiscal), -1)
  const body = useDebounced({ recordType, bucketBy, period, ...(where.trim() === '' ? {} : { where }) }, 300)
  const sample = useRecordsSample(sc, body, body.recordType !== '' && body.bucketBy !== '')

  let text = ''
  if (sample.error) {
    const e = sample.error
    const whereProblem = e instanceof ApiError ? e.details.find((d) => d.path === 'where')?.message : undefined
    text = whereProblem
      ? `The filter could not be checked: ${whereProblem.replace(/^where:\s*/, '')}`
      : `Could not count matching records: ${e.message}`
  } else if (sample.data) {
    const { total, bySubject } = sample.data
    if (total === 0) text = 'Last month this matches no records.'
    else {
      const top = bySubject.slice(0, 3).map((s) => `${s.name} ${count(s.count)}`)
      const list = top.length > 0 ? ` (${top.join(', ')}${bySubject.length > top.length ? ', …' : ''})` : ''
      text = `Last month this matches ${count(total)} ${total === 1 ? 'record' : 'records'}${list}`
    }
  } else if (sample.isFetching) text = 'Counting matching records…'

  return (
    <p role="status" className="min-h-5 rounded-md bg-cream px-3 py-2 text-sm">
      {text}
    </p>
  )
}

/** A number input that lets you type "-" or "1." on the way to a number. */
function NumberInput({
  label,
  value,
  onChange,
  id,
  describedBy,
}: {
  label?: string
  value: number
  onChange: (n: number) => void
  id?: string
  describedBy?: string
}) {
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (Number(text) !== value) setText(String(value))
  }
  return (
    <input
      id={id}
      type="number"
      step="any"
      aria-label={label}
      aria-describedby={describedBy}
      className={`${inputClass} w-28`}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) {
          setSeen(n)
          onChange(n)
        }
      }}
      onBlur={() => setText(String(value))}
    />
  )
}

function WeightsEditor({
  priorities,
  weights,
  errors,
  onChange,
}: {
  priorities: readonly string[]
  weights: Record<string, number>
  errors: readonly string[]
  onChange: (weights: Record<string, number>) => void
}) {
  const errId = useId()
  return (
    <fieldset className="rounded-md border border-ink/20 p-3" aria-describedby={errors.length > 0 ? errId : undefined}>
      <legend className="px-1 text-sm font-medium">Weight per priority</legend>
      <p className="text-sm text-ink/80">Each day, an open item adds its weight to the score.</p>
      <div className="mt-2 flex flex-wrap gap-3">
        {allPriorities(priorities).map((p) => (
          <div key={p}>
            <span aria-hidden="true" className="block text-sm">
              {priorityLabel(p)}
            </span>
            <NumberInput
              label={`Weight for ${p === 'none' ? 'no priority' : p}`}
              value={weights[p] ?? 0}
              onChange={(n) => onChange({ ...weights, [p]: n })}
            />
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <p id={errId} className="mt-1 text-sm font-medium text-status-r">
          <span className="sr-only">Error: </span>
          {errors.join(' ')}
        </p>
      )}
    </fieldset>
  )
}

function dateOptions(fields: readonly ConditionField[]) {
  return fields.filter((f) => f.kind === 'date').map((f) => ({ value: f.key, label: f.label }))
}

function numberOptions(fields: readonly ConditionField[]) {
  return fields.filter((f) => f.kind === 'number').map((f) => ({ value: f.key, label: f.label }))
}

function AdvancedToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className={linkButton} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {open ? 'Hide advanced' : 'Show advanced'}
    </button>
  )
}

function CannotShow({ onReset }: { onReset: () => void }) {
  return (
    <div className="rounded-md border border-ink/20 p-3 text-sm">
      <p>The builder cannot show this filter. It is kept as written; edit it under Advanced.</p>
      <button type="button" className={`${secondaryButton} mt-2`} onClick={onReset}>
        Start over with the builder
      </button>
    </div>
  )
}

// ---- Presets ------------------------------------------------------------------

/** A preset with its blanks filled in, and the filter rows (null when only Advanced can show the filter). */
export interface PresetChoice {
  preset: PresetId
  params: PresetParams
  conditions: ConditionRow[] | null
}

/** A preset for a record type with every blank at its default. */
export function newPresetChoice(rt: RecordType, preset: PresetId = 'on_time'): PresetChoice {
  return {
    preset,
    params: {
      recordType: rt.id,
      recordTypeName: rt.name,
      where: '',
      weights: defaultWeights(rt.priorities),
      tolerance: 20,
      bucketBy: 'completedAt',
      field: 'planned',
      ageFrom: 'createdAt',
      ageTo: 'completedAt',
      unit: 'spend_k',
    },
    conditions: [],
  }
}

/** The date the live sample counts a preset's records by. */
function sampleBucket(c: PresetChoice): string {
  switch (c.preset) {
    case 'on_time':
      return 'dueAt'
    case 'weighted_open':
      return 'createdAt'
    case 'expected_value':
      return 'measuredAt'
    case 'average_age':
      return c.params.ageFrom || 'createdAt'
    default:
      return c.params.bucketBy || 'completedAt'
  }
}

export interface DeriveEditorProps {
  sc: string
  recordTypes: readonly RecordType[]
  value: PresetChoice
  onChange: (value: PresetChoice) => void
  /** Hide the record type picker (the setup wizard already knows it). */
  lockRecordType?: boolean
  /** Values seen for text fields, offered in the filter's value pickers. */
  knownValues?: Known
}

/**
 * Picks a preset and fills in its blanks, with a point-and-click filter and
 * a live count of the records it matches. Controlled: the host applies the
 * choice with `applyPreset` when the admin confirms.
 */
export function DeriveEditor({ sc, recordTypes, value, onChange, lockRecordType, knownValues }: DeriveEditorProps) {
  const id = useId()
  const [advanced, setAdvanced] = useState(value.conditions === null)
  const rt = recordTypes.find((t) => t.id === value.params.recordType)
  const fields = rt ? conditionFields(rt) : []
  const dates = dateFieldsOf(fields)
  const info = presetInfo(value.preset)
  const p = value.params
  const set = (patch: Partial<PresetParams>) => onChange({ ...value, params: { ...p, ...patch } })

  function setRecordType(next: RecordType) {
    const nextFields = conditionFields(next)
    const keep = (value.conditions ?? []).filter((r) => nextFields.some((f) => f.key === r.field))
    onChange({
      ...value,
      params: {
        ...p,
        recordType: next.id,
        recordTypeName: next.name,
        weights: defaultWeights(next.priorities),
        where: toWhere(keep, dateFieldsOf(nextFields)),
      },
      conditions: keep,
    })
  }

  const preview = applyPreset({ categories: [], measures: [], metrics: [] }, value.preset, { ...p, withMetric: false })
  const previewText = JSON.stringify(
    preview.content.measures.map((m) => ({ key: m.key, derive: m.derive })),
    null,
    2,
  )

  return (
    <div className="space-y-4">
      {!lockRecordType && (
        <SelectField
          label="Record type"
          className="max-w-sm"
          value={p.recordType}
          options={recordTypes.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(e) => {
            const next = recordTypes.find((t) => t.id === e.target.value)
            if (next) setRecordType(next)
          }}
        />
      )}

      <fieldset className="rounded-md border border-ink/20 p-3">
        <legend className="px-1 text-sm font-medium">What should we calculate?</legend>
        <div className="space-y-2">
          {PRESETS.map((preset) => (
            <div key={preset.id} className="flex items-start gap-2">
              <input
                type="radio"
                id={`${id}-${preset.id}`}
                name={`${id}-preset`}
                className="mt-1"
                checked={value.preset === preset.id}
                aria-describedby={`${id}-${preset.id}-d`}
                onChange={() => onChange({ ...value, preset: preset.id })}
              />
              <div>
                <label htmlFor={`${id}-${preset.id}`} className="text-sm font-medium">
                  {preset.label}
                </label>
                <p id={`${id}-${preset.id}-d`} className="text-sm text-ink/80">
                  {preset.sentence}
                </p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {info.blanks.includes('weights') && rt && (
        <WeightsEditor
          priorities={rt.priorities}
          weights={p.weights ?? defaultWeights(rt.priorities)}
          errors={[]}
          onChange={(weights) => set({ weights })}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {info.blanks.includes('tolerance') && (
          <div>
            <label htmlFor={`${id}-tol`} className="block text-sm font-medium">
              Allowed overrun (%)
            </label>
            <p id={`${id}-tol-h`} className="text-sm text-ink/80">
              How far actual spend may go over plan and still count as within budget.
            </p>
            <NumberInput id={`${id}-tol`} describedBy={`${id}-tol-h`} value={p.tolerance ?? 20} onChange={(tolerance) => set({ tolerance })} />
          </div>
        )}
        {info.blanks.includes('bucketBy') && (
          <SelectField
            label="Which date puts a record in a month"
            value={p.bucketBy ?? 'completedAt'}
            options={dateOptions(fields)}
            onChange={(e) => set({ bucketBy: e.target.value })}
          />
        )}
        {info.blanks.includes('field') && (
          <SelectField
            label="Number to add up"
            value={p.field ?? 'planned'}
            options={numberOptions(fields)}
            onChange={(e) => set({ field: e.target.value })}
          />
        )}
        {info.blanks.includes('ages') && (
          <>
            <SelectField
              label="Age from"
              value={p.ageFrom ?? 'createdAt'}
              options={dateOptions(fields)}
              onChange={(e) => set({ ageFrom: e.target.value })}
            />
            <SelectField
              label="Age to"
              hint="Records without this date are aged to the end of the month."
              value={p.ageTo ?? ''}
              options={[...dateOptions(fields), { value: '', label: 'The end of the month' }]}
              onChange={(e) => set({ ageTo: e.target.value })}
            />
          </>
        )}
        {info.blanks.includes('unit') && (
          <TextField
            label="Unit for planned and actual"
            hint="Used in the measure names, such as spend_k for thousands or dev_weeks."
            value={p.unit ?? ''}
            onChange={(e) => set({ unit: e.target.value.replace(/[^a-z0-9_]/g, '') })}
          />
        )}
      </div>

      {value.conditions === null ? (
        <CannotShow onReset={() => onChange({ ...value, params: { ...p, where: '' }, conditions: [] })} />
      ) : (
        <ConditionBuilder
          legend="Which records count"
          fields={fields}
          rows={value.conditions}
          recordType={p.recordType}
          knownValues={knownValues}
          onChange={(rows) => onChange({ ...value, conditions: rows, params: { ...p, where: toWhere(rows, dates) } })}
        />
      )}
      <SampleLine sc={sc} recordType={p.recordType} bucketBy={sampleBucket(value)} where={p.where ?? ''} />

      <div>
        <AdvancedToggle open={advanced} controls={`${id}-adv`} onToggle={() => setAdvanced((a) => !a)} />
        <div id={`${id}-adv`} hidden={!advanced} className="mt-2 space-y-3">
          {advanced && (
            <>
              <TextAreaField
                label="Filter expression"
                hint="Written by the filter above. Editing it here replaces the filter."
                rows={3}
                spellCheck={false}
                className="font-mono"
                value={p.where ?? ''}
                onChange={(e) => onChange({ ...value, params: { ...p, where: e.target.value }, conditions: rowsFor(e.target.value, fields) })}
              />
              <TextAreaField label="Rules this adds (JSON)" rows={8} readOnly className="font-mono" value={previewText} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- One measure's rule -----------------------------------------------------------

const OP_OPTIONS: { value: DeriveRule['op']; label: string }[] = [
  { value: 'count', label: 'Count records' },
  { value: 'sum', label: 'Add up a number' },
  { value: 'commitments', label: 'Count due-date commitments' },
  { value: 'daily_open_weighted', label: 'Weighted open items per day' },
  { value: 'age_sum', label: 'Add up ages in days' },
  { value: 'days_in_period', label: 'Days in the month (no records needed)' },
]

const OUTCOME_OPTIONS = [
  { value: 'resolved', label: 'Every commitment met or missed' },
  { value: 'met', label: 'Only commitments met on time' },
]

/** The parts of a rule that apply to its operation, filled with defaults. */
function ruleFor(op: DeriveRule['op'], prev: DeriveRule, rt: RecordType | undefined): DeriveRule {
  const next: DeriveRule = { recordType: prev.recordType, op }
  if (prev.where && op !== 'days_in_period') next.where = prev.where
  if (op === 'count' || op === 'sum' || op === 'age_sum') next.bucketBy = prev.bucketBy || 'completedAt'
  if (op === 'sum') next.field = prev.field || 'planned'
  if (op === 'commitments') next.outcome = prev.outcome || 'resolved'
  if (op === 'daily_open_weighted') next.weights = prev.weights ?? defaultWeights(rt?.priorities ?? [])
  if (op === 'age_sum') {
    next.ageFrom = prev.ageFrom || 'createdAt'
    if (prev.ageTo) next.ageTo = prev.ageTo
  }
  return next
}

function ruleBucket(rule: DeriveRule): string {
  if (rule.bucketBy) return rule.bucketBy
  if (rule.op === 'commitments') return 'dueAt'
  if (rule.op === 'daily_open_weighted') return 'createdAt'
  return rule.ageFrom || 'createdAt'
}

type JsonResult = { ok: true; rule: DeriveRule } | { ok: false; error: string }

function parseRule(text: string): JsonResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : 'could not be parsed'}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Expected an object.' }
  const r = raw as Record<string, unknown>
  if (typeof r.recordType !== 'string' || typeof r.op !== 'string') {
    return { ok: false, error: 'The rule needs a "recordType" and an "op".' }
  }
  return { ok: true, rule: raw as DeriveRule }
}

export interface DeriveRuleEditorProps {
  sc: string
  measure: Measure
  /** Position of the measure in the draft; problems are addressed `measures[index].derive.…`. */
  index: number
  recordTypes: readonly RecordType[]
  /** Every problem found by the last check. */
  errors: readonly ErrorDetail[]
  onChange: (measure: Measure) => void
  /** Saves the draft and validates it. */
  onCheck: () => void
  checking: boolean
  knownValues?: Known
}

/** Edits how one derived measure is calculated from records. */
export function DeriveRuleEditor({
  sc,
  measure,
  index,
  recordTypes,
  errors,
  onChange,
  onCheck,
  checking,
  knownValues,
}: DeriveRuleEditorProps) {
  const id = useId()
  const rule: DeriveRule = measure.derive ?? { recordType: recordTypes[0]?.id ?? '', op: 'count', bucketBy: 'completedAt' }
  const rt = recordTypes.find((t) => t.id === rule.recordType)
  const fields = rt ? conditionFields(rt) : []
  const dates = dateFieldsOf(fields)
  const where = rule.where ?? ''
  const base = `measures[${index}].derive`
  const at = (name: string) => atPath(errors, `${base}.${name}`)

  const [rows, setRows] = useState<ConditionRow[] | null>(() => rowsFor(where, fields))
  const [seenWhere, setSeenWhere] = useState(where)
  const [seenType, setSeenType] = useState(rule.recordType)
  if (where !== seenWhere || rule.recordType !== seenType) {
    setSeenWhere(where)
    setSeenType(rule.recordType)
    setRows(rowsFor(where, fields))
  }
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState('')

  const claimed = ['recordType', 'op', 'bucketBy', 'field', 'outcome', 'weights', 'ageFrom', 'ageTo', 'where']
  const otherErrors = underPath(errors, base)
    .filter((e) => !claimed.includes(/^\.(\w+)/.exec(e.rest)?.[1] ?? ''))
    .map((e) => (e.rest ? `${e.rest.replace(/^\./, '')}: ${e.message}` : e.message))
  const whereErrors = at('where')
  const jsonErrors = [...(jsonError ? [jsonError] : []), ...otherErrors]
  const errorKey = [...whereErrors, ...jsonErrors].join('\n')
  const [advanced, setAdvanced] = useState(rows === null)
  const [seenErrorKey, setSeenErrorKey] = useState(errorKey)
  if (errorKey !== seenErrorKey) {
    setSeenErrorKey(errorKey)
    if (errorKey !== '') setAdvanced(true)
  }

  function setRule(next: DeriveRule) {
    setJsonText(null)
    setJsonError('')
    if (!next.where) delete next.where
    onChange({ ...measure, source: 'derived', derive: next })
  }
  const patch = (p: Partial<DeriveRule>) => setRule({ ...rule, ...p })

  function setRows2(next: ConditionRow[]) {
    const w = toWhere(next, dates)
    setRows(next)
    setSeenWhere(w)
    patch({ where: w })
  }

  function setWhereText(text: string) {
    setRows(rowsFor(text, fields))
    setSeenWhere(text)
    patch({ where: text })
  }

  const needsRecords = rule.op !== 'days_in_period'

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Record type"
          value={rule.recordType}
          errors={at('recordType')}
          options={[
            ...(rt ? [] : [{ value: rule.recordType, label: rule.recordType === '' ? 'Choose a record type' : `${rule.recordType} (unknown)` }]),
            ...recordTypes.map((t) => ({ value: t.id, label: t.name })),
          ]}
          onChange={(e) => {
            const next = recordTypes.find((t) => t.id === e.target.value)
            const r = ruleFor(rule.op, { ...rule, recordType: e.target.value }, next)
            if (rule.op === 'daily_open_weighted') r.weights = defaultWeights(next?.priorities ?? [])
            setRule(r)
          }}
        />
        <SelectField
          label="How it is calculated"
          value={rule.op}
          errors={at('op')}
          options={OP_OPTIONS}
          onChange={(e) => setRule(ruleFor(e.target.value as DeriveRule['op'], rule, rt))}
        />
        {(rule.op === 'count' || rule.op === 'sum' || rule.op === 'age_sum') && (
          <SelectField
            label="Which date puts a record in a month"
            value={rule.bucketBy ?? ''}
            errors={at('bucketBy')}
            options={dateOptions(fields)}
            onChange={(e) => patch({ bucketBy: e.target.value })}
          />
        )}
        {rule.op === 'sum' && (
          <SelectField
            label="Number to add up"
            value={rule.field ?? ''}
            errors={at('field')}
            options={numberOptions(fields)}
            onChange={(e) => patch({ field: e.target.value })}
          />
        )}
        {rule.op === 'commitments' && (
          <SelectField
            label="Which commitments count"
            hint="Each due date is a commitment, judged in the month it falls in."
            value={rule.outcome ?? 'resolved'}
            errors={at('outcome')}
            options={OUTCOME_OPTIONS}
            onChange={(e) => patch({ outcome: e.target.value as DeriveRule['outcome'] })}
          />
        )}
        {rule.op === 'age_sum' && (
          <>
            <SelectField
              label="Age from"
              value={rule.ageFrom ?? ''}
              errors={at('ageFrom')}
              options={dateOptions(fields)}
              onChange={(e) => patch({ ageFrom: e.target.value })}
            />
            <SelectField
              label="Age to"
              hint="Records without this date are aged to the end of the month."
              value={rule.ageTo ?? ''}
              errors={at('ageTo')}
              options={[...dateOptions(fields), { value: '', label: 'The end of the month' }]}
              onChange={(e) => {
                const next: DeriveRule = { ...rule, ageTo: e.target.value }
                if (!next.ageTo) delete next.ageTo
                setRule(next)
              }}
            />
          </>
        )}
      </div>
      {rule.op === 'daily_open_weighted' && rt && (
        <WeightsEditor
          priorities={rt.priorities}
          weights={rule.weights ?? {}}
          errors={underPath(errors, `${base}.weights`).map((e) => e.message)}
          onChange={(weights) => patch({ weights })}
        />
      )}

      {needsRecords ? (
        <>
          {rows === null ? (
            <CannotShow onReset={() => setRows2([])} />
          ) : (
            <ConditionBuilder
              legend="Which records count"
              fields={fields}
              rows={rows}
              recordType={rule.recordType}
              knownValues={knownValues}
              onChange={setRows2}
            />
          )}
          <SampleLine sc={sc} recordType={rule.recordType} bucketBy={ruleBucket(rule)} where={where} />
        </>
      ) : (
        <p className="text-sm">This measure counts the days in each month, so it needs no filter.</p>
      )}

      <div>
        <button type="button" className={secondaryButton} disabled={checking} onClick={onCheck}>
          {checking ? 'Validating…' : 'Check rule'}
        </button>
        <span className="ml-2 text-sm text-ink/80">Saves the draft, then validates every rule and formula in it.</span>
      </div>

      <div>
        <AdvancedToggle open={advanced} controls={`${id}-adv`} onToggle={() => setAdvanced((a) => !a)} />
        <div id={`${id}-adv`} hidden={!advanced} className="mt-2 space-y-3">
          {advanced && (
            <>
              {needsRecords && (
                <TextAreaField
                  label="Filter expression"
                  hint="Written by the filter above. Editing it here replaces the filter."
                  rows={3}
                  spellCheck={false}
                  className="font-mono"
                  value={where}
                  errors={whereErrors}
                  onChange={(e) => setWhereText(e.target.value)}
                />
              )}
              <TextAreaField
                label="Rule (JSON)"
                rows={8}
                spellCheck={false}
                className="font-mono"
                value={jsonText ?? JSON.stringify(rule, null, 2)}
                errors={jsonErrors}
                onChange={(e) => {
                  const text = e.target.value
                  const parsed = parseRule(text)
                  if (parsed.ok) {
                    onChange({ ...measure, source: 'derived', derive: parsed.rule })
                    setJsonError('')
                  } else setJsonError(parsed.error)
                  setJsonText(text)
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
