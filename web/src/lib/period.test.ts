import { describe, expect, it } from 'vitest'
import {
  currentMonth,
  convertGrain,
  endMonth,
  formatPeriod,
  parsePeriod,
  shiftYear,
  viewRequest,
} from './period'

describe('period helpers', () => {
  it('parses and formats every grain', () => {
    expect(parsePeriod('2026-M10')).toEqual({ year: 2026, grain: 'month', n: 10 })
    expect(parsePeriod('2026-Q3')).toEqual({ year: 2026, grain: 'quarter', n: 3 })
    expect(parsePeriod('2026-H2')).toEqual({ year: 2026, grain: 'half', n: 2 })
    expect(parsePeriod('2026-FY')).toEqual({ year: 2026, grain: 'year', n: 1 })
    expect(parsePeriod('2026-M13')).toBeNull()
    expect(parsePeriod('nope')).toBeNull()
    expect(formatPeriod({ year: 2026, grain: 'month', n: 3 })).toBe('2026-M03')
    expect(formatPeriod({ year: 2026, grain: 'year', n: 1 })).toBe('2026-FY')
  })

  it('finds the month a period ends in', () => {
    expect(endMonth('2026-Q3')).toBe('2026-M09')
    expect(endMonth('2026-H1')).toBe('2026-M06')
    expect(endMonth('2026-FY')).toBe('2026-M12')
    expect(endMonth('2026-M02')).toBe('2026-M02')
  })

  it('converts between grains around the end month', () => {
    expect(convertGrain('2026-M10', 'quarter')).toBe('2026-Q4')
    expect(convertGrain('2026-Q3', 'month')).toBe('2026-M09')
    expect(convertGrain('2026-M02', 'half')).toBe('2026-H1')
    expect(convertGrain('2026-H2', 'year')).toBe('2026-FY')
    expect(convertGrain('2026-M07', 'month')).toBe('2026-M07')
  })

  it('shifts the year', () => {
    expect(shiftYear('2026-Q3', -1)).toBe('2025-Q3')
  })

  it('builds the current month', () => {
    expect(currentMonth(new Date(2026, 9, 30))).toBe('2026-M10')
  })

  it('builds a view request with optional YTD and subjects', () => {
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
