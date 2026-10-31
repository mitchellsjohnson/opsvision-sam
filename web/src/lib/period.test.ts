import { describe, expect, it } from 'vitest'
import {
  calendarMonth,
  convertGrain,
  currentMonth,
  endMonth,
  fiscalMonthName,
  formatPeriod,
  halfOf,
  monthLabel,
  monthOf,
  monthsOf,
  parsePeriod,
  periodLabel,
  prev,
  quarterOf,
  sameLastYear,
  shiftYear,
  viewRequest,
  ytd,
} from './period'

const p = (s: string) => {
  const parsed = parsePeriod(s)
  if (!parsed) throw new Error(`bad period ${s}`)
  return parsed
}
const f = (s: string) => formatPeriod(p(s))

describe('parse and format', () => {
  it('round-trips every grain', () => {
    expect(parsePeriod('2026-M10')).toEqual({ grain: 'month', fy: 2026, index: 10 })
    expect(parsePeriod('2026-Q3')).toEqual({ grain: 'quarter', fy: 2026, index: 3 })
    expect(parsePeriod('2026-H2')).toEqual({ grain: 'half', fy: 2026, index: 2 })
    expect(parsePeriod('2026-FY')).toEqual({ grain: 'year', fy: 2026, index: 0 })
    for (const s of ['2026-M03', '2026-Q4', '2026-H1', '2026-FY']) expect(f(s)).toBe(s)
  })

  it('rejects invalid strings', () => {
    for (const s of ['2026-M13', '2026-M00', '2026-Q5', '2026-H3', 'nope', '-M01', '2026-X1', '']) {
      expect(parsePeriod(s)).toBeNull()
    }
    expect(parsePeriod(null)).toBeNull()
  })
})

describe('January fiscal start', () => {
  const s = 1
  it('maps dates to fiscal months', () => {
    expect(formatPeriod(monthOf(new Date(2026, 9, 30), s))).toBe('2026-M10')
    expect(formatPeriod(monthOf(new Date(2026, 0, 1), s))).toBe('2026-M01')
    expect(formatPeriod(monthOf(new Date(2026, 11, 31), s))).toBe('2026-M12')
    expect(currentMonth(s, new Date(2026, 9, 30))).toBe('2026-M10')
  })

  it('labels months', () => {
    expect(monthLabel(p('2026-M10'), s)).toBe('Oct 2026')
    expect(periodLabel(p('2026-M01'), s)).toBe('Jan 2026')
    expect(calendarMonth(p('2026-M12'), s)).toEqual({ year: 2026, month: 12 })
  })
})

describe('July fiscal start', () => {
  const s = 7
  it('maps dates to fiscal months; FY is the calendar year it ends in', () => {
    // July 2026 starts fiscal 2027.
    expect(formatPeriod(monthOf(new Date(2026, 6, 1), s))).toBe('2027-M01')
    expect(formatPeriod(monthOf(new Date(2026, 5, 30), s))).toBe('2026-M12')
    expect(formatPeriod(monthOf(new Date(2026, 11, 15), s))).toBe('2027-M06')
    expect(formatPeriod(monthOf(new Date(2027, 0, 1), s))).toBe('2027-M07')
    expect(formatPeriod(monthOf(new Date(2027, 5, 30), s))).toBe('2027-M12')
    expect(currentMonth(s, new Date(2026, 6, 1))).toBe('2027-M01')
  })

  it('labels fiscal months with their calendar month', () => {
    expect(monthLabel(p('2027-M01'), s)).toBe('Jul 2026')
    expect(monthLabel(p('2027-M06'), s)).toBe('Dec 2026')
    expect(monthLabel(p('2027-M07'), s)).toBe('Jan 2027')
    expect(monthLabel(p('2027-M12'), s)).toBe('Jun 2027')
    expect(monthLabel(p('2026-M12'), s)).toBe('Jun 2026')
    expect(calendarMonth(p('2027-M01'), s)).toEqual({ year: 2026, month: 7 })
  })

  it('names the months of a fiscal year from the start month', () => {
    expect([1, 6, 7, 12].map((i) => fiscalMonthName(i, s))).toEqual(['Jul', 'Dec', 'Jan', 'Jun'])
  })

  it('labels coarser periods by fiscal year', () => {
    expect(periodLabel(p('2027-Q1'), s)).toBe('Q1 FY2027')
    expect(periodLabel(p('2027-H2'), s)).toBe('H2 FY2027')
    expect(periodLabel(p('2027-FY'), s)).toBe('FY2027')
  })

  it('round-trips with monthOf', () => {
    for (let m = 0; m < 12; m++) {
      const month = monthOf(new Date(2026, m, 10), s)
      const c = calendarMonth(month, s)
      expect(c).toEqual({ year: 2026, month: m + 1 })
    }
  })
})

