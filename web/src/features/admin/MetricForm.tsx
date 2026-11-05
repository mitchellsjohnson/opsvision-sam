import { useId, useRef, useState } from 'react'
import type { ErrorDetail } from '../../api/errors'
import type { ItemKind, Level } from '../../api/queries'
import type { components } from '../../api/schema'
import {
  COMPARE_OPTIONS,
  DIRECTION_OPTIONS,
  FORMAT_OPTIONS,
  FREQUENCY_OPTIONS,
  OP_OPTIONS,
  RULE_OPTIONS,
  advancedText,
  atPath,
  buildBands,
  conditionBands,
  describeUnder,
  elseStatus,
  parseAdvanced,
  underPath,
  withAdvanced,
  withRuleType,
  type Band,
  type Category,
  type MetricRow,
  type RuleType,
  type ScaleStep,
} from './methodologyModel'
import {
  FieldMessages,
  FormError,
  SelectField,
  TextAreaField,
  TextField,
  inputClass,
  secondaryButton,
} from './formUi'

type StatusLevel = components['schemas']['StatusLevel']

export interface MetricFormProps {
  row: MetricRow
  /** Position of the metric in the draft; validation paths are `metrics[index].…`. */
  index: number
  categories: readonly Category[]
  statusScale: readonly StatusLevel[]
  levels: readonly Level[]
  kinds: readonly ItemKind[]
  /** Every validation problem found by the last check. */
  errors: readonly ErrorDetail[]
  onChange: (row: MetricRow) => void
  /** Saves the draft and validates it. */
  onCheck: () => void
  checking: boolean
}

