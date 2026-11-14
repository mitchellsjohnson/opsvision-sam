import { useItems, useOrgUnits } from '../../api/queries'
import { formatPeriod, lastMonth, parsePeriod, type ViewRequest } from '../../lib/period'
import { usePeriodState, type PeriodView } from '../../shell/usePeriodState'
import { buildMonthTrendColumns, buildTrendColumns, columnRequest } from './columns'

/** The API's cap on `subjects`. */
export const MAX_VIEW_SUBJECTS = 200

interface Unit {
  id: string
  parentId: string
}

interface Item {
  id: string
  /** '' when the item is not attached to a unit. */
  orgUnitId: string
}

/** The org units and tracked items a scope expands over; either may still be loading. */
export interface SubjectTree {
  units?: Unit[]
  items?: Item[]
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

/**
 * The subjects the URL picks, else its scope, with every unit below them and
 * the tracked items attached to any of those units (the API keeps only the
 * rows of listed subjects, so item-only metrics need their items named); []
 * for all. Units come first when the list is cut to the API's cap.
 */
export function viewSubjects(state: Pick<ViewState, 'subjects' | 'scope'>, tree: SubjectTree): string[] {
  const picked = state.subjects.length > 0 ? state.subjects : state.scope ? [state.scope] : []
  if (picked.length === 0) return []
  const units = withDescendants(picked, tree.units ?? [])
  const inTree = new Set(units)
  const items = (tree.items ?? []).filter((i) => i.orgUnitId !== '' && inTree.has(i.orgUnitId)).map((i) => i.id)
  return [...units, ...items.filter((id) => !inTree.has(id))].slice(0, MAX_VIEW_SUBJECTS)
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
  tree: SubjectTree,
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
  const subjects = viewSubjects(state, tree)
  if (subjects.length > 0) req.subjects = subjects
  if (state.restate !== '') req.restate = state.restate
  if (state.structure === 'current') req.structure = 'current'
  if (options.metrics && options.metrics.length > 0) req.metrics = options.metrics
  return req
}

/**
 * The view request for the current URL. `ready` is false until the period
 * default is known and, when a scope or subjects need their descendants, the
 * org units and tracked items have loaded (or failed: the request then goes
 * without them).
 */
export function useScorecardViewRequest(options: ViewRequestOptions = {}): {
  request: ViewRequest
  ready: boolean
  period: PeriodView
} {
  const [period] = usePeriodState()
  const orgUnits = useOrgUnits()
  const needsTree = period.subjects.length > 0 || period.scope !== ''
  const items = useItems({ enabled: needsTree })
  return {
    request: scorecardViewRequest(period, { units: orgUnits.data?.units, items: items.data }, options),
    ready: period.ready && (!needsTree || (!orgUnits.isPending && !items.isPending)),
    period,
  }
}
