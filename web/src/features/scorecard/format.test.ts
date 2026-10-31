import { describe, expect, it } from 'vitest'
import { changeText, formatDate, formatMetricValue } from './format'

describe('formatMetricValue', () => {
  it('formats by metric format', () => {
    expect(formatMetricValue('percent1', 94.5)).toBe('94.5%')
    expect(formatMetricValue('percent0', 94.5)).toBe('95%')
    expect(formatMetricValue('number2', 1.5)).toBe('1.50')
    expect(formatMetricValue('money_k', 1200)).toBe('$1,200k')
    expect(formatMetricValue('days0', 1)).toBe('1 day')
    expect(formatMetricValue('days0', 3)).toBe('3 days')
  })
})

describe('formatDate', () => {
  it('formats an ISO timestamp as yyyy-mm-dd (UTC)', () => {
    expect(formatDate('2026-10-05T23:30:00Z')).toBe('2026-10-05')
  })
})

describe('changeText', () => {
  const base = { period: '2026-M10', ytd: false, format: 'percent1', fyStart: 1 }
  it('delta: signed value with units and the prior period', () => {
    expect(changeText({ ...base, change: 2.1, changeKind: 'delta' })).toBe('+2.1 pts vs Sep')
    expect(changeText({ ...base, change: -0.5, changeKind: 'delta' })).toBe('-0.5 pts vs Sep')
    expect(changeText({ ...base, change: 0, changeKind: 'delta' })).toBe('No change vs Sep')
    expect(changeText({ ...base, format: 'days0', change: -2, changeKind: 'delta' })).toBe('-2 days vs Sep')
  })
  it('improvement_pct: worse or better, direction already applied', () => {
    expect(changeText({ ...base, change: -17, changeKind: 'improvement_pct' })).toBe('17% worse vs Sep')
    expect(changeText({ ...base, change: 12, changeKind: 'improvement_pct' })).toBe('12% better vs Sep')
    expect(changeText({ ...base, change: 12.34, changeKind: 'improvement_pct' })).toBe('12.3% better vs Sep')
  })
  it('names the comparison the rule uses', () => {
    expect(
      changeText({ ...base, change: 5, changeKind: 'improvement_pct', compare: 'prior_year_average' }),
    ).toBe("5% better vs last year's average")
    expect(
      changeText({ ...base, change: 5, changeKind: 'improvement_pct', compare: 'baseline' }),
    ).toBe('5% better vs baseline')
  })
  it('uses the prior grain unit and YTD wording', () => {
    expect(changeText({ ...base, period: '2026-Q1', change: 1, changeKind: 'delta' })).toBe('+1.0 pts vs Q4')
    expect(changeText({ ...base, ytd: true, change: 1, changeKind: 'delta' })).toBe('+1.0 pts vs YTD last year')
  })
  it('is null when there is no change', () => {
    expect(changeText({ ...base, change: null, changeKind: '' })).toBeNull()
  })
})
