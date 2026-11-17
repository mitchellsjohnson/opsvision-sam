import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildTrendColumns } from '../columns'
import { defaultStatusScale } from './chartTheme'
import { drawOrder, frontSeries, multiSeriesHeader, noTotalNote, panelMonthLabels, rangeText, spreadLabels } from './seriesLayout'

type ViewRow = components['schemas']['ViewRow']

function row(name: string, value: number | null, status: string): ViewRow {
  return {
    metricKey: 'csat',
    metricName: 'Customer satisfaction',
    categoryId: 'c',
    subjectId: name.toLowerCase(),
    subjectName: name,
    subjectKind: 'unit',
    format: 'percent0',
    depth: 1,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'ratio',
    definition: '',
    cells:
      value === null
        ? []
        : [
            {
              metricKey: 'csat',
              subjectId: name.toLowerCase(),
              period: '2026-M10',
              ytd: false,
              value,
              display: `${value}%`,
              status,
              naReason: '',
              components: {},
              coverage: [1, 1],
              change: null,
              changeKind: '',
              target: null,
              versionId: 'v',
            },
          ],
  }
}

const label = (k: string) => ({ G: 'Green', Y: 'Yellow', R: 'Red' })[k] ?? k

describe('multiSeriesHeader', () => {
  it('leads with the worst series and counts those at its status', () => {
    const rows = [row('Platform', 92, 'G'), row('Mobile', 75, 'R'), row('Data', 74, 'R'), row('Payments', 82, 'Y')]
    expect(multiSeriesHeader(rows, '2026-M10', defaultStatusScale(), label, 'segments')).toEqual({
      worst: { name: 'Data', display: '74%', status: 'R' },
      count: '2 of 4 segments Red',
    })
  })

  it('has no worst when nothing reported', () => {
    expect(multiSeriesHeader([row('A', null, '')], '2026-M10', defaultStatusScale(), label, 'segments').worst).toBeNull()
  })
})

describe('noTotalNote', () => {
  it('takes the reason from the definition when it gives one', () => {
    const definition = 'Share of survey responses rating the product 4 or 5. Each segment runs its own survey, so there is no company total.'
    expect(noTotalNote(4, 'segments', definition)).toBe('4 segments · each segment runs its own survey, so there is no company total')
    expect(noTotalNote(3, 'products', 'Share of responses.')).toBe('3 products · no company total')
  })
})

describe('spreadLabels', () => {
  it('keeps labels at their lines, 16px apart at least, inside the plot', () => {
    expect(spreadLabels([50, 10, 90], 0, 120)).toEqual([50, 10, 90])
    expect(spreadLabels([40, 41, 42], 0, 120)).toEqual([40, 56, 72])
    // Pushed past the bottom, the stack moves up.
    expect(spreadLabels([110, 112], 0, 120)).toEqual([104, 120])
  })
})

describe('panelMonthLabels', () => {
  const columns = buildTrendColumns('2026-M10', 1)

  it('short labels from 360px, initials below; unmeasured counts as wide', () => {
    expect(panelMonthLabels(columns, 360)).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    expect(panelMonthLabels(columns, 359)).toEqual(['N', 'D', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O'])
    expect(panelMonthLabels(columns, 0)).toHaveLength(12)
    expect(panelMonthLabels(columns, 0)[0]).toBe('Nov')
  })
})

describe('frontSeries', () => {
  it('the worst series is in front; a hovered one takes its place', () => {
    const rows = [row('Platform', 92, 'G'), row('Data', 74, 'R'), row('Payments', 82, 'Y')]
    expect(frontSeries(rows, '2026-M10', defaultStatusScale(), null)).toBe('data')
    expect(frontSeries(rows, '2026-M10', defaultStatusScale(), 'platform')).toBe('platform')
    expect(frontSeries([row('A', null, '')], '2026-M10', defaultStatusScale(), null)).toBe('a')
    expect(frontSeries([], '2026-M10', defaultStatusScale(), null)).toBeNull()
  })

  it('draw order puts the front series last, so it paints over the others', () => {
    const ids = ['platform', 'data', 'payments']
    expect(drawOrder(ids, 'data')).toEqual(['platform', 'payments', 'data'])
    expect(drawOrder(ids, null)).toEqual(ids)
  })
})

describe('rangeText', () => {
  it('states the unit once', () => {
    expect(rangeText('60%', '100%')).toBe('60–100%')
    expect(rangeText('2 days', '9 days')).toBe('2 days–9 days')
  })
})
