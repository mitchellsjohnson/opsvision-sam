/** Period strings: `2026-M10`, `2026-Q3`, `2026-H2`, `2026-FY`. */

export type Grain = 'month' | 'quarter' | 'half' | 'year'

export interface ParsedPeriod {
  year: number
  grain: Grain
  /** Month 1-12, quarter 1-4, half 1-2; always 1 for a year. */
  n: number
}

export const GRAINS: { value: Grain; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'half', label: 'Half' },
  { value: 'year', label: 'Year' },
]

const PATTERN = /^(\d{4})-(?:M(0[1-9]|1[0-2])|Q([1-4])|H([12])|(FY))$/

export function parsePeriod(s: string | null | undefined): ParsedPeriod | null {
  const m = s ? PATTERN.exec(s) : null
  if (!m) return null
  const year = Number(m[1])
  if (m[2]) return { year, grain: 'month', n: Number(m[2]) }
  if (m[3]) return { year, grain: 'quarter', n: Number(m[3]) }
  if (m[4]) return { year, grain: 'half', n: Number(m[4]) }
  return { year, grain: 'year', n: 1 }
}

export function formatPeriod(p: ParsedPeriod): string {
  const y = String(p.year).padStart(4, '0')
  switch (p.grain) {
    case 'month':
      return `${y}-M${String(p.n).padStart(2, '0')}`
    case 'quarter':
      return `${y}-Q${p.n}`
    case 'half':
      return `${y}-H${p.n}`
    case 'year':
      return `${y}-FY`
  }
}

const MONTHS_PER: Record<Grain, number> = { month: 1, quarter: 3, half: 6, year: 12 }

function endMonthNumber(p: ParsedPeriod): number {
  return p.n * MONTHS_PER[p.grain]
}

/** The month a period ends in, as a month period. */
export function endMonth(period: string): string {
  const p = parsePeriod(period)
  if (!p) return period
  return formatPeriod({ year: p.year, grain: 'month', n: endMonthNumber(p) })
}

/** The period of another grain that contains the end month of `period`. */
export function convertGrain(period: string, grain: Grain): string {
  const p = parsePeriod(period)
  if (!p) return period
  const month = endMonthNumber(p)
  const n = grain === 'year' ? 1 : Math.ceil(month / MONTHS_PER[grain])
  return formatPeriod({ year: p.year, grain, n })
}

export function shiftYear(period: string, delta: number): string {
  const p = parsePeriod(period)
  if (!p) return period
  return formatPeriod({ ...p, year: p.year + delta })
}

/** The calendar month containing `now`, as a month period. */
export function currentMonth(now: Date = new Date()): string {
  return formatPeriod({ year: now.getFullYear(), grain: 'month', n: now.getMonth() + 1 })
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
}

/** The scorecard view request for the shell's period state. */
export function viewRequest(state: PeriodState): ViewRequest {
  const req: ViewRequest = { periods: [state.period] }
  if (state.ytd) req.ytd = [endMonth(state.period)]
  if (state.subjects.length > 0) req.subjects = state.subjects
  return req
}
