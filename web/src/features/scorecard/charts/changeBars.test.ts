import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildTrendColumns, coarseColumns } from '../columns'
import { defaultStatusScale } from './chartTheme'
import { changeBarsFor, changeCaption, changeEdges, changeSummary, isChangeRow, keptLabels, worseText } from './changeBars'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

const columns = buildTrendColumns('2026-M10', 1)
const RULE: Cell['rule'] = {
  type: 'change',
  compare: 'prior_period',
  bands: [
    { status: 'G', op: '>=', value: 0 },
    { status: 'Y', op: '>=', value: -5 },
    { status: 'R', op: '', value: 0 },
  ],
}

/** The demo's weighted defect score: Aug improved 33%, Sep and Oct got about 27% and 26% worse. */
function defectRow(edit?: (cells: Cell[]) => void): ViewRow {
  const changes: Record<string, [number | null, string]> = {
    '2026-M08': [33.13, 'G'],
    '2026-M09': [-26.945, 'R'],
    '2026-M10': [-26.0, 'R'],
  }
  const cells: Cell[] = columns.map((c, i) => {
    const [change, status] = changes[c.period] ?? [i === 0 ? null : 1.5, 'G']
    return {
      metricKey: 'weighted_defect_score',
      subjectId: 'root',
      period: c.period,
      ytd: false,
      value: 20 + i * 0.2,
      display: (20 + i * 0.2).toFixed(2),
      status,
      naReason: '',
      components: {},
      coverage: [1, 1],
      change,
      changeKind: change === null ? '' : 'improvement_pct',
      target: null,
      versionId: 'v',
      rule: RULE,
    }
  })
  edit?.(cells)
  return {
    metricKey: 'weighted_defect_score',
    metricName: 'Weighted defect score',
    categoryId: 'quality',
    subjectId: 'root',
    subjectName: 'All units',
    subjectKind: 'unit',
    format: 'number2',
    depth: 0,
    direction: 'lower_better',
    frequency: 'monthly',
    chartKind: 'ratio',
    definition: '',
    cells,
  }
}

describe('changeBarsFor', () => {
  it('an improvement percentage is positive when better, so a bar measures how much worse: −change', () => {
    const bars = changeBarsFor(defectRow(), columns)
    expect(bars).toHaveLength(12)
    const sep = bars.find((b) => b.key === '2026-M09')!
    expect(sep.worse).toBeCloseTo(26.95, 2)
    expect(sep.status).toBe('R')
    const aug = bars.find((b) => b.key === '2026-M08')!
    expect(aug.worse).toBeCloseTo(-33.13, 2)
    expect(aug.status).toBe('G')
  })

  it('a column without a change has no bar', () => {
    expect(changeBarsFor(defectRow(), columns)[0]).toEqual({ key: columns[0]!.key, worse: null, status: 'G' })
    const missing = changeBarsFor(defectRow((cells) => cells.splice(3, 1)), columns)[3]!
    expect(missing).toEqual({ key: columns[3]!.key, worse: null, status: '' })
  })

  it('a delta reads worse by the direction', () => {
    const row = defectRow((cells) => Object.assign(cells.at(-1)!, { change: 2, changeKind: 'delta' }))
    expect(changeBarsFor(row, columns).at(-1)!.worse).toBe(2)
    row.direction = 'higher_better'
    expect(changeBarsFor(row, columns).at(-1)!.worse).toBe(-2)
  })
})

describe('isChangeRow', () => {
  it('a change rule on the last column', () => {
    expect(isChangeRow(defectRow(), columns)).toBe(true)
    expect(isChangeRow(defectRow((cells) => (cells.at(-1)!.rule = { type: 'bands', bands: [] })), columns)).toBe(false)
  })
})

describe('changeEdges', () => {
  it('the band edges in worse terms, and the Red boundary: −(−5) = +5% worse', () => {
    expect(changeEdges(defectRow(), columns)).toEqual({ edges: [0, 5], red: 5 })
  })
})

describe('changeCaption', () => {
  it('follows the comparison and the grain', () => {
    expect(changeCaption('prior_period', columns[0])).toBe('Change vs the prior month')
    expect(changeCaption('prior_period', coarseColumns('2026-M10', 'quarter', 4, 1)[0])).toBe('Change vs the prior quarter')
    expect(changeCaption('prior_year_average', columns[0])).toBe("Change vs last year's average")
    expect(changeCaption('baseline', columns[0])).toBe('Change vs the baseline')
  })
})

describe('worseText', () => {
  it('rounds to whole percent with a sign', () => {
    expect(worseText(26.945)).toBe('+27%')
    expect(worseText(-33.13)).toBe('−33%')
    expect(worseText(0.2)).toBe('0%')
  })
})

describe('changeSummary', () => {
  it('names every period not at the best status', () => {
    const bars = changeBarsFor(defectRow(), columns)
    const label = (k: string) => ({ G: 'Green', Y: 'Yellow', R: 'Red' })[k] ?? k
    expect(changeSummary(bars, columns, defaultStatusScale(), label)).toBe('Changes: Sep 27% worse (Red), Oct 26% worse (Red)')
    expect(changeSummary(bars.map((b) => ({ ...b, status: 'G' })), columns, defaultStatusScale(), label)).toBe('')
  })
})

describe('keptLabels', () => {
  const red = (index: number, text = '+27%') => ({ index, rank: 3, text })
  it('keeps every label with room, or before the bars are measured', () => {
    expect([...keptLabels([red(10), red(11, '+26%')], 40, 12)].sort()).toEqual([10, 11])
    expect([...keptLabels([red(10), red(11, '+26%')], 0, 12)].sort()).toEqual([10, 11])
  })

  it('in narrow columns, the worst first, then the latest; a label that would overlap is dropped', () => {
    expect([...keptLabels([red(10), red(11, '+26%')], 19, 12)]).toEqual([11])
    const yellow = (index: number) => ({ index, rank: 2, text: '+2%' })
    expect([...keptLabels([yellow(0), yellow(1), red(11)], 19, 12)].sort((a, b) => a - b)).toEqual([1, 11])
  })
})
