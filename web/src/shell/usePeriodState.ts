import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { useFiscalYearStartMonth, useMe } from '../api/queries'
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
   * False while the default period (the current fiscal month) cannot be known
   * yet because the tenant has not loaded. Wait for it before querying data.
   */
  ready: boolean
}

/**
 * The shell's period, YTD and subject selection. It lives in the URL
 * (`?period=2026-M10&ytd=1&subject=a&subject=b`; periods are fiscal) so views
 * are linkable. Without `?period=` it defaults to the current fiscal month.
 */
export function usePeriodState(): [PeriodView, (patch: PeriodPatch) => void] {
  const [params, setParams] = useSearchParams()
  const key = params.toString()
  const fiscalYearStartMonth = useFiscalYearStartMonth()
  const tenantPending = useMe().isPending

  const state = useMemo<PeriodView>(() => {
    const p = new URLSearchParams(key)
    const raw = p.get('period')
    const valid = raw !== null && parsePeriod(raw) !== null
    return {
      period: valid ? raw : currentMonth(fiscalYearStartMonth),
      ytd: p.get('ytd') === '1',
      subjects: p.getAll('subject'),
      scope: p.get('scope') ?? '',
      restate: p.get('restate') ?? '',
      structure: p.get('structure') === 'current' ? 'current' : 'as_of',
      fiscalYearStartMonth,
      ready: valid || !tenantPending,
    }
  }, [key, fiscalYearStartMonth, tenantPending])

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
