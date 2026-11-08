import { CheckCircle2, Link2 } from 'lucide-react'
import { useId } from 'react'
import { useItems, useOrgUnits } from '../../../api/queries'
import { SubjectPicker } from '../NeedsInput'
import { useSubjects } from '../RecordsImport'
import { formatCount } from '../recordsModel'
import { productQuestions, type StepProps } from './wizardModel'

function rowsText(n: number) {
  return `${formatCount(n)} ${n === 1 ? 'row' : 'rows'}`
}

const LINKED_SHOWN = 8

export function StepProducts({ state, update, result }: StepProps) {
  const id = useId()
  const units = useOrgUnits()
  const items = useItems()
  const subjects = useSubjects()
  const { linked, asks } = productQuestions(result.subjects, units.data?.units ?? [], items.data ?? [])
  const answered = asks.filter((q) => (state.answers.subjects[q.value] ?? '') !== '').length

  return (
    <div className="space-y-5">
      {linked.length > 0 && (
        <p className="flex items-start gap-2 text-sm">
          <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-deep" />
          <span>
            Already linked:{' '}
            {linked
              .slice(0, LINKED_SHOWN)
              .map((l) => (l.value === l.name ? `${l.value} (${rowsText(l.rows)})` : `${l.value} → ${l.name} (${rowsText(l.rows)})`))
              .join(', ')}
            {linked.length > LINKED_SHOWN ? ` and ${linked.length - LINKED_SHOWN} more` : ''}.
          </span>
        </p>
      )}

      {asks.length === 0 ? (
        <p className="flex items-center gap-2 font-medium text-status-g">
          <CheckCircle2 aria-hidden="true" className="size-5" />
          Every product and team in this file is already linked.
        </p>
      ) : (
        <fieldset className="space-y-3" aria-describedby={`${id}-hint`}>
          <legend className="font-medium">Which product or team is each value?</legend>
          <p id={`${id}-hint`} className="text-sm text-ink/80">
            Our best guesses are already picked. We remember your answers, so next month’s upload won’t ask again.
            Rows left unanswered wait in the preview.
          </p>
          <ul className="grid gap-3 md:grid-cols-2">
            {asks.map((q) => (
              <li key={q.value} className="rounded-md border border-ink/20 bg-white p-3">
                <SubjectPicker
                  q={q}
                  choice={state.answers.subjects[q.value] ?? ''}
                  options={subjects.options}
                  names={subjects.names}
                  onChoose={(choice) =>
                    update((s) => ({ ...s, answers: { ...s.answers, subjects: { ...s.answers.subjects, [q.value]: choice } } }))
                  }
                />
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink/80" aria-live="polite">
            {answered} of {asks.length} answered.
          </p>
        </fieldset>
      )}
    </div>
  )
}
