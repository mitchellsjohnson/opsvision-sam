import { useId, useState } from 'react'
import type { Level, MetricOption, OrgUnit } from '../../api/queries'
import { forField, type FormErrors } from './adminModel'
import { FieldMessages, TextField } from './formUi'

export interface ScopeValue {
  orgUnitIds: string[]
  metricKeys: string[]
}

interface Choice {
  value: string
  label: string
  /** Extra visible context, kept out of the checkbox's name. */
  detail?: string
}

/** A searchable list of checkboxes. Selected items stay selected while the search hides them. */
function CheckList({
  legend,
  searchLabel,
  hint,
  choices,
  selected,
  onChange,
  errors,
}: {
  legend: string
  searchLabel: string
  hint: string
  choices: readonly Choice[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  errors: readonly string[]
}) {
  const [search, setSearch] = useState('')
  const hintId = useId()
  const errId = useId()
  const needle = search.trim().toLowerCase()
  const shown = needle === '' ? choices : choices.filter((c) => c.label.toLowerCase().includes(needle))
  const describedBy = [hintId, errors.length > 0 ? errId : undefined].filter(Boolean).join(' ')

  function toggle(value: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(value)
    else next.delete(value)
    // Keep the list's own order so the saved scope is stable.
    onChange(choices.filter((c) => next.has(c.value)).map((c) => c.value))
  }

  return (
    <fieldset
      className="rounded-md border border-ink/30 p-3"
      aria-describedby={describedBy}
      // A group cannot be aria-invalid; this lets a failed submit focus it.
      data-invalid={errors.length > 0 ? 'true' : undefined}
      tabIndex={errors.length > 0 ? -1 : undefined}
    >
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <p id={hintId} className="text-sm text-ink/80">
        {hint} {selected.length === 0 ? 'Nothing selected: everything.' : `${selected.length} selected.`}
      </p>
      <TextField
        className="mt-2"
        label={searchLabel}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="mt-2 max-h-48 overflow-y-auto">
        {shown.map((c, i) => (
          <li key={c.value} className="flex items-center gap-2 py-0.5">
            <input
              id={`${hintId}-c${i}`}
              type="checkbox"
              className="size-4"
              checked={selected.includes(c.value)}
              aria-describedby={c.detail ? `${hintId}-d${i}` : undefined}
              onChange={(e) => toggle(c.value, e.target.checked)}
            />
            <label htmlFor={`${hintId}-c${i}`} className="text-sm">
              {c.label}
            </label>
            {c.detail && (
              <span id={`${hintId}-d${i}`} className="text-xs text-ink/70">
                {c.detail}
              </span>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="text-sm text-ink/80">{choices.length === 0 ? 'None available.' : 'No matches.'}</li>
        )}
      </ul>
      <FieldMessages id={errId} errors={errors} />
    </fieldset>
  )
}

/**
 * Org unit and metric selection for a member's scope. Empty lists mean
 * everything, matching the API.
 */
export function ScopeEditor({
  value,
  onChange,
  units,
  levels,
  metrics,
  metricsPending,
  metricsFailed,
  errors,
}: {
  value: ScopeValue
  onChange: (next: ScopeValue) => void
  units: readonly OrgUnit[]
  levels: readonly Level[]
  metrics: readonly MetricOption[] | undefined
  metricsPending: boolean
  metricsFailed: boolean
  errors: FormErrors
}) {
  const levelName = new Map(levels.map((l) => [l.id, l.name]))
  const unitChoices: Choice[] = units.map((u) => ({
    value: u.id,
    label: u.retiredFrom ? `${u.name} (retired)` : u.name,
    detail: levelName.get(u.levelId),
  }))
  // A scope can name a metric that is no longer published; keep it visible so it can be removed.
  const known = new Set((metrics ?? []).map((m) => m.key))
  const metricChoices: Choice[] = [
    ...(metrics ?? []).map((m) => ({ value: m.key, label: m.name, detail: m.key })),
    ...value.metricKeys.filter((k) => !known.has(k)).map((k) => ({ value: k, label: k, detail: 'not published' })),
  ]
  return (
    <div className="space-y-3">
      <CheckList
        legend="Org units"
        searchLabel="Search org units"
        hint="Limit this person to these units and the units below them."
        choices={unitChoices}
        selected={value.orgUnitIds}
        onChange={(orgUnitIds) => onChange({ ...value, orgUnitIds })}
        errors={forField(errors, 'scope.orgUnitIds')}
      />
      {metricsPending ? (
        <p role="status" className="text-sm">Loading metrics…</p>
      ) : (
        <>
          {metricsFailed && (
            <p role="alert" className="text-sm font-medium text-status-r">
              Could not load the published metrics. Only metrics already in the scope are listed.
            </p>
          )}
          <CheckList
            legend="Metrics"
            searchLabel="Search metrics"
            hint="Limit this person to these metrics of the published methodology."
            choices={metricChoices}
            selected={value.metricKeys}
            onChange={(metricKeys) => onChange({ ...value, metricKeys })}
            errors={forField(errors, 'scope.metricKeys')}
          />
        </>
      )}
    </div>
  )
}
