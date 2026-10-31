import { ApiError } from '../../api/errors'
import type { OrgTreeNode } from '../../api/queries'
import { formatPeriod, monthLabel, parsePeriod } from '../../lib/period'

// ---- Identifiers and source keys --------------------------------------------

/** An ID suggestion for a name: lowercase letters and digits joined by '-', at most 64 characters. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/** The ID pattern the API enforces. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Parses a comma-separated input into trimmed source keys, dropping empty entries. */
export function parseSourceKeys(input: string): string[] {
  return input
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
}

export function formatSourceKeys(keys: readonly string[]): string {
  return keys.join(', ')
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// ---- Months -----------------------------------------------------------------

/** The fiscal month `n` months after (or before, when negative) a month string. */
export function addMonths(month: string, n: number): string {
  const p = parsePeriod(month)
  if (!p || p.grain !== 'month') return month
  const total = p.fy * 12 + (p.index - 1) + n
  return formatPeriod({ grain: 'month', fy: Math.floor(total / 12), index: (total % 12) + 1 })
}

export interface MonthOption {
  value: string
  label: string
}

/** Months from a year before `center` to two years after it, plus `include` when outside that range. */
export function monthOptions(center: string, fiscalYearStartMonth: number, include?: string): MonthOption[] {
  const values: string[] = []
  for (let i = -12; i <= 24; i++) values.push(addMonths(center, i))
  if (include && !values.includes(include) && parsePeriod(include)?.grain === 'month') {
    values.push(include)
    values.sort()
  }
  return values.map((value) => ({ value, label: labelOfMonth(value, fiscalYearStartMonth) }))
}

export function labelOfMonth(month: string, fiscalYearStartMonth: number): string {
  const p = parsePeriod(month)
  return p && p.grain === 'month' ? monthLabel(p, fiscalYearStartMonth) : month
}

// ---- Org trees --------------------------------------------------------------

export interface FlatNode {
  id: string
  name: string
  levelId: string
  depth: number
}

/** The tree as a depth-first list. */
export function flattenTree(roots: readonly OrgTreeNode[], depth = 0): FlatNode[] {
  return roots.flatMap((n) => [
    { id: n.id, name: n.name, levelId: n.levelId, depth },
    ...flattenTree(n.children, depth + 1),
  ])
}

/** The ids of a node and everything below it. */
export function subtreeIds(roots: readonly OrgTreeNode[], id: string): Set<string> {
  const out = new Set<string>()
  const collect = (n: OrgTreeNode) => {
    out.add(n.id)
    n.children.forEach(collect)
  }
  const find = (nodes: readonly OrgTreeNode[]): OrgTreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n
      const hit = find(n.children)
      if (hit) return hit
    }
    return undefined
  }
  const node = find(roots)
  if (node) collect(node)
  return out
}

export type MovePreview =
  | { ok: true; roots: OrgTreeNode[] }
  | { ok: false; reason: string }

/**
 * The tree that results from moving a unit (with everything below it) under a
 * new parent, computed from a tree as of the effective month. It does not
 * mutate its input. The server stays the authority on whether the move is
 * allowed; this only shows what it would look like.
 */
export function previewMove(
  roots: readonly OrgTreeNode[],
  unitId: string,
  newParentId: string,
): MovePreview {
  const below = subtreeIds(roots, unitId)
  if (below.size === 0) return { ok: false, reason: 'The unit is not in the structure in that month.' }
  if (below.has(newParentId)) {
    return { ok: false, reason: 'A unit cannot be moved under itself or one of its own units.' }
  }
  let moved: OrgTreeNode | undefined
  const without = (nodes: readonly OrgTreeNode[]): OrgTreeNode[] =>
    nodes
      .filter((n) => {
        if (n.id === unitId) {
          moved = n
          return false
        }
        return true
      })
      .map((n) => ({ ...n, children: without(n.children) }))
  const rest = without(roots)
  if (!moved) return { ok: false, reason: 'The unit is not in the structure in that month.' }
  const movedNode = moved
  let attached = false
  const attach = (nodes: OrgTreeNode[]): OrgTreeNode[] =>
    nodes.map((n) => {
      if (n.id === newParentId) {
        attached = true
        return { ...n, children: [...n.children, movedNode] }
      }
      return { ...n, children: attach(n.children) }
    })
  const next = attach(rest)
  if (!attached) return { ok: false, reason: 'The new parent is not in the structure in that month.' }
  return { ok: true, roots: next }
}

// ---- Scope ------------------------------------------------------------------

export interface Named {
  id: string
  name: string
}

/** "All org units · All metrics", or counts with the names that are known. */
export function scopeSummary(
  scope: { orgUnitIds: readonly string[]; metricKeys: readonly string[] },
  unitNames: ReadonlyMap<string, string>,
  metricNames: ReadonlyMap<string, string>,
): string {
  const part = (
    ids: readonly string[],
    names: ReadonlyMap<string, string>,
    one: string,
    many: string,
    all: string,
  ) =>
    ids.length === 0
      ? all
      : `${ids.length} ${ids.length === 1 ? one : many}: ${ids.map((i) => names.get(i) ?? i).join(', ')}`
  return [
    part(scope.orgUnitIds, unitNames, 'org unit', 'org units', 'All org units'),
    part(scope.metricKeys, metricNames, 'metric', 'metrics', 'All metrics'),
  ].join(' · ')
}

/** Pending invitations have a `pending:` user ID until the person signs in. */
export function isPending(userId: string): boolean {
  return userId.startsWith('pending:')
}

// ---- Form errors ------------------------------------------------------------

/** Validation messages from an API failure, by field path, plus those with no field. */
export interface FormErrors {
  fields: Record<string, string[]>
  general: string[]
}

export const NO_ERRORS: FormErrors = { fields: {}, general: [] }

export function hasErrors(e: FormErrors): boolean {
  return e.general.length > 0 || Object.keys(e.fields).length > 0
}

/** Turns a failed request into messages. Details with a path become field messages. */
export function errorsFrom(error: unknown): FormErrors {
  if (error instanceof ApiError) {
    const out: FormErrors = { fields: {}, general: [] }
    for (const d of error.details) {
      if (d.path) (out.fields[d.path] ??= []).push(d.message)
      else out.general.push(d.message)
    }
    if (error.details.length === 0) out.general.push(error.message)
    return out
  }
  return { fields: {}, general: [error instanceof Error ? error.message : 'Something went wrong.'] }
}

/** A client-side validation message for one field. */
export function fieldError(path: string, message: string): FormErrors {
  return { fields: { [path]: [message] }, general: [] }
}

function baseOf(path: string): string {
  return path.replace(/\[\d+\]$/, '')
}

/**
 * Messages for a field: its exact path, or an indexed child such as
 * `sourceKeys[1]` for `sourceKeys`.
 */
export function forField(e: FormErrors, path: string): string[] {
  return Object.entries(e.fields)
    .filter(([p]) => p === path || baseOf(p) === path)
    .flatMap(([, msgs]) => msgs)
}

/**
 * Everything not shown at one of the named fields: general messages, and
 * field messages whose path no field claims (shown with the path).
 */
export function unclaimed(e: FormErrors, claimed: readonly string[]): string[] {
  const rest = Object.entries(e.fields)
    .filter(([p]) => !claimed.includes(p) && !claimed.includes(baseOf(p)))
    .flatMap(([p, msgs]) => msgs.map((m) => `${p}: ${m}`))
  return [...e.general, ...rest]
}
