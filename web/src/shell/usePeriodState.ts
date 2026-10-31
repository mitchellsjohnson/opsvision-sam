import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { currentMonth, parsePeriod, type PeriodState } from '../lib/period'

/** Search params that make up the shared view state and survive navigation. */
export const VIEW_PARAMS = ['period', 'ytd', 'subject'] as const

export interface PeriodPatch {
  period?: string
  ytd?: boolean
  subjects?: string[]
}

/**
 * The shell's period, YTD and subject selection. It lives in the URL
 * (`?period=2026-M10&ytd=1&subject=a&subject=b`) so views are linkable.
 */
export function usePeriodState(): [PeriodState, (patch: PeriodPatch) => void] {
  const [params, setParams] = useSearchParams()
  const key = params.toString()

  const state = useMemo<PeriodState>(() => {
    const p = new URLSearchParams(key)
    const raw = p.get('period')
    return {
      period: raw && parsePeriod(raw) ? raw : currentMonth(),
      ytd: p.get('ytd') === '1',
      subjects: p.getAll('subject'),
    }
  }, [key])

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
        return next
      })
    },
    [setParams],
  )

  return [state, update]
}