/** A number input that lets you type "-" or "1." on the way to a number. */
function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  // Take the value from outside only when it is not what the text already says.
  if (value !== seen) {
    setSeen(value)
    if (Number(text) !== value) setText(String(value))
  }
  return (
    <input
      type="number"
      step="any"
      aria-label={label}
      className={inputClass}
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

function statusOptions(scale: readonly StatusLevel[], current: readonly string[], blank?: string) {
  const known = new Set(scale.map((s) => s.key))
  const opts = scale.map((s) => ({ value: s.key, label: `${s.key} (${s.label})` }))
  for (const c of current) if (c !== '' && !known.has(c)) opts.push({ value: c, label: `${c} (not in the status scale)` })
  return blank === undefined ? opts : [{ value: '', label: blank }, ...opts]
}

function PlainSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <select aria-label={label} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * The condition rows of a bands or change rule, then the final "else" row.
 * Rows are checked in order and the first match wins.
 */
function BandsEditor({
  legend,
  bands,
  statusScale,
  onChange,
  errors,
}: {
  legend: string
  bands: readonly Band[] | undefined
  statusScale: readonly StatusLevel[]
  onChange: (bands: Band[]) => void
  errors: readonly string[]
}) {
  const rows = conditionBands(bands)
  const otherwise = elseStatus(bands)
  const addRef = useRef<HTMLButtonElement>(null)
  const used = [...rows.map((b) => b.status), otherwise]
  const first = statusScale[0]?.key ?? ''
  const errId = useId()

  const setRow = (i: number, patch: Partial<Band>) =>
    onChange(buildBands(rows.map((b, j) => (j === i ? { ...b, ...patch } : b)), otherwise))

  return (
    <fieldset className="rounded-md border border-ink/20 p-3" aria-describedby={errors.length > 0 ? errId : undefined}>
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{legend}. The first matching row decides the status.</caption>
        <thead>
          <tr>
            <th scope="col" className="pr-2 font-medium">
              Status
            </th>
            <th scope="col" className="pr-2 font-medium">
              When the value is
            </th>
            <th scope="col" className="pr-2 font-medium">
              Value
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={i}>
              <td className="pr-2 align-top">
                <PlainSelect
                  label={`Band ${i + 1} status`}
                  value={b.status}
                  options={statusOptions(statusScale, used)}
                  onChange={(status) => setRow(i, { status })}
                />
              </td>
              <td className="pr-2 align-top">
                <PlainSelect
                  label={`Band ${i + 1} operator`}
                  value={b.op}
                  options={OP_OPTIONS}
                  onChange={(op) => setRow(i, { op })}
                />
              </td>
              <td className="pr-2 align-top">
                <NumberInput label={`Band ${i + 1} value`} value={b.value} onChange={(value) => setRow(i, { value })} />
              </td>
              <td className="align-top">
                <button
                  type="button"
                  className={`${secondaryButton} mt-1`}
                  aria-label={`Remove band ${i + 1}`}
                  onClick={() => {
                    onChange(buildBands(rows.filter((_, j) => j !== i), otherwise))
                    addRef.current?.focus()
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td className="pr-2 align-top">
              <PlainSelect
                label="Else status"
                value={otherwise}
                options={statusOptions(statusScale, used, 'Choose a status')}
                onChange={(status) => onChange(buildBands(rows, status))}
              />
            </td>
            <td colSpan={3} className="pt-2 align-top">
              Otherwise (no other row matches)
            </td>
          </tr>
        </tbody>
      </table>
      <button
        ref={addRef}
        type="button"
        className={`${secondaryButton} mt-2`}
        onClick={() => onChange(buildBands([...rows, { status: first, op: '>=', value: 0 }], otherwise))}
      >
        Add band
      </button>
      <FieldMessages id={errId} errors={errors} />
    </fieldset>
  )
}

function ScaleEditor({
  steps,
  statusScale,
  onChange,
  errors,
}: {
  steps: readonly ScaleStep[]
  statusScale: readonly StatusLevel[]
  onChange: (steps: ScaleStep[]) => void
  errors: readonly string[]
}) {
  const addRef = useRef<HTMLButtonElement>(null)
  const errId = useId()
  const set = (i: number, patch: Partial<ScaleStep>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <fieldset className="rounded-md border border-ink/20 p-3" aria-describedby={errors.length > 0 ? errId : undefined}>
      <legend className="px-1 text-sm font-medium">Scale steps</legend>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Scale steps. The status of a step applies from its minimum value.</caption>
        <thead>
          <tr>
            <th scope="col" className="pr-2 font-medium">
              Status
            </th>
            <th scope="col" className="pr-2 font-medium">
              From a value of at least
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={i}>
              <td className="pr-2 align-top">
                <PlainSelect
                  label={`Step ${i + 1} status`}
                  value={s.status}
                  options={statusOptions(statusScale, [s.status])}
                  onChange={(status) => set(i, { status })}
                />
              </td>
              <td className="pr-2 align-top">
                <NumberInput label={`Step ${i + 1} minimum`} value={s.min} onChange={(min) => set(i, { min })} />
              </td>
              <td className="align-top">
                <button
                  type="button"
                  className={`${secondaryButton} mt-1`}
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => {
                    onChange(steps.filter((_, j) => j !== i))
                    addRef.current?.focus()
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        ref={addRef}
        type="button"
        className={`${secondaryButton} mt-2`}
        onClick={() => onChange([...steps, { status: statusScale[0]?.key ?? '', min: 0 }])}
      >
        Add step
      </button>
      <FieldMessages id={errId} errors={errors} />
    </fieldset>
  )
}

export function MetricForm({
  row,
  index,
  categories,
  statusScale,
  levels,
  kinds,
  errors,
  onChange,
  onCheck,
  checking,
}: MetricFormProps) {
  const m = row.metric
  const base = `metrics[${index}]`
  const statusKeys = statusScale.map((s) => s.key)
  const set = (patch: Partial<typeof m>) => onChange({ ...row, metric: { ...m, ...patch } })
  const field = (name: string) => atPath(errors, `${base}.${name}`)

  const hasSubject = (kind: 'level' | 'item_kind', id: string) =>
    m.reportedAt.some((s) => s.kind === kind && s.id === id)
  const toggleSubject = (kind: 'level' | 'item_kind', id: string, on: boolean) =>
    set({
      reportedAt: on
        ? [...m.reportedAt, { kind, id }]
        : m.reportedAt.filter((s) => !(s.kind === kind && s.id === id)),
    })

  const categoryOptions = [
    ...(categories.some((c) => c.id === m.categoryId) ? [] : [{ value: m.categoryId, label: m.categoryId === '' ? 'Choose a category' : `${m.categoryId} (unknown)` }]),
    ...categories.map((c) => ({ value: c.id, label: c.name || c.id })),
  ]

  // Errors in the rule's own parts are shown with the editor they belong to.
  const bandErrors = [...describeUnder(errors, `${base}.rule.bands`), ...atPath(errors, `${base}.rule.compare`)]
  const ruleOwn = underPath(errors, `${base}.rule`)
    .filter((e) => !/^\.(bands|scale|perSubject|compare)/.test(e.rest))
    .map((e) => e.message)
  const scaleErrors = describeUnder(errors, `${base}.rule.scale`)
  const perSubjectErrors = describeUnder(errors, `${base}.rule.perSubject`)

  const claimed = new Set([
    'name', 'key', 'categoryId', 'formula', 'format', 'direction', 'frequency',
  ])
  const other = underPath(errors, base)
    .filter((e) => {
      const name = /^\.(\w+)/.exec(e.rest)?.[1] ?? ''
      return !claimed.has(name) && name !== 'rule' && name !== 'reportedAt' && name !== 'targets'
    })
    .map((e) => `${e.rest.replace(/^\./, '')}: ${e.message}`)

  const advancedShown = row.advancedText ?? advancedText(m)
  const advancedErrors = [
    ...(row.advancedError ? [row.advancedError] : []),
    ...describeUnder(errors, `${base}.targets`),
  ]
  const advId = useId()
  const reportedAtErrors = describeUnder(errors, `${base}.reportedAt`)

  function setAdvanced(text: string) {
    const parsed = parseAdvanced(text)
    if (parsed.ok) {
      onChange({ ...row, metric: withAdvanced(m, parsed.value), advancedText: text, advancedError: undefined })
    } else {
      onChange({ ...row, advancedText: text, advancedError: parsed.error })
    }
  }

  return (
    <div className="space-y-4">
      <FormError messages={[...ruleOwn, ...other]} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" value={m.name} errors={field('name')} onChange={(e) => set({ name: e.target.value })} />
        <TextField
          label="Key"
          hint={row.isNew ? "Lowercase letters, digits and '_', starting with a letter." : 'The key cannot change once the metric is saved.'}
          value={m.key}
          readOnly={!row.isNew}
          errors={field('key')}
          onChange={(e) => set({ key: e.target.value })}
        />
        <SelectField
          label="Category"
          value={m.categoryId}
          options={categoryOptions}
          errors={field('categoryId')}
          onChange={(e) => set({ categoryId: e.target.value })}
        />
        <SelectField
          label="Direction"
          value={m.direction}
          options={DIRECTION_OPTIONS}
          errors={field('direction')}
          onChange={(e) => set({ direction: e.target.value as typeof m.direction })}
        />
        <SelectField
          label="Frequency"
          value={m.frequency}
          options={FREQUENCY_OPTIONS}
          errors={field('frequency')}
          onChange={(e) => set({ frequency: e.target.value as typeof m.frequency })}
        />
        <SelectField
          label="Format"
          value={m.format}
          options={FORMAT_OPTIONS}
          errors={field('format')}
          onChange={(e) => set({ format: e.target.value as typeof m.format })}
        />
      </div>

      <div>
        <TextField
          label="Formula"
          hint="Uses measure keys, such as closed / total * 100."
          value={m.formula}
          errors={field('formula')}
          onChange={(e) => set({ formula: e.target.value })}
        />
        <button type="button" className={`${secondaryButton} mt-2`} disabled={checking} onClick={onCheck}>
          {checking ? 'Validating…' : 'Check formula'}
        </button>
        <span className="ml-2 text-sm text-ink/80">Saves the draft, then validates every formula and rule in it.</span>
      </div>

      <fieldset
        className="rounded-md border border-ink/20 p-3"
        aria-describedby={reportedAtErrors.length > 0 ? `${advId}-rep` : undefined}
      >
        <legend className="px-1 text-sm font-medium">Reported at</legend>
        {levels.length === 0 && kinds.length === 0 && <p className="text-sm">No org levels or item kinds are defined yet.</p>}
        <div className="grid gap-1 sm:grid-cols-2">
          {levels.map((l) => (
            <label key={`level-${l.id}`} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasSubject('level', l.id)}
                onChange={(e) => toggleSubject('level', l.id, e.target.checked)}
              />
              Org level: {l.name}
            </label>
          ))}
          {kinds.map((k) => (
            <label key={`kind-${k.id}`} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasSubject('item_kind', k.id)}
                onChange={(e) => toggleSubject('item_kind', k.id, e.target.checked)}
              />
              Item kind: {k.name}
            </label>
          ))}
        </div>
        <FieldMessages id={`${advId}-rep`} errors={reportedAtErrors} />
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={m.rollItemsToOrg} onChange={(e) => set({ rollItemsToOrg: e.target.checked })} />
        Roll item values up to their org unit
      </label>

      <fieldset className="space-y-3 rounded-md border border-ink/20 p-3">
        <legend className="px-1 text-sm font-medium">Status rule</legend>
        <SelectField
          label="Rule type"
          value={m.rule.type}
          options={RULE_OPTIONS}
          onChange={(e) => set({ rule: withRuleType(m.rule, e.target.value as RuleType, statusKeys) })}
        />
        {m.rule.type === 'change' && (
          <SelectField
            label="Change is measured against"
            value={m.rule.compare ?? 'prior_period'}
            options={COMPARE_OPTIONS}
            errors={atPath(errors, `${base}.rule.compare`)}
            onChange={(e) =>
              set({ rule: { ...m.rule, compare: e.target.value as NonNullable<typeof m.rule.compare> } })
            }
          />
        )}
        {m.rule.type !== 'scale' && (
          <BandsEditor
            legend={m.rule.type === 'change' ? 'Change bands (percent change)' : 'Bands'}
            bands={m.rule.bands}
            statusScale={statusScale}
            errors={m.rule.type === 'change' ? bandErrors.filter((e) => !e.startsWith('compare')) : bandErrors}
            onChange={(bands) => set({ rule: { ...m.rule, bands } })}
          />
        )}
        {m.rule.type === 'scale' && (
          <ScaleEditor
            steps={m.rule.scale ?? []}
            statusScale={statusScale}
            errors={scaleErrors}
            onChange={(scale) => set({ rule: { ...m.rule, scale } })}
          />
        )}
        <FieldMessages id={`${advId}-ps`} errors={perSubjectErrors} />
      </fieldset>

      <TextAreaField
        label="Advanced (JSON): targets and per-subject bands"
        hint='An object with a "targets" list and a "perSubject" list of {subjectId, bands}.'
        rows={8}
        spellCheck={false}
        className="font-mono"
        value={advancedShown}
        errors={advancedErrors}
        onChange={(e) => setAdvanced(e.target.value)}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <TextAreaField label="Definition" rows={3} value={m.definition} onChange={(e) => set({ definition: e.target.value })} />
        <TextAreaField label="Notes" rows={3} value={m.notes} onChange={(e) => set({ notes: e.target.value })} />
        <TextAreaField label="Example" rows={3} value={m.example} onChange={(e) => set({ example: e.target.value })} />
        <div className="space-y-3">
          <TextField label="Source" value={m.source} onChange={(e) => set({ source: e.target.value })} />
          <TextField label="Link" type="url" value={m.link} onChange={(e) => set({ link: e.target.value })} />
        </div>
      </div>
    </div>
  )
}
