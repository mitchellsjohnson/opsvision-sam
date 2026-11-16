import type { components } from '../../../api/schema'
import { monthsOf, parsePeriod, type Grain } from '../../../lib/period'
import type { Column } from '../columns'
import { formatMetricValue } from '../format'
import { countNoun, type NounForms } from './nouns'
import { streakAt, type BoardCell } from './statusBoard'

type Band = components['schemas']['Band']
type Direction = components['schemas']['Direction']
type Frequency = components['schemas']['Frequency']
type StatusRule = components['schemas']['StatusRule']

const UNITS: Record<Grain, [string, string]> = {
  month: ['month', 'months'],
  quarter: ['quarter', 'quarters'],
  half: ['half', 'halves'],
  year: ['year', 'years'],
}

/** The column's grain as a noun for `n` of them: `month`, `quarters`, `halves`. */
export function columnUnit(column: Column | undefined, n: number): string {
  const grain = parsePeriod(column?.period)?.grain ?? 'month'
  return UNITS[grain][n === 1 ? 0 : 1]
}

export interface ThresholdOptions {
  format: string
  direction: Direction
  chartKind: string
  frequency: Frequency
  statusLabel: (key: string) => string | undefined
  /** Items or units with their own best-band value. */
  perSubject?: { name: string; value: number }[]
  /** For `1 service has its own target`; `item` when absent. */
  noun?: NounForms
  surface: 'tile' | 'focus'
}

/** A run of values sharing one status, from `lo` to `hi` (infinite at the open ends). */
interface Interval {
  status: string
  lo: number
  hi: number
  loIn: boolean
  hiIn: boolean
}

function evalBands(bands: Band[], v: number): string {
  for (const b of bands) {
    if (b.op === '') return b.status
    if (b.op === '>=' && v >= b.value) return b.status
    if (b.op === '>' && v > b.value) return b.status
    if (b.op === '<=' && v <= b.value) return b.status
    if (b.op === '<' && v < b.value) return b.status
  }
  return ''
}

function ruleBands(rule: StatusRule): Band[] {
  if (rule.type === 'scale') {
    return [...(rule.scale ?? [])].sort((a, b) => b.min - a.min).map((s) => ({ status: s.status, op: '>=', value: s.min }))
  }
  return rule.bands ?? []
}

/** The bands as runs along the number line, lowest first; values no band matches are left out. */
function intervals(bands: Band[]): Interval[] {
  const cuts = [...new Set(bands.filter((b) => b.op !== '').map((b) => b.value))].sort((a, b) => a - b)
  if (cuts.length === 0) return []
  const pieces: Interval[] = []
  const add = (lo: number, hi: number, loIn: boolean, hiIn: boolean, probe: number) =>
    pieces.push({ status: evalBands(bands, probe), lo, hi, loIn, hiIn })
  add(-Infinity, cuts[0]!, false, false, cuts[0]! - 1)
  cuts.forEach((cut, i) => {
    add(cut, cut, true, true, cut)
    const next = cuts[i + 1]
    if (next === undefined) add(cut, Infinity, false, false, cut + 1)
    else add(cut, next, false, false, (cut + next) / 2)
  })
  const merged: Interval[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last && last.status === piece.status) Object.assign(last, { hi: piece.hi, hiIn: piece.hiIn })
    else merged.push({ ...piece })
  }
  return merged.filter((m) => m.status !== '')
}

function decimalsOf(v: number): number {
  for (let d = 0; d < 2; d++) {
    const scaled = v * 10 ** d
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d
  }
  return 2
}

/** A threshold in the metric's format, with the decimals it needs when it is finer than the format shows. */
function thresholdValue(format: string, v: number): string {
  const m = /^(percent|number)(\d)$/.exec(format)
  const need = decimalsOf(v)
  if (m && need > Number(m[2])) return formatMetricValue(`${m[1]}${need}`, v)
  return formatMetricValue(format, v)
}

const COARSE: Partial<Record<Frequency, string>> = {
  quarterly: 'Reported quarterly',
  biannual: 'Reported twice a year',
  annual: 'Reported yearly',
}

const FREQUENCY_UNIT: Record<Frequency, string> = { monthly: 'month', quarterly: 'quarter', biannual: 'half', annual: 'year' }

function directionPhrase(direction: Direction, chartKind: string): string {
  if (direction !== 'lower_better') return 'Higher is better'
  if (chartKind === 'days') return 'Fewer days is better'
  if (chartKind === 'money_plan') return 'Under plan is fine'
  return 'Lower is better'
}

function pct(n: number): string {
  return `${Number(Math.abs(n).toFixed(1))}%`
}

