import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildMonthTrendColumns } from '../columns'
import { RANGES, rangeChange, rangeMonths } from './ranges'

type ViewRow = components['schemas']['ViewRow']

const columns = buildMonthTrendColumns('2026-M10', 24, 1)

function rowWith(
  values: (number | null | 'na')[],
  format: ViewRow['format'] = 'percent1',
  direction: ViewRow['direction'] = 'higher_better',
): ViewRow {
  const cols = columns.slice(-values.length)
  return {
    metricKey: 'm',
    metricName: 'M',
    categoryId: 'c',
    subjectId: 'root',
    subjectName: 'All units',
    subjectKind: 'unit',
    format,
    depth: 0,
    direction,
    frequency: 'monthly',
    chartKind: 'ratio',
    definition: '',
    cells: values.flatMap((v, i) =>
      v === null
        ? []
        : [
            {
              metricKey: 'm',
              subjectId: 'root',
              period: cols[i]!.period,
              ytd: false,
              value: v === 'na' ? null : v,
              display: '',
              status: '',
              naReason: v === 'na' ? 'Not measured' : '',
              components: {},
              coverage: [1, 1],
              change: null,
              changeKind: '',
              target: null,
              versionId: 'v',
            },
          ],
    ),
  }
}

describe('rangeMonths', () => {
  it('counts months per range, and YTD from the fiscal year start', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['3M', '6M', '12M', 'YTD', '24M'])
    expect(rangeMonths('3M', '2026-M10')).toBe(3)
    expect(rangeMonths('6M', '2026-M10')).toBe(6)
    expect(rangeMonths('12M', '2026-M10')).toBe(12)
    expect(rangeMonths('24M', '2026-M10')).toBe(24)
    expect(rangeMonths('YTD', '2026-M10')).toBe(10)
    // With a July start, fiscal 2027-M04 is October 2026: YTD is Jul through Oct.
    expect(rangeMonths('YTD', '2027-M04')).toBe(4)
    const july = buildMonthTrendColumns('2027-M04', 12, 7).slice(-rangeMonths('YTD', '2027-M04'))
    expect(july.map((c) => c.label)).toEqual(['Jul', 'Aug', 'Sep', 'Oct'])
  })
})

describe('rangeChange', () => {
  it('is the last value less the first in range, in points for a percentage', () => {
    const row = rowWith([80, 81, 82.1])
    const change = rangeChange(row, columns.slice(-3))!
    expect(change.text).toBe('+2.1 pts')
    expect(change.move).toEqual({ arrow: '▲', tone: 'good' })
  })

  it('is bad when the value rises and lower is better', () => {
    const change = rangeChange(rowWith([80, 82.1], 'percent1', 'lower_better'), columns.slice(-2))!
    expect(change.move).toEqual({ arrow: '▲', tone: 'bad' })
  })

  it('formats other metrics with their format and a sign', () => {
    expect(rangeChange(rowWith([2, 1.5], 'number1'), columns.slice(-2))!.text).toBe('-0.5')
    expect(rangeChange(rowWith([10, 22], 'money_k'), columns.slice(-2))!.text).toBe('+$12k')
    expect(rangeChange(rowWith([4, 7], 'days0'), columns.slice(-2))!.text).toBe('+3 days')
    expect(rangeChange(rowWith([2, 1.5], 'number1'), columns.slice(-2))!.move).toEqual({ arrow: '▼', tone: 'bad' })
  })

  it('skips n/a and missing periods at either end', () => {
    const row = rowWith(['na', 80, null, 83, 'na'])
    expect(rangeChange(row, columns.slice(-5))!.text).toBe('+3.0 pts')
  })

  it('a change-rule metric states its range change in the header’s terms: better or worse by a percentage', () => {
    const changeRule = (values: number[], direction: ViewRow['direction'] = 'lower_better') => {
      const row = rowWith(values, 'number2', direction)
      for (const c of row.cells) c.rule = { type: 'change', compare: 'prior_period', bands: [] }
      return row
    }
    // Lower is better: 18.10 to 22.81 is 26% worse.
    const worse = rangeChange(changeRule([18.1, 20, 22.81]), columns.slice(-3))!
    expect(worse.text).toBe('26% worse')
    expect(worse.move).toEqual({ arrow: '▲', tone: 'bad' })
    const better = rangeChange(changeRule([20, 15]), columns.slice(-2))!
    expect(better).toEqual({ text: '25% better', move: { arrow: '▼', tone: 'good' } })
    expect(rangeChange(changeRule([80, 100], 'higher_better'), columns.slice(-2))!.text).toBe('25% better')
    expect(rangeChange(changeRule([20, 20]), columns.slice(-2))!.text).toBe('No change')
    // From zero there is no percentage to give.
    expect(rangeChange(changeRule([0, 3]), columns.slice(-2))).toBeNull()
  })

  it('is unchanged when the ends match, and unknown with fewer than two values', () => {
    const same = rangeChange(rowWith([80, 82, 80]), columns.slice(-3))!
    expect(same.text).toBe('No change')
    expect(same.move).toEqual({ arrow: '', tone: 'neutral' })
    expect(rangeChange(rowWith(['na', 80]), columns.slice(-2))).toBeNull()
  })
})
