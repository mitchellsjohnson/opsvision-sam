import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { attributionAvailable, bestStatus, neededFor, requiredFor, summaryDisplay } from './rcaState'

type Cell = components['schemas']['Cell']
type ViewRow = components['schemas']['ViewRow']
type StatusRule = components['schemas']['StatusRule']
type StatusLevel = components['schemas']['StatusLevel']

const scale: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]
const uptimeRule: StatusRule = {
  type: 'bands',
  bands: [
    { status: 'G', op: '>=', value: 99.9 },
    { status: 'Y', op: '>=', value: 99.5 },
    { status: 'R', op: '<', value: 99.5 },
  ],
}

function cell(over: Partial<Cell> = {}): Cell {
  return {
    metricKey: 'uptime',
    subjectId: 'search',
    period: '2026-M10',
    ytd: false,
    value: 99.97,
    display: '99.97%',
    status: 'G',
    naReason: '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'v1',
    rule: uptimeRule,
    ...over,
  }
}

function row(over: Partial<ViewRow> = {}): ViewRow {
  return {
    metricKey: 'uptime',
    metricName: 'Uptime',
    categoryId: 'reliability',
    subjectId: 'search',
    subjectName: 'Search',
    subjectKind: 'item',
    format: 'percent2',
    depth: 2,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'uptime',
    rcaIdeal: 100,
    cells: [],
    ...over,
  }
}

describe('bestStatus', () => {
  it('is the best-ranked status the rule can produce', () => {
    expect(bestStatus(uptimeRule, scale)).toBe('G')
  })

  it('ignores a scale level above Green that no rule uses', () => {
    const custom: StatusLevel[] = [{ key: 'B', label: 'Blue', color: '#1D4ED8', rank: 0 }, ...scale]
    expect(bestStatus(uptimeRule, custom)).toBe('G')
  })

  it('reads scale steps for scale rules', () => {
    expect(bestStatus({ type: 'scale', scale: [{ status: 'Y', min: 2 }, { status: 'R', min: 0 }] }, scale)).toBe('Y')
  })
})

describe('summaryDisplay', () => {
  const company = (summary: Cell['summary']) => cell({ subjectId: 'acme', summary })

  it('maps a written summary, with the call to act only for admins', () => {
    const c = company({ state: 'written', excerpt: 'Webhooks lost 7h…', author: 'Avery Admin' })
    expect(summaryDisplay(c, 'admin')).toEqual({ state: 'written', excerpt: 'Webhooks lost 7h…', author: 'Avery Admin', canEdit: true })
    expect(summaryDisplay(c, 'viewer')).toEqual({ state: 'written', excerpt: 'Webhooks lost 7h…', author: 'Avery Admin', canEdit: false })
  })

  it('maps a stale summary; contributors cannot edit', () => {
    const c = company({ state: 'stale', excerpt: 'Checkout pulled…', author: 'Avery Admin' })
    expect(summaryDisplay(c, 'contributor')).toEqual({ state: 'stale', excerpt: 'Checkout pulled…', author: 'Avery Admin', canEdit: false })
    expect(summaryDisplay(c, 'admin')?.canEdit).toBe(true)
  })

  it('shows a missing summary to everyone; admins can write it', () => {
    const c = company({ state: 'missing' })
    expect(summaryDisplay(c, 'admin')).toEqual({ state: 'missing', canEdit: true })
    expect(summaryDisplay(c, 'contributor')).toEqual({ state: 'missing', canEdit: false })
    expect(summaryDisplay(c, 'viewer')).toEqual({ state: 'missing', canEdit: false })
  })

  it('draws nothing for an optional slot, a cell without summary state, or YTD', () => {
    expect(summaryDisplay(company({ state: 'optional' }), 'admin')).toBeNull()
    expect(summaryDisplay(cell(), 'admin')).toBeNull()
    expect(summaryDisplay(cell({ ytd: true, summary: { state: 'missing' } }), 'admin')).toBeNull()
  })

  it('reads an absent author and excerpt as empty', () => {
    expect(summaryDisplay(company({ state: 'written' }), 'viewer')).toEqual({ state: 'written', excerpt: '', author: '', canEdit: false })
  })

  it('says which month a missing coarse summary is needed for, when that is not the month shown', () => {
    expect(summaryDisplay(company({ state: 'missing' }), 'admin', 'Jun 2026')).toEqual({ state: 'missing', canEdit: true, neededFor: 'Jun 2026' })
    expect(summaryDisplay(company({ state: 'written', author: 'A' }), 'admin', 'Jun 2026')).toEqual({
      state: 'written',
      excerpt: '',
      author: 'A',
      canEdit: true,
    })
  })
})

