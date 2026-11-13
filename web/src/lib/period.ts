/**
 * Fiscal periods, a TypeScript port of the API's period/calendar logic
 * (api/internal/period).
 *
 * Period strings are FISCAL: `2027-M01` is the first month of fiscal year
 * 2027, whatever calendar month that is. A fiscal year is labeled by the
 * calendar year in which it ENDS, so with a July start, FY2027 runs from
 * July 2026 to June 2027. Quarters and halves are counted from the start of
 * the fiscal year. Pass the tenant's `fiscalYearStartMonth` (1-12) wherever a
 * function needs to relate a fiscal period to the calendar.
 */

export type Grain = 'month' | 'quarter' | 'half' | 'year'

export interface Period {
  grain: Grain
  /** The fiscal year, i.e. the calendar year the fiscal year ends in. */
  fy: number
  /** 1-based within the fiscal year (month 1-12, quarter 1-4, half 1-2); 0 for a year. */
  index: number
}

export const GRAINS: { value: Grain; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'half', label: 'Half' },
  { value: 'year', label: 'Year' },
]

const MONTHS_PER: Record<Grain, number> = { month: 1, quarter: 3, half: 6, year: 12 }
const PER_YEAR: Record<Grain, number> = { month: 12, quarter: 4, half: 2, year: 1 }

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const PATTERN = /^(\d+)-(?:M(\d+)|Q(\d+)|H(\d+)|(FY))$/

/** Parses `2026-M10`, `2026-Q3`, `2026-H2` or `2026-FY`; null if invalid. */
export function parsePeriod(s: string | null | undefined): Period | null {
  const m = s ? PATTERN.exec(s) : null
  if (!m) return null
  const fy = Number(m[1])
  const within = (v: string | undefined, max: number) =>
    v !== undefined && Number(v) >= 1 && Number(v) <= max ? Number(v) : null
  if (m[5]) return { grain: 'year', fy, index: 0 }
  if (m[2] !== undefined) {
    const index = within(m[2], 12)
    return index === null ? null : { grain: 'month', fy, index }
  }
  if (m[3] !== undefined) {
    const index = within(m[3], 4)
    return index === null ? null : { grain: 'quarter', fy, index }
  }
  const index = within(m[4], 2)
  return index === null ? null : { grain: 'half', fy, index }
}

/** Formats a period as `2026-M10`, `2026-Q3`, `2026-H2` or `2026-FY`. */
export function formatPeriod(p: Period): string {
  switch (p.grain) {
    case 'month':
      return `${p.fy}-M${String(p.index).padStart(2, '0')}`
    case 'quarter':
      return `${p.fy}-Q${p.index}`
    case 'half':
      return `${p.fy}-H${p.index}`
    case 'year':
      return `${p.fy}-FY`
  }
}

/** A start month outside 1-12 counts as January, as in the API. */
function startMonth(fiscalYearStartMonth: number): number {
  return Number.isInteger(fiscalYearStartMonth) && fiscalYearStartMonth >= 1 && fiscalYearStartMonth <= 12
    ? fiscalYearStartMonth
    : 1
}

/** The fiscal month containing a date (its local year and month). */
export function monthOf(date: Date, fiscalYearStartMonth: number): Period {
  const s = startMonth(fiscalYearStartMonth)
  const m = date.getMonth() + 1
  let fy = date.getFullYear()
  if (s !== 1 && m >= s) fy++
  return { grain: 'month', fy, index: ((m - s + 12) % 12) + 1 }
}

/** The fiscal month containing today. */
export function currentMonth(fiscalYearStartMonth: number, now: Date = new Date()): string {
  return formatPeriod(monthOf(now, fiscalYearStartMonth))
}

/** The calendar year and month (1-12) a fiscal month falls in. */
export function calendarMonth(
  month: Period,
  fiscalYearStartMonth: number,
): { year: number; month: number } {
  const s = startMonth(fiscalYearStartMonth)
  const startYear = s === 1 ? month.fy : month.fy - 1
  const offset = s - 1 + (month.index - 1)
  return { year: startYear + Math.floor(offset / 12), month: (offset % 12) + 1 }
}

