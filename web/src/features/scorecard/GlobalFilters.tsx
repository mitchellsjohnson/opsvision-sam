import { Check } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useOrgLevels, useOrgUnits, usePutMyPreferences } from '../../api/queries'
import { useDefaultScope } from '../../shell/useDefaultScope'
import { usePeriodState } from '../../shell/usePeriodState'
import { allLabel, chosenUnits, filterLevels, levelOptions, scopeAfterChange } from './scopeFilters'

const selectClass = 'max-w-56 rounded-md border border-ink/30 bg-white px-2 py-1 text-sm'
const actionClass = 'rounded-md border border-ink/30 bg-white px-3 py-1 text-sm hover:bg-cream disabled:opacity-50'

/** How long a saved confirmation stays visible. */
const MESSAGE_MS = 4000

/**
 * The scope filters: one select per org level below the company. The
 * deepest choice is the `scope` URL param; no param means the whole company.
 * The person can save the current scope as their default.
 */
export function GlobalFilters() {
  const id = useId()
  const [view, update] = usePeriodState()
  const levels = useOrgLevels()
  const orgUnits = useOrgUnits()
  const myDefault = useDefaultScope(view.period)
  const save = usePutMyPreferences()
  const [message, setMessage] = useState('')
  const firstSelect = useRef<HTMLSelectElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  const focusIndicator = useRef(false)

  const levelList = useMemo(() => filterLevels(levels.data ?? []), [levels.data])
  const units = useMemo(() => orgUnits.data?.units ?? [], [orgUnits.data?.units])
  const chosen = useMemo(() => chosenUnits(view.scope, levelList, units), [view.scope, levelList, units])

  // A saved unit that is gone or retired for the period counts as the company.
  const savedDefault = myDefault.ready && myDefault.loaded ? myDefault.scope : undefined
  const isDefault = savedDefault !== undefined && view.scope === savedDefault

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(''), MESSAGE_MS)
    return () => clearTimeout(t)
  }, [message])

  // The button that was pressed gives way to the indicator: keep focus nearby.
  useEffect(() => {
    if (isDefault && focusIndicator.current) {
      focusIndicator.current = false
      indicator.current?.focus()
    }
  }, [isDefault])

  if (levelList.length === 0 && view.scope === '') return null

  const setScope = (scope: string) => update({ scope: scope || null })

  const saveDefault = () => {
    const scope = view.scope
    save.mutate(
      { defaultScope: scope },
      {
        onSuccess: () => {
          focusIndicator.current = true
          setMessage('Default saved')
        },
        onError: (err) => setMessage(`Could not save your default: ${err.message}`),
      },
    )
  }

  return (
    <div role="group" aria-label="Global filters" className="flex min-w-0 flex-wrap items-end gap-2">
      {levelList.map((level, i) => (
        <div key={level.id} className="flex min-w-0 flex-col text-xs font-medium">
          <label htmlFor={`${id}-${level.id}`}>{level.name}</label>
          <select
            id={`${id}-${level.id}`}
            ref={i === 0 ? firstSelect : undefined}
            className={selectClass}
            value={chosen[level.id] ?? ''}
            onChange={(e) => setScope(scopeAfterChange(i, e.target.value, levelList, chosen))}
          >
            <option value="">{allLabel(level.name)}</option>
            {levelOptions(i, levelList, chosen, units, view.period).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      ))}

      {view.scope !== '' && (
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            setScope('')
            firstSelect.current?.focus()
          }}
        >
          Clear
        </button>
      )}

      {savedDefault !== undefined &&
        (isDefault ? (
          <span ref={indicator} tabIndex={-1} className="inline-flex items-center gap-1 py-1 text-sm text-ink/80">
            <Check aria-hidden="true" size={14} />
            My default
          </span>
        ) : (
          <button type="button" className={actionClass} disabled={save.isPending} onClick={saveDefault}>
            Set as my default
          </button>
        ))}

      {savedDefault && !isDefault && (
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            focusIndicator.current = true
            setScope(savedDefault)
          }}
        >
          Reset to my default
        </button>
      )}

      <p role="status" aria-live="polite" className="py-1 text-sm text-ink/80">
        {message}
      </p>
    </div>
  )
}
