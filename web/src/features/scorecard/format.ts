import type { components } from '../../api/schema'
import { calendarMonth, lastMonth, parsePeriod, prev } from '../../lib/period'
import { shortLabel } from './columns'

const DECIMALS: Record<string, number> = {
  percent0: 0,
  percent1: 1,
  percent2: 2,
  number0: 0,
  number1: 1,
  number2: 2,
  money_k: 0,
  days0: 0,
}

/** The decimal places a metric format shows. */
export function metricDecimals(format: string): number {
  return DECIMALS[format] ?? 2
}

function fixed(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** A metric value the way the API displays it (mirrors the API's format codes). */
export function formatMetricValue(format: string, value: number): string {
  const decimals = metricDecimals(format)
  const text = fixed(value, decimals)
  if (format.startsWith('percent')) return `${text}%`
  if (format === 'money_k') return `$${text}k`
  if (format === 'days0') return `${text} ${Math.abs(value) === 1 ? 'day' : 'days'}`
  return text
}

/** `yyyy-mm-dd` (UTC) for an ISO timestamp. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Nov 14` for the calendar date `2026-11-14`, with the year when it is not `year`: `Dec 30, 2025`. */
export function shortDate(date: string, year?: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const name = MONTHS[(m ?? 0) - 1]
  if (!name || !d) return date
  return year === undefined || y === year ? `${name} ${d}` : `${name} ${d}, ${y}`
}

/** The last calendar day (`yyyy-mm-dd`) of a fiscal period, or null for an invalid period. */
export function periodEndDate(period: string, fyStart: number): string | null {
  const parsed = parsePeriod(period)
  if (!parsed) return null
  const { year, month } = calendarMonth(lastMonth(parsed), fyStart)
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** `yyyy-mm-dd hh:mm UTC` for an ISO timestamp. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export interface ChangeInput {
  /** The cell's period (for a YTD cell, the month it runs through). */
  period: string
  ytd: boolean
  format: string
  change: number | null
  changeKind: string
  /** The change rule's comparison, when the metric has one. */
  compare?: string
  fyStart: number
}

function trimmed(n: number): string {
  return String(Math.round(n * 10) / 10)
}

/**
 * The change as a phrase, e.g. `+2.1 pts vs Sep` or `17% worse vs Sep`.
 * An `improvement_pct` change already counts a move in the metric's good
 * direction as positive, so its sign alone says better or worse.
 */
export function changeText(c: ChangeInput): string | null {
  if (c.change === null || c.changeKind === '') return null
  const parsed = parsePeriod(c.period)
  let against = 'prior period'
  if (c.ytd) against = 'YTD last year'
  else if (parsed) against = shortLabel(prev(parsed), c.fyStart)
  if (c.changeKind === 'improvement_pct') {
    if (c.compare === 'prior_year_average') against = "last year's average"
    else if (c.compare === 'baseline') against = 'baseline'
  }

  if (c.changeKind === 'improvement_pct') {
    const rounded = Math.round(Math.abs(c.change) * 10) / 10
    if (rounded === 0) return `No change vs ${against}`
    return `${trimmed(Math.abs(c.change))}% ${c.change < 0 ? 'worse' : 'better'} vs ${against}`
  }
  if (c.changeKind === 'delta') {
    const decimals = DECIMALS[c.format] ?? 2
    const rounded = Number(Math.abs(c.change).toFixed(decimals))
    if (rounded === 0) return `No change vs ${against}`
    const sign = c.change < 0 ? '-' : '+'
    const n = fixed(Math.abs(c.change), decimals)
    let amount = n
    if (c.format.startsWith('percent')) amount = `${n} pts`
    else if (c.format === 'days0') amount = `${n} ${rounded === 1 ? 'day' : 'days'}`
    else if (c.format === 'money_k') amount = `$${n}k`
    return `${sign}${amount} vs ${against}`
  }
  return null
}

/** The change phrase with a reminder of which way is good when lower is better: `17% worse vs Sep · lower is better`. */
export function withDirection(text: string, direction: string): string {
  return direction === 'lower_better' ? `${text} · lower is better` : text
}

/** `Overridden by <by> on <yyyy-mm-dd>: <reason>`; the reason is optional. */
export function overrideSentence(o: components['schemas']['Override']): string {
  return `Overridden by ${o.by} on ${formatDate(o.at)}${o.reason ? `: ${o.reason}` : ''}`
}
