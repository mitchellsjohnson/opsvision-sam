import { useOrgUnits } from '../../api/queries'
import { formatPeriod, lastMonth, parsePeriod, type ViewRequest } from '../../lib/period'
import { usePeriodState, type PeriodView } from '../../shell/usePeriodState'
import { buildMonthTrendColumns, buildTrendColumns, columnRequest } from './columns'

/** The API's cap on `subjects`. */
export const MAX_VIEW_SUBJECTS = 200

interface Unit {
  id: string
  parentId: string
}

type ViewState = Pick<
  PeriodView,
  'period' | 'ytd' | 'subjects' | 'scope' | 'restate' | 'structure' | 'fiscalYearStartMonth'
>

export interface ViewRequestOptions {
  /** Month grain only: a trend window of this many months instead of 12. */
  months?: number
  /** Only these metrics' rows. */
  metrics?: string[]
}

function withDescendants(selected: string[], units: Unit[]): string[] {
  const children = new Map<string, string[]>()
  for (const u of units) {
    const list = children.get(u.parentId) ?? []
    list.push(u.id)
    children.set(u.parentId, list)
  }
  const out = new Set<string>()
  const queue = [...selected]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (out.has(id)) continue
    out.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  return [...out]
}

/** The subjects the URL picks, else its scope, with every unit below them; [] for all. */
export function viewSubjects(state: Pick<ViewState, 'subjects' | 'scope'>, units: Unit[] | undefined): string[] {
  const picked = state.subjects.length > 0 ? state.subjects : state.scope ? [state.scope] : []
  if (picked.length === 0) return []
  return withDescendants(picked, units ?? []).slice(0, MAX_VIEW_SUBJECTS)
}

/**
 * The scorecard view request for a URL: the trend window ending at the
 * period (12 months, 8 quarters, 4 halves or 3 years), its YTD column when
 * year to date is on, the scope or subjects, `restate` and `structure`. The
 * Overview, the Table and the full-screen views all use it, so the same URL
 * makes one request and shares one cache entry.
 */
export function scorecardViewRequest(
  state: ViewState,
  units: Unit[] | undefined,
  options: ViewRequestOptions = {},
): ViewRequest {
  const fy = state.fiscalYearStartMonth
  const columns =
    options.months !== undefined
      ? buildMonthTrendColumns(state.period, options.months, fy)
      : buildTrendColumns(state.period, fy)
  const req: ViewRequest = { ...columnRequest(columns) }
  const selected = parsePeriod(state.period)
  if (state.ytd && selected && selected.grain !== 'year') req.ytd = [formatPeriod(lastMonth(selected))]
  const subjects = viewSubjects(state, units)
  if (subjects.length > 0) req.subjects = subjects
  if (state.restate !== '') req.restate = state.restate
  if (state.structure === 'current') req.structure = 'current'
  if (options.metrics && options.metrics.length > 0) req.metrics = options.metrics
  return req
}

/**
 * The view request for the current URL. `ready` is false until the period
 * default is known and, when a scope or subjects need their descendants, the
 * org units have loaded.
 */
export function useScorecardViewRequest(options: ViewRequestOptions = {}): {
  request: ViewRequest
  ready: boolean
  period: PeriodView
} {
  const [period] = usePeriodState()
  const orgUnits = useOrgUnits()
  const needsUnits = period.subjects.length > 0 || period.scope !== ''
  return {
    request: scorecardViewRequest(period, orgUnits.data?.units, options),
    ready: period.ready && (!needsUnits || !orgUnits.isPending),
    period,
  }
}