describe('grain arithmetic', () => {
  it('finds quarters and halves of a month', () => {
    expect([1, 3, 4, 6, 7, 9, 10, 12].map((i) => quarterOf(p(`2026-M${String(i).padStart(2, '0')}`)))).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4,
    ])
    expect(halfOf(p('2026-M06'))).toBe(1)
    expect(halfOf(p('2026-M07'))).toBe(2)
  })

  it('lists months of a period', () => {
    expect(monthsOf(p('2026-Q3')).map(formatPeriod)).toEqual(['2026-M07', '2026-M08', '2026-M09'])
    expect(monthsOf(p('2026-FY'))).toHaveLength(12)
    expect(monthsOf(p('2026-M05')).map(formatPeriod)).toEqual(['2026-M05'])
  })

  it('finds the last month and converts grains', () => {
    expect(endMonth('2026-Q3')).toBe('2026-M09')
    expect(endMonth('2026-H1')).toBe('2026-M06')
    expect(endMonth('2026-FY')).toBe('2026-M12')
    expect(endMonth('2026-M02')).toBe('2026-M02')
    expect(convertGrain('2026-M10', 'quarter')).toBe('2026-Q4')
    expect(convertGrain('2026-Q3', 'month')).toBe('2026-M09')
    expect(convertGrain('2026-M02', 'half')).toBe('2026-H1')
    expect(convertGrain('2026-H2', 'year')).toBe('2026-FY')
    expect(convertGrain('2026-M07', 'month')).toBe('2026-M07')
  })

  it('finds the previous period, wrapping the fiscal year', () => {
    expect(formatPeriod(prev(p('2027-M01')))).toBe('2026-M12')
    expect(formatPeriod(prev(p('2027-M05')))).toBe('2027-M04')
    expect(formatPeriod(prev(p('2027-Q1')))).toBe('2026-Q4')
    expect(formatPeriod(prev(p('2027-H1')))).toBe('2026-H2')
    expect(formatPeriod(prev(p('2027-FY')))).toBe('2026-FY')
  })

  it('shifts by fiscal years', () => {
    expect(formatPeriod(sameLastYear(p('2026-Q3')))).toBe('2025-Q3')
    expect(shiftYear('2026-Q3', -1)).toBe('2025-Q3')
    expect(shiftYear('2026-FY', 1)).toBe('2027-FY')
  })

  it('lists fiscal year-to-date months', () => {
    expect(ytd(p('2027-M03')).map(formatPeriod)).toEqual(['2027-M01', '2027-M02', '2027-M03'])
  })
})

describe('viewRequest', () => {
  it('builds a request with optional YTD and subjects', () => {
    expect(viewRequest({ period: '2026-Q3', ytd: false, subjects: [] })).toEqual({
      periods: ['2026-Q3'],
    })
    expect(viewRequest({ period: '2026-Q3', ytd: true, subjects: ['a'] })).toEqual({
      periods: ['2026-Q3'],
      ytd: ['2026-M09'],
      subjects: ['a'],
    })
  })
})
