import { describe, expect, it } from 'vitest'
import { buildTrendColumns } from '../columns'
import { formatMoneyCompact, moneyPlanDomain, overPlanPhrase, symmetricPlanDomain } from './moneyPlan'

describe('moneyPlanDomain', () => {
  it('every month over plan: the under side is a fifth of the over side, at least 3 points', () => {
    expect(moneyPlanDomain([8, 9, 11, 7, 10, 7, 7, 8, 7, 7, 10, 4])).toEqual([-3, 15])
    expect(moneyPlanDomain([25, 15])).toEqual([-6, 28])
  })

  it('every month under plan: the mirror', () => {
    expect(moneyPlanDomain([-8, -12, -4])).toEqual([-15, 3])
  })

  it('mixed months keep the symmetric domain', () => {
    expect(moneyPlanDomain([-5, 9])).toEqual([-15, 15])
    expect(moneyPlanDomain([-20, 4])).toEqual([-23, 23])
  })

  it('one month in view still gets room on both sides', () => {
    expect(moneyPlanDomain([4])).toEqual([-3, 15])
    expect(moneyPlanDomain([])).toEqual([-15, 15])
  })
})

describe('symmetricPlanDomain', () => {
  it('centres values on 100%, padded by the largest deviation plus 3, at least ±15', () => {
    expect(symmetricPlanDomain([96, 111])).toEqual([85, 115])
    expect(symmetricPlanDomain([80, 130])).toEqual([67, 133])
    expect(symmetricPlanDomain([])).toEqual([85, 115])
  })
})

describe('overPlanPhrase', () => {
  it('the over-plan count in lower case, for the tile value row', () => {
    const columns = buildTrendColumns('2026-M10', 1).slice(-2)
    const point = (value: number | null) => ({ key: '', label: '', fullLabel: '', value, display: '', status: '', naReason: '', overrideReason: '', change: null, kind: value === null ? ('missing' as const) : ('value' as const) })
    expect(overPlanPhrase([point(104), point(96)], columns)).toBe('over plan in 1 of the last 2 months')
    expect(overPlanPhrase([point(null), point(null)], columns)).toBe('')
  })
})

describe('formatMoneyCompact', () => {
  it('thousands read as millions from $1,000k, one decimal', () => {
    expect(formatMoneyCompact(12668, '$k')).toBe('$12.7M')
    expect(formatMoneyCompact(1000, '$k')).toBe('$1.0M')
    expect(formatMoneyCompact(950, '$k')).toBe('$950k')
    expect(formatMoneyCompact(949.6, '$k')).toBe('$950k')
  })

  it('other units read as plain numbers', () => {
    expect(formatMoneyCompact(12668, 'count')).toBe('12,668')
    expect(formatMoneyCompact(12.5, '')).toBe('12.5')
  })
})
