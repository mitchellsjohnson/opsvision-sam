import { Calculator } from 'lucide-react'
import { useId } from 'react'
import { useScorecards, useVersions, type RecordType } from '../../../api/queries'
import { QueryState, SelectField } from '../../admin/formUi'
import { versionInForce } from '../../admin/methodologyModel'
import { presetInfo } from '../../admin/presets'
import {
  chosenType,
  defaultPresets,
  offeredPresets,
  presetChoices,
  type StepProps,
  type WizardState,
} from './wizardModel'

function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The scorecard, its methodology, and the presets offered and chosen for the wizard's record type. */
export function usePresetPlan(state: WizardState, recordTypes: readonly RecordType[]) {
  const scorecards = useScorecards()
  const list = scorecards.data?.scorecards ?? []
  const sc = list.find((s) => s.id === state.scorecardId)?.id ?? list[0]?.id ?? ''
  const versions = useVersions(sc === '' ? undefined : sc)
  const all = versions.data?.versions ?? []
  const inForce = versionInForce(all)
  const typeId = chosenType(state, recordTypes)?.id ?? ''
  const offered = offeredPresets(state, recordTypes)
  const choices = presetChoices(inForce?.content, typeId, offered)
  const chosen = (state.presets ?? defaultPresets(choices)).filter((p) => offered.includes(p))
  return {
    scorecards: list,
    sc,
    versions: all,
    inForce,
    choices,
    chosen,
    loading: scorecards.isPending || (sc !== '' && versions.isPending),
    error: scorecards.error ?? versions.error,
  }
}

export function StepCalculate({ state, update, recordTypes }: StepProps) {
  const id = useId()
  const plan = usePresetPlan(state, recordTypes)
  const measureName = new Map((plan.inForce?.content.measures ?? []).map((m) => [m.key, m.name || m.key]))

  function toggle(preset: (typeof plan.chosen)[number], on: boolean) {
    const next = on ? [...plan.chosen.filter((p) => p !== preset), preset] : plan.chosen.filter((p) => p !== preset)
    update((s) => ({ ...s, presets: next }))
  }

  if (plan.loading || plan.error) return <QueryState isPending={plan.loading} error={plan.error} what="the methodology" />
  if (plan.sc === '') {
    return <p className="text-sm">There’s no scorecard yet, so there’s nothing to calculate. You can add calculations later in Methodology.</p>
  }

  return (
    <div className="space-y-5">
      {plan.scorecards.length > 1 && (
        <SelectField
          label="Scorecard"
          hint="The calculations go into a draft of this scorecard’s methodology."
          className="max-w-sm"
          value={plan.sc}
          options={plan.scorecards.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(e) => {
            const scorecardId = e.target.value
            update((s) => ({ ...s, scorecardId }))
          }}
        />
      )}
      <fieldset className="space-y-3" aria-describedby={`${id}-hint`}>
        <legend className="font-medium">Calculations from these records</legend>
        <p id={`${id}-hint`} className="text-sm text-ink/80">
          We picked the ones your methodology already counts. They go into a draft, so the scorecard only changes when
          you publish it.
        </p>
        <ul className="grid gap-2 md:grid-cols-2">
          {plan.choices.map((c) => {
            const info = presetInfo(c.id)
            const inputId = `${id}-${c.id}`
            const uses = c.existing.length > 0 ? `Uses your measures ${andList(c.existing.map((k) => measureName.get(k) ?? k))}.` : ''
            return (
              <li key={c.id} className="flex items-start gap-3 rounded-md border border-ink/20 bg-white p-3 has-[:checked]:border-accent">
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1"
                  checked={plan.chosen.includes(c.id)}
                  aria-describedby={`${inputId}-what${uses ? ` ${inputId}-uses` : ''}`}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
                <div className="space-y-0.5">
                  <label htmlFor={inputId} className="flex items-center gap-1.5 font-medium">
                    <Calculator aria-hidden="true" className="size-4 text-accent-deep" />
                    {info.label}
                  </label>
                  <p id={`${inputId}-what`} className="text-sm">
                    {info.sentence}
                  </p>
                  {uses && (
                    <p id={`${inputId}-uses`} className="text-sm text-ink/80">
                      {uses}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <p className="text-sm text-ink/80">You can fine-tune filters and weights later in Methodology.</p>
      </fieldset>
    </div>
  )
}
