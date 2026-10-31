import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import type { OrgTreeNode } from '../../api/queries'
import {
  addMonths,
  errorsFrom,
  flattenTree,
  forField,
  isPending,
  monthOptions,
  parseSourceKeys,
  previewMove,
  scopeSummary,
  slugify,
  subtreeIds,
  unclaimed,
} from './adminModel'

const node = (id: string, children: OrgTreeNode[] = []): OrgTreeNode => ({
  id,
  name: id.toUpperCase(),
  levelId: 'l',
  children,
})

describe('slugify', () => {
  it('lowercases, joins words with dashes and strips accents and punctuation', () => {
    expect(slugify('  Platform & Édge Team! ')).toBe('platform-edge-team')
    expect(slugify('!!!')).toBe('')
    expect(slugify('a'.repeat(80))).toHaveLength(64)
  })
})

describe('parseSourceKeys', () => {
  it('splits on commas, trims and drops empty entries', () => {
    expect(parseSourceKeys(' alpha , beta,, gamma ,')).toEqual(['alpha', 'beta', 'gamma'])
    expect(parseSourceKeys('')).toEqual([])
    expect(parseSourceKeys('Two Words, x')).toEqual(['Two Words', 'x'])
  })
})

describe('addMonths', () => {
  it('moves across fiscal years in both directions', () => {
    expect(addMonths('2026-M10', 1)).toBe('2026-M11')
    expect(addMonths('2026-M12', 1)).toBe('2027-M01')
    expect(addMonths('2026-M01', -1)).toBe('2025-M12')
    expect(addMonths('2026-M05', 24)).toBe('2028-M05')
  })
  it('lists a range of months around a center, with a calendar label', () => {
    const opts = monthOptions('2026-M10', 1)
    expect(opts[0]?.value).toBe('2025-M10')
    expect(opts.find((o) => o.value === '2026-M10')?.label).toBe('Oct 2026')
    expect(monthOptions('2026-M10', 1, '2020-M03')[0]?.value).toBe('2020-M03')
  })
})

describe('tree helpers', () => {
  const roots = [node('co', [node('a', [node('a1')]), node('b')])]

  it('flattens depth first with depths', () => {
    expect(flattenTree(roots).map((n) => `${n.depth}:${n.id}`)).toEqual(['0:co', '1:a', '2:a1', '1:b'])
  })
  it('collects a subtree', () => {
    expect([...subtreeIds(roots, 'a')].sort()).toEqual(['a', 'a1'])
    expect(subtreeIds(roots, 'nope').size).toBe(0)
  })
  it('previews a move without changing the input', () => {
    const before = JSON.stringify(roots)
    const r = previewMove(roots, 'a', 'b')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const co = r.roots[0] as OrgTreeNode
      expect(co.children.map((c) => c.id)).toEqual(['b'])
      expect(co.children[0]?.children.map((c) => c.id)).toEqual(['a'])
      expect(co.children[0]?.children[0]?.children.map((c) => c.id)).toEqual(['a1'])
    }
    expect(JSON.stringify(roots)).toBe(before)
  })
  it('refuses a move under itself, under its own subtree, or to a parent not in the tree', () => {
    expect(previewMove(roots, 'a', 'a').ok).toBe(false)
    expect(previewMove(roots, 'a', 'a1').ok).toBe(false)
    expect(previewMove(roots, 'a', 'gone').ok).toBe(false)
    expect(previewMove(roots, 'gone', 'b').ok).toBe(false)
  })
})

describe('scopeSummary', () => {
  const units = new Map([['u1', 'Unit One']])
  const metrics = new Map([['m1', 'Metric One']])
  it('says everything for empty lists and names the rest', () => {
    expect(scopeSummary({ orgUnitIds: [], metricKeys: [] }, units, metrics)).toBe(
      'All org units · All metrics',
    )
    expect(scopeSummary({ orgUnitIds: ['u1', 'u9'], metricKeys: ['m1'] }, units, metrics)).toBe(
      '2 org units: Unit One, u9 · 1 metric: Metric One',
    )
  })
  it('recognizes pending users', () => {
    expect(isPending('pending:a@example.test')).toBe(true)
    expect(isPending('dev|admin')).toBe(false)
  })
})

describe('form errors', () => {
  const err = new ApiError({
    status: 400,
    code: 'invalid',
    message: 'request validation failed',
    details: [
      { path: 'sourceKeys[1]', message: 'key taken' },
      { path: 'levelId', message: 'too shallow' },
      { path: '', message: 'something general' },
    ],
  })
  it('maps details by path and matches indexed children by base path', () => {
    const e = errorsFrom(err)
    expect(forField(e, 'sourceKeys')).toEqual(['key taken'])
    expect(forField(e, 'levelId')).toEqual(['too shallow'])
    expect(forField(e, 'name')).toEqual([])
    expect(unclaimed(e, ['sourceKeys'])).toEqual(['something general', 'levelId: too shallow'])
  })
  it('uses the message when there are no details', () => {
    const e = errorsFrom(new ApiError({ status: 400, code: 'invalid', message: 'tenant must keep at least one admin' }))
    expect(e.general).toEqual(['tenant must keep at least one admin'])
    expect(errorsFrom(new Error('boom')).general).toEqual(['boom'])
  })
})
