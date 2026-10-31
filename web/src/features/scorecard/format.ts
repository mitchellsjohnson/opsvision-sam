import type { components } from '../../api/schema'
import { parsePeriod, prev } from '../../lib/period'
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

function fixed(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** A metric value the way the API displays it (mirrors the API's format codes). */
export function formatMetricValue(format: string, value: number): string {
  const decimals = DECIMALS[format] ?? 2
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
