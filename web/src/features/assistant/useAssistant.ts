import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import type { AssistantContext } from '../../api/queries'
import { usePeriodState } from '../../shell/usePeriodState'

export interface AskSam {
  /** Opens the drawer about what the user is looking at. */
  open: (context: AssistantContext) => void
  /** Whether the drawer is open. */
  isOpen: boolean
  /** True while the drawer sits beside the page (wide screens) rather than over it. */
  docked: boolean
}

export const AskSamContext = createContext<AskSam | null>(null)

const noop: AskSam = { open: () => {}, isOpen: false, docked: false }

/** Ask SAM, from the provider the app shell hosts. */
export function useAskSam(): AskSam {
  return useContext(AskSamContext) ?? noop
}

const SCORECARD_PAGE = /^\/scorecards\/([^/]+)(?:\/(overview|table|report))?/

/** The assistant context of the page in view: its scorecard, period, scope and page. */
export function usePageAssistantContext(): AssistantContext {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [view] = usePeriodState()
  const match = SCORECARD_PAGE.exec(pathname)
  const scorecardId = match?.[1]
  const segment = match?.[2] as 'overview' | 'table' | 'report' | undefined
  const focus = params.get('focus') ?? ''
  const withPeriod = scorecardId !== undefined || pathname === '/entry'
  return useMemo(() => {
    const ctx: AssistantContext = { page: segment ?? 'other' }
    if (scorecardId) ctx.scorecardId = scorecardId
    if (withPeriod && view.ready) ctx.period = view.period
    if (scorecardId && view.scope) ctx.scope = view.scope
    if (scorecardId && focus && focus !== 'table') {
      ctx.page = 'focus'
      ctx.metricKey = focus
    }
    return ctx
  }, [segment, scorecardId, withPeriod, view.ready, view.period, view.scope, focus])
}

const WIDE = '(min-width: 1024px)'

function subscribeWide(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(WIDE)
  query.addEventListener?.('change', onChange)
  return () => query.removeEventListener?.('change', onChange)
}

/** Wide screens (≥ 1024 px) have room for the drawer beside the page; without matchMedia, assume they do. */
export function useWideScreen(): boolean {
  return useSyncExternalStore(subscribeWide, () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true,
  )
}
