import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { focusBodyKind } from './focusBody'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

function cell(subjectId: string, value: number | null): Cell {
  return {
    metricKey: 'm',
    subjectId,
    period: '2026-M10',
    ytd: false,
    value,
    display: value === null ? '' : `${value}%`,
    status: value === null ? '' : 'G',
    naReason: '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
  }
}

function row(subjectId: string, subjectKind: 'unit' | 'item', depth: number, value: number | null, chartKind = 'ratio'): ViewRow {
  return {
    metricKey: 'm',
    metricName: 'Metric',
    categoryId: 'c',
    subjectId,
    subjectName: subjectId,
    subjectKind,
    format: 'percent1',
    depth,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind,
    cells: [cell(subjectId, value)],
  }
}

describe('focusBodyKind', () => {
  it('uptime rows are items, even with a unit row', () => {
    expect(focusBodyKind([row('svc-a', 'item', 0, 99.9, 'uptime'), row('svc-b', 'item', 0, 99.2, 'uptime')])).toBe('items')
    expect(focusBodyKind([row('root', 'unit', 0, 99.9, 'uptime'), row('svc-a', 'item', 1, 99.9, 'uptime')])).toBe('items')
  })

  it('unit rows only are a chart', () => {
    expect(focusBodyKind([row('root', 'unit', 0, 84), row('unit-a', 'unit', 1, 70)])).toBe('chart')
  })

  it('item rows with no unit scope value are items', () => {
    expect(focusBodyKind([row('svc-a', 'item', 0, 99.9), row('svc-b', 'item', 0, 99.2)])).toBe('items')
    expect(focusBodyKind([row('root', 'unit', 0, null), row('svc-a', 'item', 1, 99.9)])).toBe('items')
  })

  it('item rows plus a unit scope with a value are a chart', () => {
    expect(focusBodyKind([row('root', 'unit', 0, 99.95), row('svc-a', 'item', 1, 99.9)])).toBe('chart')
  })

  it('no rows are a chart', () => {
    expect(focusBodyKind([])).toBe('chart')
  })
})
