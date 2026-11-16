import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { worstChildren } from './drivers'

type ViewRow = components['schemas']['ViewRow']

const PERIOD = '2026-M10'
const SCALE = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]

function child(name: string, value: number | null, status: string, naReason = ''): ViewRow {
  return {
    metricKey: 'm',
    metricName: 'Metric',
    categoryId: 'c',
    subjectId: name.toLowerCase(),
    subjectName: name,
    subjectKind: 'unit',
    format: 'percent0',
    depth: 1,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'ratio',
    cells: [
      {
        metricKey: 'm',
        subjectId: name.toLowerCase(),
        period: PERIOD,
        ytd: false,
        value,
        display: value === null ? '' : `${value}%`,
        status,
        naReason,
        components: {},
        coverage: [],
        change: null,
        changeKind: '',
        target: null,
        versionId: '',
      },
    ],
  }
}

describe('worstChildren', () => {
  it('ranks reported children worst first and counts the worst status', () => {
    const children = [
      child('Mobile', 86, 'Y'),
      child('Data', 75, 'R'),
      child('Archive', null, '', 'Retired'),
      child('Payments', 55, 'R'),
    ]
    const result = worstChildren(children, PERIOD, SCALE, 'higher_better')
    expect(result.worst?.row.subjectName).toBe('Payments')
    expect(result.worstCount).toBe(2)
    expect(result.total).toBe(3)
    expect(result.ranked.map((r) => r.row.subjectName)).toEqual(['Payments', 'Data', 'Mobile'])
    expect(result.ranked.map((r) => r.rank)).toEqual([3, 3, 2])
  })

  it('picks the highest value first when lower is better', () => {
    const children = [child('Web', 300, 'G'), child('iOS', 700, 'R'), child('Android', 941, 'R')]
    const result = worstChildren(children, PERIOD, SCALE, 'lower_better')
    expect(result.ranked.map((r) => r.row.subjectName)).toEqual(['Android', 'iOS', 'Web'])
  })

  it('breaks ties by name', () => {
    const children = [child('Zeta', 70, 'R'), child('Alpha', 70, 'R')]
    expect(worstChildren(children, PERIOD, SCALE, 'higher_better').ranked.map((r) => r.row.subjectName)).toEqual(['Alpha', 'Zeta'])
  })

  it('is empty when no child reported', () => {
    const result = worstChildren([child('Archive', null, '', 'Retired')], PERIOD, SCALE, 'higher_better')
    expect(result).toEqual({ ranked: [], worst: null, worstCount: 0, total: 0 })
  })
})
