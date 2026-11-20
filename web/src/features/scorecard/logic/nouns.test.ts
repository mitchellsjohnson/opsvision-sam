import { describe, expect, it } from 'vitest'
import { countNoun, nounForms, nounFromId, valueHeader } from './nouns'

describe('nounFromId', () => {
  it.each([
    ['deployments', 'deployment', 'deployments'],
    ['edge_nodes', 'edge node', 'edge nodes'],
    ['build-agents', 'build agent', 'build agents'],
    ['service', 'service', 'services'],
  ])('%s → %s / %s', (id, one, many) => {
    expect(nounFromId(id)).toEqual({ one, many })
  })

  it('falls back to item for an empty id', () => {
    expect(nounFromId('')).toEqual({ one: 'item', many: 'items' })
  })
})

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

describe('valueHeader', () => {
  it('the metric name’s last word when it names the value', () => {
    expect(valueHeader('Deployment uptime')).toBe('Uptime')
    expect(valueHeader('Weighted defect score')).toBe('Score')
  })

  it('Value when the last word follows a joining word, so it does not name the value', () => {
    expect(valueHeader('Incidents per service')).toBe('Value')
    expect(valueHeader('Spend vs plan')).toBe('Value')
    expect(valueHeader('Incident postmortems on time')).toBe('Value')
    expect(valueHeader('')).toBe('Value')
  })
})
