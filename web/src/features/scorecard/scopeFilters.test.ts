import { describe, expect, it } from 'vitest'
import {
  allLabel,
  chosenUnits,
  effectiveDefaultScope,
  filterLevels,
  levelOptions,
  scopeAfterChange,
} from './scopeFilters'

const levels = [
  { id: 'product', name: 'Product', depth: 2 },
  { id: 'company', name: 'Company', depth: 0 },
  { id: 'segment', name: 'Segment', depth: 1 },
]

const unit = (id: string, levelId: string, parentId: string, retiredFrom?: string) => ({
  id,
  name: `Unit ${id.toUpperCase()}`,
  levelId,
  parentId,
  ...(retiredFrom ? { retiredFrom } : {}),
})

const units = [
  unit('co', 'company', ''),
  unit('b', 'segment', 'co'),
  unit('a', 'segment', 'co'),
  unit('a2', 'product', 'a'),
  unit('a1', 'product', 'a'),
  unit('b1', 'product', 'b'),
  unit('b9', 'product', 'b', '2026-M08'),
  unit('old', 'segment', 'co', '2026-M03'),
]

const ids = (us: { id: string }[]) => us.map((u) => u.id)

describe('scope filters', () => {
  it('filters on every level below the root, shallowest first', () => {
    expect(ids(filterLevels(levels))).toEqual(['segment', 'product'])
    expect(filterLevels([])).toEqual([])
    expect(filterLevels([{ id: 'company', name: 'Company', depth: 0 }])).toEqual([])
  })

  it('labels the empty choice with All and the plural level name', () => {
    expect(allLabel('Segment')).toBe('All Segments')
    expect(allLabel('Product')).toBe('All Products')
    expect(allLabel('Business')).toBe('All Businesses')
    expect(allLabel('Family')).toBe('All Families')
    expect(allLabel('Day')).toBe('All Days')
  })

  it('reads the scope and its ancestors as the choice at each level', () => {
    const fl = filterLevels(levels)
    expect(chosenUnits('', fl, units)).toEqual({})
    expect(chosenUnits('a', fl, units)).toEqual({ segment: 'a' })
    expect(chosenUnits('b1', fl, units)).toEqual({ segment: 'b', product: 'b1' })
    expect(chosenUnits('co', fl, units)).toEqual({})
    expect(chosenUnits('missing', fl, units)).toEqual({})
  })

  it('lists units at each level under the deepest chosen ancestor, by name', () => {
    const fl = filterLevels(levels)
    expect(ids(levelOptions(0, fl, {}, units, '2026-M10'))).toEqual(['a', 'b'])
    expect(ids(levelOptions(1, fl, {}, units, '2026-M10'))).toEqual(['a1', 'a2', 'b1'])
    expect(ids(levelOptions(1, fl, { segment: 'a' }, units, '2026-M10'))).toEqual(['a1', 'a2'])
    expect(ids(levelOptions(1, fl, { segment: 'b' }, units, '2026-M10'))).toEqual(['b1'])
  })

  it('hides units retired at or before the start of the selected period, unless chosen', () => {
    const fl = filterLevels(levels)
    expect(ids(levelOptions(1, fl, { segment: 'b' }, units, '2026-M07'))).toEqual(['b1', 'b9'])
    expect(ids(levelOptions(1, fl, { segment: 'b' }, units, '2026-M08'))).toEqual(['b1'])
    expect(ids(levelOptions(1, fl, { segment: 'b' }, units, '2026-Q3'))).toEqual(['b1', 'b9'])
    expect(ids(levelOptions(1, fl, { segment: 'b' }, units, '2026-Q4'))).toEqual(['b1'])
    expect(ids(levelOptions(0, fl, {}, units, '2026-M02'))).toEqual(['a', 'b', 'old'])
    expect(ids(levelOptions(1, fl, { segment: 'b', product: 'b9' }, units, '2026-M10'))).toEqual(['b1', 'b9'])
  })

  it('uses a saved default only while its unit exists and is not retired for the period', () => {
    expect(effectiveDefaultScope('', units, '2026-M10')).toBe('')
    expect(effectiveDefaultScope('a1', units, '2026-M10')).toBe('a1')
    expect(effectiveDefaultScope('gone', units, '2026-M10')).toBe('')
    expect(effectiveDefaultScope('b9', units, '2026-M07')).toBe('b9')
    expect(effectiveDefaultScope('b9', units, '2026-M08')).toBe('')
    expect(effectiveDefaultScope('b9', units, '2026-Q4')).toBe('')
  })

  it('scopes to the chosen unit, or to the deepest shallower choice when cleared', () => {
    const fl = filterLevels(levels)
    expect(scopeAfterChange(0, 'a', fl, { segment: 'b', product: 'b1' })).toBe('a')
    expect(scopeAfterChange(1, 'a1', fl, {})).toBe('a1')
    expect(scopeAfterChange(1, '', fl, { segment: 'a', product: 'a1' })).toBe('a')
    expect(scopeAfterChange(0, '', fl, { segment: 'a', product: 'a1' })).toBe('')
  })
})
