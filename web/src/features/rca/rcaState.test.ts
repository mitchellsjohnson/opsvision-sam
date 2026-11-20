import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { bestStatus, displayState } from './rcaState'

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

describe('displayState', () => {
  it('derives available for a best-status cell below its ideal, on single surfaces only', () => {
    expect(displayState(row(), cell(), scale, 'single')).toEqual({ state: 'available' })
    expect(displayState(row(), cell(), scale, 'dense')).toBeNull()
  })

  it('has nothing for a cell at its ideal', () => {
    expect(displayState(row(), cell({ value: 100, display: '100.00%' }), scale, 'single')).toBeNull()
  })

  it('uses the displayed value: 99.999 shows 100.00% and has no gap', () => {
    expect(displayState(row(), cell({ value: 99.999, display: '100.00%' }), scale, 'single')).toBeNull()
  })

  it('makes a cell not at its best and without Cell.rca (a roll-up) available', () => {
    expect(displayState(row(), cell({ value: 99.2, display: '99.20%', status: 'R' }), scale, 'single')).toEqual({
      state: 'available',
    })
  })

  it('treats Green as best on a custom scale with a level above it', () => {
    const custom: StatusLevel[] = [{ key: 'B', label: 'Blue', color: '#1D4ED8', rank: 0 }, ...scale]
    expect(displayState(row({ rcaIdeal: undefined }), cell(), custom, 'single')).toBeNull()
  })

  it('has nothing for YTD, not applicable, unrated or rule-less cells', () => {
    const r = row()
    expect(displayState(r, cell({ ytd: true, rca: { state: 'needed', canEdit: true } }), scale, 'single')).toBeNull()
    expect(displayState(r, cell({ status: '', naReason: 'Not tracked yet', value: null }), scale, 'single')).toBeNull()
    expect(displayState(r, cell({ status: '' }), scale, 'single')).toBeNull()
    expect(displayState(r, cell({ rule: undefined, status: 'R' }), scale, 'single')).toBeNull()
  })

  it('maps Cell.rca states, tags only for editors', () => {
    const r = row()
    expect(displayState(r, cell({ status: 'R', rca: { state: 'needed', canEdit: true } }), scale, 'dense')).toEqual({
      state: 'needed',
      canEdit: true,
    })
    expect(displayState(r, cell({ status: 'R', rca: { state: 'needed' } }), scale, 'dense')).toEqual({
      state: 'needed',
      canEdit: false,
    })
    expect(
      displayState(r, cell({ rca: { state: 'written', excerpt: 'Config deploy…', author: 'Avery Admin', canEdit: false } }), scale, 'dense'),
    ).toEqual({ state: 'written', excerpt: 'Config deploy…', author: 'Avery Admin', canEdit: false })
    expect(
      displayState(r, cell({ rca: { state: 'stale', excerpt: 'Index rebuild…', author: 'Casey', canEdit: true } }), scale, 'single'),
    ).toEqual({ state: 'stale', excerpt: 'Index rebuild…', author: 'Casey', canEdit: true })
  })

  it('shows roll-up counts to admins and contributors, and a plain Why? to viewers', () => {
    const c = cell({ subjectId: 'acme', value: null, display: '', status: '', rca: { neededBelow: 1, staleBelow: 1 } })
    expect(displayState(row(), c, scale, 'dense', 'contributor')).toEqual({
      state: 'rollup',
      neededBelow: 1,
      staleBelow: 1,
      showCounts: true,
    })
    expect(displayState(row(), c, scale, 'dense', 'viewer')).toEqual({
      state: 'rollup',
      neededBelow: 1,
      staleBelow: 1,
      showCounts: false,
    })
  })

  it('measures lower-is-better ideals from above', () => {
    const plan = row({ metricKey: 'spend', format: 'percent0', direction: 'lower_better', chartKind: 'money_plan', rcaIdeal: 100 })
    const rule: StatusRule = { type: 'bands', bands: [{ status: 'G', op: '<=', value: 105 }, { status: 'R', op: '>', value: 105 }] }
    expect(displayState(plan, cell({ value: 103, display: '103%', rule }), scale, 'single')).toEqual({ state: 'available' })
    expect(displayState(plan, cell({ value: 97, display: '97%', rule }), scale, 'single')).toBeNull()
  })
})
