import { describe, expect, it } from 'vitest'
import { countNoun, nounForms } from './nouns'

describe('nounForms', () => {
  it.each([
    ['Services', 'service', 'services'],
    ['Repositories', 'repository', 'repositories'],
    ['Repository', 'repository', 'repositories'],
    ['Boxes', 'box', 'boxes'],
    ['Class', 'class', 'classes'],
    ['Classes', 'class', 'classes'],
    ['Branches', 'branch', 'branches'],
    ['Databases', 'database', 'databases'],
    ['Segment', 'segment', 'segments'],
    ['Key', 'key', 'keys'],
    ['Product lines', 'product line', 'product lines'],
  ])('%s → %s / %s', (name, one, many) => {
    expect(nounForms(name, 'item')).toEqual({ one, many })
  })

  it('falls back when the name is unknown', () => {
    expect(nounForms(undefined, 'unit')).toEqual({ one: 'unit', many: 'units' })
    expect(nounForms('  ', 'item')).toEqual({ one: 'item', many: 'items' })
  })
})

describe('countNoun', () => {
  const services = { one: 'service', many: 'services' }
  it('uses the singular for one', () => {
    expect(countNoun(1, services)).toBe('1 service')
    expect(countNoun(3, services)).toBe('3 services')
    expect(countNoun(0, services)).toBe('0 services')
  })
})
