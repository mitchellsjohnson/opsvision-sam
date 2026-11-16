import { useParams } from 'react-router'
import { useItems, useOrgUnits, useVersions } from '../../api/queries'
import type { components } from '../../api/schema'
import { formatPeriod, lastMonth, monthsOf, parsePeriod, type Grain, type ViewRequest } from '../../lib/period'
import { usePeriodState, type PeriodView } from '../../shell/usePeriodState'
import {
  buildMonthTrendColumns,
  buildTrendColumns,
  COARSE_SPAN,
  coarseColumns,
  coarserGrain,
  columnRequest,
  endOrdinal,
  windowColumns,
  type CoarseGrain,
} from './columns'
import { coarseGrains } from './logic/coarse'

type MethodologyVersion = components['schemas']['MethodologyVersion']

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
  /** Coarse grains to add after the trend (§5.2): 4 quarters, 2 halves, 3 years, each closed by the period. */
  coarse?: CoarseGrain[]
  /** One grain only, `count` periods closed by the period, instead of the trend; never mixed with `coarse`. */
  window?: { grain: Grain; count: number }
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

/** The picked units, every unit below them, then the tracked items attached to any of those units. */
export function subtreeSubjects(picked: string[], tree: SubjectTree): string[] {
  const units = withDescendants(picked, tree.units ?? [])
  const inTree = new Set(units)
  const items = (tree.items ?? []).filter((i) => i.orgUnitId !== '' && inTree.has(i.orgUnitId)).map((i) => i.id)
  return [...units, ...items.filter((id) => !inTree.has(id))]
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
  return subtreeSubjects(picked, tree).slice(0, MAX_VIEW_SUBJECTS)
}

/**
 * The scorecard view request for a URL: the trend window ending at the
 * period (12 months, 8 quarters, 4 halves or 3 years), then any coarse
 * periods, its YTD column when year to date is on, the scope or subjects,
 * `restate` and `structure`. The Overview, the Table and the full-screen
 * views all use it, so the same URL makes one request and shares one cache
 * entry.
 */
export function scorecardViewRequest(
  state: ViewState,
  tree: SubjectTree,
  options: ViewRequestOptions = {},
): ViewRequest {
  const fy = state.fiscalYearStartMonth
  const selected = parsePeriod(state.period)
  let columns
  if (options.window) {
    columns = windowColumns(state.period, options.window.grain, options.window.count, fy)
  } else {
    columns =
      options.months !== undefined
        ? buildMonthTrendColumns(state.period, options.months, fy)
        : buildTrendColumns(state.period, fy)
    for (const grain of options.coarse ?? []) {
      if (selected && coarserGrain(grain, selected.grain)) {
        columns = [...columns, ...coarseColumns(state.period, grain, COARSE_SPAN[grain], fy)]
      }
    }
  }
  const req: ViewRequest = { ...columnRequest(columns) }
  if (state.ytd && selected && selected.grain !== 'year') req.ytd = [formatPeriod(lastMonth(selected))]
  const subjects = viewSubjects(state, tree)
  if (subjects.length > 0) req.subjects = subjects
  if (state.restate !== '') req.restate = state.restate
  if (state.structure === 'current') req.structure = 'current'
  if (options.metrics && options.metrics.length > 0) req.metrics = options.metrics
  return req
}

/** The first month a version is effective from, as a month count; null when it has no valid start. */
function startOrdinal(v: Pick<MethodologyVersion, 'effectiveFrom'>): number | null {
  const p = parsePeriod(v.effectiveFrom)
  const first = p ? monthsOf(p)[0] : undefined
  return first ? first.fy * 12 + first.index : null
}

function newerVersion(a: MethodologyVersion, b: MethodologyVersion): boolean {
  const ao = startOrdinal(a) ?? 0
  const bo = startOrdinal(b) ?? 0
  if (ao !== bo) return ao > bo
  if ((a.publishedAt ?? '') !== (b.publishedAt ?? '')) return (a.publishedAt ?? '') > (b.publishedAt ?? '')
  return a.id > b.id
}

/**
 * The methodology version the API computes a period under: the restating
 * version when restated; else, among published and superseded versions, the
 * one that started latest on or before the period's last month.
 */
export function versionInForce(
  versions: Pick<MethodologyVersion, 'id' | 'status' | 'effectiveFrom' | 'publishedAt'>[],
  period: string,
  restate: string,
): MethodologyVersion | undefined {
  const all = versions as MethodologyVersion[]
  if (restate !== '') return all.find((v) => v.id === restate)
  const p = parsePeriod(period)
  if (!p) return undefined
  const end = endOrdinal(p)
  let best: MethodologyVersion | undefined
  for (const v of all) {
    if (v.status !== 'published' && v.status !== 'superseded') continue
    const from = startOrdinal(v)
    if (from === null || from > end) continue
    if (!best || newerVersion(v, best)) best = v
  }
  return best
}

/**
 * The view request for the current URL. `ready` is false until the period
 * default is known; when a scope or subjects need their descendants, until
 * the org units and tracked items have loaded; and for the shared request
 * (no `months`, `window` or `coarse`), until the versions have loaded, so
 * the coarse grains of the version in force go in the first request. A
 * failed load sends the request without what it would have added.
 */
export function useScorecardViewRequest(options: ViewRequestOptions = {}): {
  request: ViewRequest
  ready: boolean
  period: PeriodView
} {
  const [period] = usePeriodState()
  const { sc } = useParams()
  const orgUnits = useOrgUnits()
  const needsTree = period.subjects.length > 0 || period.scope !== ''
  const items = useItems({ enabled: needsTree })
  const shared = options.months === undefined && options.window === undefined && options.coarse === undefined
  const needsVersions = shared && sc !== undefined
  const versions = useVersions(needsVersions ? sc : undefined)
  const selectedGrain = parsePeriod(period.period)?.grain ?? 'month'
  const version = needsVersions ? versionInForce(versions.data?.versions ?? [], period.period, period.restate) : undefined
  const coarse = shared && version ? coarseGrains(version.content.metrics.map((m) => m.frequency), selectedGrain) : options.coarse
  return {
    request: scorecardViewRequest(period, { units: orgUnits.data?.units, items: items.data }, { ...options, coarse }),
    ready:
      period.ready &&
      (!needsTree || (!orgUnits.isPending && !items.isPending)) &&
      (!needsVersions || !versions.isPending),
    period,
  }
}
