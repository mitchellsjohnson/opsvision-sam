import { formatPeriod, monthsOf, parsePeriod } from '../../lib/period'

interface FilterLevel {
  id: string
  name: string
  depth: number
}

interface FilterUnit {
  id: string
  name: string
  levelId: string
  parentId: string
  retiredFrom?: string
}

/** The chosen unit ID per filter level ID; a level without a choice is absent. */
export type Chosen = Record<string, string>

/** The levels the filters choose at: every level below the shallowest (the company), shallowest first. */
export function filterLevels<L extends FilterLevel>(levels: L[]): L[] {
  return [...levels].sort((a, b) => a.depth - b.depth).slice(1)
}

function plural(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`
  return `${name}s`
}

/** The empty choice of a level's select, for example `All Segments`. */
export function allLabel(levelName: string): string {
  return `All ${plural(levelName)}`
}

/** The unit and its ancestors, nearest first; stops at an unknown parent or a cycle. */
function lineage<U extends FilterUnit>(id: string, byId: Map<string, U>): U[] {
  const out: U[] = []
  const seen = new Set<string>()
  for (let u = byId.get(id); u && !seen.has(u.id); u = byId.get(u.parentId)) {
    seen.add(u.id)
    out.push(u)
  }
  return out
}

/** What each select shows for a scope: the scope and its ancestors at the filter levels. */
export function chosenUnits(scope: string, levels: FilterLevel[], units: FilterUnit[]): Chosen {
  if (!scope) return {}
  const byId = new Map(units.map((u) => [u.id, u]))
  const filterIds = new Set(levels.map((l) => l.id))
  const chosen: Chosen = {}
  for (const u of lineage(scope, byId)) {
    if (filterIds.has(u.levelId) && chosen[u.levelId] === undefined) chosen[u.levelId] = u.id
  }
  return chosen
}

/** The deepest choice at a level shallower than `index`, or '' (the company). */
function deepestChoiceAbove(index: number, levels: FilterLevel[], chosen: Chosen): string {
  for (let i = index - 1; i >= 0; i--) {
    const id = chosen[levels[i]!.id]
    if (id) return id
  }
  return ''
}

/** The first month of a period, as a month period string; null when the period is invalid. */
function firstMonth(period: string): string | null {
  const p = parsePeriod(period)
  return p ? formatPeriod(monthsOf(p)[0]!) : null
}

/**
 * The options of the select at `index`: units at its level below the deepest
 * shallower choice (any depth below it), sorted by name. Units retired at or
 * before the start of the period are left out, except the one already chosen.
 */
export function levelOptions<U extends FilterUnit>(
  index: number,
  levels: FilterLevel[],
  chosen: Chosen,
  units: U[],
  period: string,
): U[] {
  const level = levels[index]
  if (!level) return []
  const byId = new Map(units.map((u) => [u.id, u]))
  const ancestor = deepestChoiceAbove(index, levels, chosen)
  // Zero-padded month periods compare chronologically as strings.
  const start = firstMonth(period)
  return units
    .filter((u) => u.levelId === level.id)
    .filter((u) => !ancestor || lineage(u.id, byId).some((a) => a.id === ancestor))
    .filter((u) => u.id === chosen[level.id] || !u.retiredFrom || start === null || u.retiredFrom > start)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * The saved default scope as it applies in a period: '' (the company) when
 * its unit no longer exists or is retired at or before the period's start.
 */
export function effectiveDefaultScope(saved: string, units: FilterUnit[], period: string): string {
  if (!saved) return ''
  const u = units.find((x) => x.id === saved)
  if (!u) return ''
  const start = firstMonth(period)
  return u.retiredFrom && start !== null && u.retiredFrom <= start ? '' : saved
}

/** The scope after the select at `index` changes to `value` ('' is its All choice). */
export function scopeAfterChange(index: number, value: string, levels: FilterLevel[], chosen: Chosen): string {
  return value || deepestChoiceAbove(index, levels, chosen)
}
