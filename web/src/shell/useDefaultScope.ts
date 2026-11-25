import { useFiscalYearStartMonth, useMyPreferences, useOrgUnits, useScorecards } from '../api/queries'
import { effectiveDefaultScope } from '../features/scorecard/scopeFilters'
import { parsePeriod } from '../lib/period'
import { defaultPeriod } from './usePeriodState'

/**
 * The person's default scope for a period (the default period of
 * `scorecardId`, or of all scorecards, when `period` is missing or invalid):
 * '' for the company, including when the saved unit no longer exists, is
 * retired, or the org units cannot load. `ready` is false while the
 * preferences, or what is needed to check a saved unit, are loading; `ready`
 * with no preferences means they failed.
 */
export function useDefaultScope(
  period?: string | null,
  scorecardId?: string,
): { scope: string; ready: boolean; loaded: boolean } {
  const prefs = useMyPreferences()
  const orgUnits = useOrgUnits()
  const scorecards = useScorecards()
  const fiscalYearStartMonth = useFiscalYearStartMonth()
  const saved = prefs.data?.defaultScope ?? ''
  const explicit = !!period && parsePeriod(period) !== null
  const at = explicit ? period : defaultPeriod(scorecards.data?.scorecards, scorecardId, fiscalYearStartMonth)
  const ready = !prefs.isPending && (saved === '' || (!orgUnits.isPending && (explicit || !scorecards.isPending)))
  return {
    scope: ready ? effectiveDefaultScope(saved, orgUnits.data?.units ?? [], at) : '',
    ready,
    loaded: prefs.data !== undefined,
  }
}