/** `Oct 2026` for a fiscal month. */
export function monthLabel(month: Period, fiscalYearStartMonth: number): string {
  const c = calendarMonth(month, fiscalYearStartMonth)
  return `${MONTH_NAMES[c.month - 1]} ${c.year}`
}

/** Short calendar name (`Jul`) of the nth (1-based) month of the fiscal year. */
export function fiscalMonthName(index: number, fiscalYearStartMonth: number): string {
  const s = startMonth(fiscalYearStartMonth)
  return MONTH_NAMES[(s - 1 + index - 1) % 12] ?? ''
}

/** `Oct 2026`, `Q3 FY2026`, `H2 FY2026` or `FY2026`. */
export function periodLabel(p: Period, fiscalYearStartMonth: number): string {
  switch (p.grain) {
    case 'month':
      return monthLabel(p, fiscalYearStartMonth)
    case 'quarter':
      return `Q${p.index} FY${p.fy}`
    case 'half':
      return `H${p.index} FY${p.fy}`
    case 'year':
      return `FY${p.fy}`
  }
}

/** The months of a period, in order. */
export function monthsOf(p: Period): Period[] {
  const n = MONTHS_PER[p.grain]
  const first = p.grain === 'year' ? 1 : (p.index - 1) * n + 1
  return Array.from({ length: n }, (_, i) => ({ grain: 'month', fy: p.fy, index: first + i }))
}

/** The last month of a period. */
export function lastMonth(p: Period): Period {
  const months = monthsOf(p)
  return months[months.length - 1] as Period
}

/** The period of grain `g` that contains `month`. */
export function parent(month: Period, g: Grain): Period {
  if (g === 'year') return { grain: 'year', fy: month.fy, index: 0 }
  return { grain: g, fy: month.fy, index: Math.floor((month.index - 1) / MONTHS_PER[g]) + 1 }
}

/** The quarter (1-4) a fiscal month belongs to. */
export function quarterOf(month: Period): number {
  return parent(month, 'quarter').index
}

/** The half (1-2) a fiscal month belongs to. */
export function halfOf(month: Period): number {
  return parent(month, 'half').index
}

/** The immediately preceding period of the same grain. */
export function prev(p: Period): Period {
  if (p.grain === 'year') return { ...p, fy: p.fy - 1 }
  if (p.index > 1) return { ...p, index: p.index - 1 }
  return { ...p, fy: p.fy - 1, index: PER_YEAR[p.grain] }
}

/** The same period one fiscal year earlier. */
export function sameLastYear(p: Period): Period {
  return { ...p, fy: p.fy - 1 }
}

/** The months from the start of a month's fiscal year through that month. */
export function ytd(month: Period): Period[] {
  return Array.from({ length: month.index }, (_, i) => ({ ...month, index: i + 1 }))
}

// String conveniences for URL state. Invalid input is returned unchanged.

/** The last month of a period string, as a month period string. */
export function endMonth(period: string): string {
  const p = parsePeriod(period)
  return p ? formatPeriod(lastMonth(p)) : period
}

/** The period string of another grain that contains the last month of `period`. */
export function convertGrain(period: string, grain: Grain): string {
  const p = parsePeriod(period)
  return p ? formatPeriod(parent(lastMonth(p), grain)) : period
}

/** The same period `delta` fiscal years later (or earlier, when negative). */
export function shiftYear(period: string, delta: number): string {
  const p = parsePeriod(period)
  return p ? formatPeriod({ ...p, fy: p.fy + delta }) : period
}

/** Navigation state kept in the URL search params. */
export interface PeriodState {
  period: string
  ytd: boolean
  subjects: string[]
}

export interface ViewRequest {
  periods?: string[]
  ytd?: string[]
  subjects?: string[]
  restate?: string
  structure?: 'as_of' | 'current'
  metrics?: string[]
}

/** The scorecard view request for the shell's period state. */
export function viewRequest(state: PeriodState): ViewRequest {
  const req: ViewRequest = { periods: [state.period] }
  if (state.ytd) req.ytd = [endMonth(state.period)]
  if (state.subjects.length > 0) req.subjects = state.subjects
  return req
}