/** One run of a change rule's improvement bands: `any improvement`, `up to 5% worse`, `more than 5% worse`. */
function changeRange({ lo, hi, loIn, hiIn }: Interval): string {
  if (hi === Infinity) {
    if (lo === 0) return 'any improvement'
    if (lo > 0) return loIn ? `${pct(lo)} better or more` : `more than ${pct(lo)} better`
    return loIn ? `no more than ${pct(lo)} worse` : `less than ${pct(lo)} worse`
  }
  if (lo === -Infinity) {
    if (hi === 0) return hiIn ? 'no change or worse' : 'any decline'
    if (hi < 0) return hiIn ? `${pct(hi)} worse or more` : `more than ${pct(hi)} worse`
    return hiIn ? `up to ${pct(hi)} better or worse` : `less than ${pct(hi)} better or worse`
  }
  if (hi <= 0) return hi === 0 ? `up to ${pct(lo)} worse` : `${pct(hi)} to ${pct(lo)} worse`
  if (lo >= 0) return lo === 0 ? `up to ${pct(hi)} better` : `${pct(lo)} to ${pct(hi)} better`
  return `between ${pct(lo)} worse and ${pct(hi)} better`
}

function compareText(rule: StatusRule, frequency: Frequency): string {
  if (rule.compare === 'prior_year_average') return "the prior year's average"
  if (rule.compare === 'baseline') return 'the baseline'
  return `the prior ${FREQUENCY_UNIT[frequency]}`
}

/** The clauses that say where each status starts, in the order the copy reads. */
function bandClauses(runs: Interval[], opts: ThresholdOptions): string[] {
  if (runs.length < 2) return []
  const label = (s: string) => opts.statusLabel(s) ?? s
  const value = (v: number) => thresholdValue(opts.format, v)
  const lowest = runs[0]!
  const highest = runs[runs.length - 1]!
  // Item metrics are counted by the best status, so their line names only where it starts.
  const bestOnly = opts.chartKind === 'uptime'
  if (opts.direction !== 'lower_better') {
    const best = `${label(highest.status)} ${highest.loIn ? `at ${value(highest.lo)} or better` : `above ${value(highest.lo)}`}`
    if (bestOnly) return [best]
    return [best, `${label(lowest.status)} ${lowest.hiIn ? `at ${value(lowest.hi)} or below` : `below ${value(lowest.hi)}`}`]
  }
  if (opts.chartKind === 'days') {
    const best = `${label(lowest.status)} ${lowest.hiIn ? `at ${value(lowest.hi)} or fewer` : `below ${value(lowest.hi)}`}`
    if (bestOnly) return [best]
    return [best, `${label(highest.status)} ${highest.loIn ? `at ${value(highest.lo)} or more` : `above ${value(highest.lo)}`}`]
  }
  if (bestOnly) return [`${label(lowest.status)} ${lowest.hiIn ? `at ${value(lowest.hi)} or below` : `below ${value(lowest.hi)}`}`]
  return runs.slice(1).map((r) => `${label(r.status)} ${r.loIn ? `at ${value(r.lo)} or above` : `above ${value(r.lo)}`}`)
}

/**
 * The one-line threshold and direction copy under a metric's title:
 * `Green at 90% or better · Red below 80%`, `Lower is better · Yellow above
 * 450 · Red above 600`, prefixed `Reported quarterly ·` for coarse metrics.
 */
export function thresholdText(rule: StatusRule, opts: ThresholdOptions): string {
  const parts: string[] = []
  const coarse = COARSE[opts.frequency]
  if (coarse) parts.push(coarse)
  const runs = intervals(ruleBands(rule))
  if (rule.type === 'change') {
    parts.push(directionPhrase(opts.direction, opts.chartKind), `judged on change vs ${compareText(rule, opts.frequency)}`)
    if (opts.surface === 'focus') {
      parts.push(...[...runs].reverse().map((r) => `${opts.statusLabel(r.status) ?? r.status}: ${changeRange(r)}`))
    }
  } else {
    if (opts.direction === 'lower_better') parts.push(directionPhrase(opts.direction, opts.chartKind))
    parts.push(...bandClauses(runs, opts))
  }
  const own = opts.perSubject ?? []
  if (own.length > 0 && opts.surface === 'tile') {
    const noun = opts.noun ?? { one: 'item', many: 'items' }
    parts.push(`${countNoun(own.length, noun)} ${own.length === 1 ? 'has its own target' : 'have their own targets'}`)
  }
  const text = parts.join(' · ')
  if (own.length === 0 || opts.surface === 'tile') return text
  return text + own.map((s) => `; ${s.name} is held to ${thresholdValue(opts.format, s.value)}`).join('')
}

/**
 * How long the status at `index` has held: `Red since Sep 2026 · 2 months`,
 * counted in months whatever the grain; `Red all 12 months shown` when the
 * streak reaches the first column. Empty when the cell has no status.
 */
export function sinceText(
  cells: BoardCell[],
  index: number,
  columns: Column[],
  statusLabel: (key: string) => string | undefined,
): string {
  const streak = streakAt(cells, index)
  const cell = cells[index]
  if (streak === 0 || !cell) return ''
  const label = statusLabel(cell.status) ?? cell.status
  const start = index - streak + 1
  if (start === 0) {
    return streak === 1
      ? `${label} in the only ${columnUnit(columns[0], 1)} shown`
      : `${label} all ${streak} ${columnUnit(columns[0], streak)} shown`
  }
  const months = columns.slice(start, index + 1).reduce((n, c) => {
    const p = parsePeriod(c.period)
    return n + (p && !c.ytd ? monthsOf(p).length : 1)
  }, 0)
  return `${label} since ${columns[start]?.fullLabel ?? ''} · ${months} ${months === 1 ? 'month' : 'months'}`
}
