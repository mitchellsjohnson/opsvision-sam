import { describe, expect, it } from 'vitest'
import { RANGES } from './charts/ranges'
import { focusRequestOptions, focusWindow } from './focusRequest'
import { scorecardViewRequest } from './viewRequest'

function state(period: string, over: { ytd?: boolean } = {}) {
  return {
    period,
    ytd: over.ytd ?? false,
    subjects: [] as string[],
    scope: '',
    restate: '',
    structure: 'as_of' as const,
    fiscalYearStartMonth: 1,
  }
}

const FREQUENCIES = ['monthly', 'quarterly', 'biannual', 'annual'] as const

describe('focusWindow', () => {
  it('monthly in a month view: 12 months up to 12M and YTD, 24 for 24M', () => {
    expect(focusWindow('3M', '2026-M10', 'monthly')).toEqual({ grain: 'month', count: 12 })
    expect(focusWindow('12M', '2026-M10', 'monthly')).toEqual({ grain: 'month', count: 12 })
    expect(focusWindow('YTD', '2026-M10', 'monthly')).toEqual({ grain: 'month', count: 12 })
    expect(focusWindow('24M', '2026-M10', 'monthly')).toEqual({ grain: 'month', count: 24 })
  })

  it('coarse metrics ask for their own grain whatever the range: quarters×8, halves×4, years×3', () => {
    for (const { key } of RANGES) {
      expect(focusWindow(key, '2026-M10', 'quarterly')).toEqual({ grain: 'quarter', count: 8 })
      expect(focusWindow(key, '2026-M10', 'biannual')).toEqual({ grain: 'half', count: 4 })
      expect(focusWindow(key, '2026-M10', 'annual')).toEqual({ grain: 'year', count: 3 })
    }
  })

  it('a metric finer than the selected grain uses the selected grain’s trend', () => {
    expect(focusWindow('24M', '2026-Q3', 'monthly')).toEqual({ grain: 'quarter', count: 8 })
    expect(focusWindow('12M', '2026-H1', 'quarterly')).toEqual({ grain: 'half', count: 4 })
    expect(focusWindow('12M', '2025-FY', 'biannual')).toEqual({ grain: 'year', count: 3 })
  })
})

describe('focusRequestOptions', () => {
  it('requests never exceed 24 periods', () => {
    for (const range of RANGES)
      for (const freq of FREQUENCIES)
        for (const period of ['2026-M10', '2026-Q3', '2026-H1', '2025-FY']) {
          const req = scorecardViewRequest(state(period), {}, focusRequestOptions(focusWindow(range.key, period, freq), 'm'))
          expect(req.periods!.length, `${range.key} ${freq} ${period}`).toBeLessThanOrEqual(24)
        }
    expect(scorecardViewRequest(state('2026-M10', { ytd: true }), {}, { coarse: ['quarter', 'half', 'year'] }).periods).toHaveLength(21)
  })

  it('monthly metrics send exactly today’s requests: the shared 12 months, or 24 months of one metric', () => {
    const s = state('2026-M10')
    expect(scorecardViewRequest(s, {}, focusRequestOptions(focusWindow('12M', '2026-M10', 'monthly'), 'm'))).toEqual(
      scorecardViewRequest(s, {}),
    )
    expect(scorecardViewRequest(s, {}, focusRequestOptions(focusWindow('24M', '2026-M10', 'monthly'), 'm'))).toEqual(
      scorecardViewRequest(s, {}, { months: 24, metrics: ['m'] }),
    )
  })

  it('a coarse metric asks for its own grain only, for itself', () => {
    const req = scorecardViewRequest(state('2026-M10'), {}, focusRequestOptions(focusWindow('12M', '2026-M10', 'quarterly'), 'm'))
    expect(req.periods).toEqual(['2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3'])
    expect(req.metrics).toEqual(['m'])
  })

  it('a window wins over coarse grains: never mixed', () => {
    const req = scorecardViewRequest(state('2026-M10'), {}, { window: { grain: 'year', count: 3 }, coarse: ['quarter'] })
    expect(req.periods).toEqual(['2023-FY', '2024-FY', '2025-FY'])
  })
})
