import { describe, expect, it } from 'vitest'
import { buildColumns, columnRequest } from './columns'

const keys = (cols: ReturnType<typeof buildColumns>) => cols.map((c) => c.key)
const labels = (cols: ReturnType<typeof buildColumns>) => cols.map((c) => c.label)

describe('buildColumns', () => {
  it('month grain: the 12 fiscal months ending at the selected month', () => {
    const cols = buildColumns('2026-M10', false, 1)
    expect(cols).toHaveLength(12)
    expect(keys(cols)[0]).toBe('2025-M11')
    expect(keys(cols)[11]).toBe('2026-M10')
    expect(labels(cols)).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
  })

  it('month grain with a July fiscal start labels calendar months', () => {
    const cols = buildColumns('2026-M03', false, 7)
    expect(keys(cols)[0]).toBe('2025-M04')
    expect(labels(cols)[11]).toBe('Sep') // M01 is Jul 2025, so M03 is Sep 2025
  })

  it('month grain adds a YTD column through the selected month', () => {
    const cols = buildColumns('2026-M10', true, 1)
    expect(cols).toHaveLength(13)
    const ytd = cols[12]!
    expect(ytd.key).toBe('YTD:2026-M10')
    expect(ytd.label).toBe('YTD')
    expect(ytd.ytd).toBe(true)
    expect(ytd.period).toBe('2026-M10')
    expect(ytd.fullLabel).toBe('Year to date through Oct 2026')
  })

  it('quarter grain: the quarters of that fiscal year up to the selected one', () => {
    const cols = buildColumns('2026-Q3', false, 1)
    expect(keys(cols)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3'])
    expect(labels(cols)).toEqual(['Q1', 'Q2', 'Q3'])
  })

  it('quarter grain adds YTD through the last month of the quarter', () => {
    const cols = buildColumns('2026-Q3', true, 1)
    expect(keys(cols)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', 'YTD:2026-M09'])
  })

  it('half grain: halves up to the selected one, plus YTD', () => {
    expect(keys(buildColumns('2026-H1', false, 1))).toEqual(['2026-H1'])
    expect(keys(buildColumns('2026-H2', true, 1))).toEqual(['2026-H1', '2026-H2', 'YTD:2026-M12'])
    expect(labels(buildColumns('2026-H2', false, 1))).toEqual(['H1', 'H2'])
  })

  it('year grain: the selected and two prior fiscal years, never YTD', () => {
    const cols = buildColumns('2026-FY', true, 1)
    expect(keys(cols)).toEqual(['2024-FY', '2025-FY', '2026-FY'])
    expect(labels(cols)).toEqual(['FY2024', 'FY2025', 'FY2026'])
  })
})

describe('columnRequest', () => {
  it('splits columns into periods and ytd months', () => {
    expect(columnRequest(buildColumns('2026-Q3', true, 1))).toEqual({
      periods: ['2026-Q1', '2026-Q2', '2026-Q3'],
      ytd: ['2026-M09'],
    })
    expect(columnRequest(buildColumns('2026-FY', false, 1))).toEqual({
      periods: ['2024-FY', '2025-FY', '2026-FY'],
    })
  })
})
