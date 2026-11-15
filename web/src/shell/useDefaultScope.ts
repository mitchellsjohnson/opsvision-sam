import { useFiscalYearStartMonth, useMyPreferences, useOrgUnits } from '../api/queries'
import { effectiveDefaultScope } from '../features/scorecard/scopeFilters'
import { currentMonth, parsePeriod } from '../lib/period'

/**
 * The person's default scope for a period (the current fiscal month when
 * `period` is missing or invalid): '' for the company, including when the
 * saved unit no longer exists, is retired, or the org units cannot load.
 * `ready` is false while the preferences, or the units needed to check a
 * saved unit, are loading; `ready` with no preferences means they failed.
 */
export function useDefaultScope(period?: string | null): { scope: string; ready: boolean; loaded: boolean } {
  const prefs = useMyPreferences()
  const orgUnits = useOrgUnits()
  const fiscalYearStartMonth = useFiscalYearStartMonth()
  const saved = prefs.data?.defaultScope ?? ''
  const at = period && parsePeriod(period) ? period : currentMonth(fiscalYearStartMonth)
  const ready = !prefs.isPending && (saved === '' || !orgUnits.isPending)
  return {
    scope: ready ? effectiveDefaultScope(saved, orgUnits.data?.units ?? [], at) : '',
    ready,
    loaded: prefs.data !== undefined,
  }
}