describe('neededFor', () => {
  it('is the closing month of a coarse period the shown month does not close', () => {
    expect(neededFor('2026-H1', '2026-M10', 1)).toBe('Jun 2026')
    expect(neededFor('2026-Q3', '2026-M10', 1)).toBe('Sep 2026')
  })

  it('is undefined for the month that closes it, a month slot, or a period that is not a month', () => {
    expect(neededFor('2026-Q3', '2026-M09', 1)).toBeUndefined()
    expect(neededFor('2026-M10', '2026-M10', 1)).toBeUndefined()
    expect(neededFor('2026-H1', '2026-Q3', 1)).toBeUndefined()
    expect(neededFor('', '2026-M10', 1)).toBeUndefined()
  })
})

describe('requiredFor', () => {
  const slot = { period: '2026-H1', requirement: 'optional' as const, standing: { display: '82%', status: 'Y', headline: '18 pts short of 100%' } }

  it('names the closing month of a counted coarse slot that was required there', () => {
    expect(requiredFor(slot, '2026-M10', 1)).toBe('Jun 2026')
  })

  it('is undefined when the slot is required now, or perfect', () => {
    expect(requiredFor({ ...slot, requirement: 'required' }, '2026-M10', 1)).toBeUndefined()
    expect(requiredFor({ ...slot, standing: { ...slot.standing, headline: '' } }, '2026-M10', 1)).toBeUndefined()
  })
})

describe('attributionAvailable', () => {
  it('is true for Green 99.97%: best status, below the ideal', () => {
    expect(attributionAvailable(row(), cell(), scale)).toBe(true)
  })

  it('is false at 100%, and when the display rounds to 100.00%', () => {
    expect(attributionAvailable(row(), cell({ value: 100, display: '100.00%' }), scale)).toBe(false)
    expect(attributionAvailable(row(), cell({ value: 99.999, display: '100.00%' }), scale)).toBe(false)
  })

  it('is true for a Red roll-up', () => {
    expect(attributionAvailable(row({ subjectId: 'acme', subjectKind: 'unit', depth: 0 }), cell({ subjectId: 'acme', value: 99.2, display: '99.20%', status: 'R' }), scale)).toBe(true)
  })

  it('treats Green as best on a custom scale with a level above it', () => {
    const custom: StatusLevel[] = [{ key: 'B', label: 'Blue', color: '#1D4ED8', rank: 0 }, ...scale]
    expect(attributionAvailable(row({ rcaIdeal: undefined }), cell(), custom)).toBe(false)
    expect(attributionAvailable(row({ rcaIdeal: undefined }), cell({ status: 'Y', value: 99.6, display: '99.60%' }), custom)).toBe(true)
  })

  it('is false for YTD, not applicable, unrated or rule-less cells', () => {
    const r = row()
    expect(attributionAvailable(r, cell({ ytd: true, status: 'R' }), scale)).toBe(false)
    expect(attributionAvailable(r, cell({ status: '', naReason: 'Not tracked yet', value: null }), scale)).toBe(false)
    expect(attributionAvailable(r, cell({ status: '' }), scale)).toBe(false)
    expect(attributionAvailable(r, cell({ rule: undefined, status: 'R' }), scale)).toBe(false)
  })

  it('measures lower-is-better ideals from above', () => {
    const plan = row({ metricKey: 'spend', format: 'percent0', direction: 'lower_better', chartKind: 'money_plan', rcaIdeal: 100 })
    const rule: StatusRule = { type: 'bands', bands: [{ status: 'G', op: '<=', value: 105 }, { status: 'R', op: '>', value: 105 }] }
    expect(attributionAvailable(plan, cell({ value: 103, display: '103%', rule }), scale)).toBe(true)
    expect(attributionAvailable(plan, cell({ value: 97, display: '97%', rule }), scale)).toBe(false)
  })
})
