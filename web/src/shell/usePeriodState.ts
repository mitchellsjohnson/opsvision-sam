import { useCallback, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useFiscalYearStartMonth, useMe, useScorecards } from '../api/queries'
import { currentMonth, parsePeriod, type PeriodState } from '../lib/period'

/** Search params that make up the shared view state and survive navigation. */
export const VIEW_PARAMS = ['period', 'ytd', 'subject', 'scope', 'restate', 'structure'] as const

export interface PeriodPatch {
  period?: string
  ytd?: boolean
  subjects?: string[]
  scope?: string | null
  restate?: string | null
  structure?: 'as_of' | 'current' | null
}

export interface PeriodView extends PeriodState {
  scope: string
  restate: string
  structure: 'as_of' | 'current'
  /** The tenant's fiscal year start month; periods are fiscal. */
  fiscalYearStartMonth: number
  /**
   * False while the default period cannot be known yet because the tenant or
   * the scorecard list (which says where data starts) has not loaded. Wait
   * for it before querying data.
   */
  ready: boolean
}

export interface ScorecardMonths {
  id: string
  latestDataMonth: string | null
  latestPastDataMonth: string | null
}

/** The newest valid month period, or null. */
function newest(months: (string | null)[]): string | null {
  // Zero-padded month periods sort chronologically as strings.
  return months
    .filter((m): m is string => m !== null && parsePeriod(m)?.grain === 'month')
    .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null)
}

/**
 * The month a view opens on without `?period=`: the latest month with data,
 * skipping the fiscal month in progress unless no earlier month has data,
 * else the current fiscal month. Data is the named scorecard's, or, when the
 * page is not about one scorecard, the newest across all of them.
 */
export function defaultPeriod(
  cards: ScorecardMonths[] | undefined,
  scorecardId: string | null | undefined,
  fiscalYearStartMonth: number,
  now: Date = new Date(),
): string {
  const named = cards?.find((c) => c.id === scorecardId)
  const pool = named ? [named] : (cards ?? [])
  const current = currentMonth(fiscalYearStartMonth, now)
  const latest = newest(pool.map((c) => c.latestDataMonth))
  if (latest === null) return current
  if (latest < current) return latest
  return newest(pool.map((c) => c.latestPastDataMonth)) ?? latest
}

/**
 * The shell's period, YTD and subject selection. It lives in the URL
 * (`?period=2026-M10&ytd=1&subject=a&subject=b`; periods are fiscal) so views
 * are linkable. Without `?period=` it defaults to `defaultPeriod`.
 */
export function usePeriodState(): [PeriodView, (patch: PeriodPatch) => void] {
  const [params, setParams] = useSearchParams()
  const key = params.toString()
  const fiscalYearStartMonth = useFiscalYearStartMonth()
  const tenantPending = useMe().isPending
  const { sc } = useParams()
  const scorecards = useScorecards()
  const scorecardsPending = scorecards.isPending
  const cards = scorecards.data?.scorecards

  const state = useMemo<PeriodView>(() => {
    const p = new URLSearchParams(key)
    const raw = p.get('period')
    const valid = raw !== null && parsePeriod(raw) !== null
    return {
      period: valid ? raw : defaultPeriod(cards, sc ?? p.get('scorecard'), fiscalYearStartMonth),
      ytd: p.get('ytd') === '1',
      subjects: p.getAll('subject'),
      scope: p.get('scope') ?? '',
      restate: p.get('restate') ?? '',
      structure: p.get('structure') === 'current' ? 'current' : 'as_of',
      fiscalYearStartMonth,
      ready: valid || (!tenantPending && !scorecardsPending),
    }
  }, [key, fiscalYearStartMonth, tenantPending, scorecardsPending, cards, sc])

  const update = useCallback(
    (patch: PeriodPatch) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        if (patch.period !== undefined) next.set('period', patch.period)
        if (patch.ytd !== undefined) {
          if (patch.ytd) next.set('ytd', '1')
          else next.delete('ytd')
        }
        if (patch.subjects !== undefined) {
          next.delete('subject')
          for (const s of patch.subjects) next.append('subject', s)
        }
        if (patch.scope !== undefined) {
          if (patch.scope) next.set('scope', patch.scope)
          else next.delete('scope')
        }
        if (patch.restate !== undefined) {
          if (patch.restate) next.set('restate', patch.restate)
          else next.delete('restate')
        }
        if (patch.structure !== undefined) {
          if (patch.structure === 'current') next.set('structure', 'current')
          else next.delete('structure')
        }
        return next
      })
    },
    [setParams],
  )

  return [state, update]
}
