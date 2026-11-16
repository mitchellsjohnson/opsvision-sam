import clsx from 'clsx'
import { useId, useState, type CSSProperties } from 'react'
import { CHIP_SIZE, HATCH, StatusChip, type StatusLevel } from '../../ui/status'
import { statusFill } from './charts/chartTheme'

/** The key Not reported is counted, filtered (`?health=none`) and selected under. */
export const NOT_REPORTED = 'none'

const NOT_REPORTED_LABEL = 'Not reported'

export interface HealthSummaryProps {
  /** `Health this month` / `this quarter` / `this half` / `this year`. */
  title: string
  /** The selected period's label, e.g. `Oct 2026`. */
  period: string
  /** Every metric, each counted once. */
  total: number
  /** Metrics by status key, and `NOT_REPORTED`. */
  counts: Map<string, number>
  /** The same counts for the prior period; null when there is none. */
  prior: Map<string, number> | null
  /** The prior column's short label: `Sep`, `Q2`, `H1`, `FY2025`. */
  priorLabel: string
  /** The pressed toggle's key; '' for none. */
  selected: string
  /** `''` clears the filter. */
  onSelect: (key: string) => void
  scale: StatusLevel[]
}

interface Level {
  key: string
  label: string
  count: number
  delta: number | null
  /** Which way is good for this level: more of the best, fewer of the worst. */
  better: 'up' | 'down' | null
}

const metricsOf = (n: number) => `${n} ${n === 1 ? 'metric' : 'metrics'}`

function deltaTone(level: Level): 'good' | 'bad' | 'neutral' {
  if (!level.delta || !level.better) return 'neutral'
  return (level.delta > 0) === (level.better === 'up') ? 'good' : 'bad'
}

const TONE_CLASS = { good: 'text-status-g', bad: 'text-status-r', neutral: 'text-ink/70' } as const

/** A segment's look: the worst status solid, a middle one a tint with its border, the best a tint with a faint border. */
function segmentStyle(scale: StatusLevel[], key: string): CSSProperties {
  if (key === NOT_REPORTED) return { ...HATCH, backgroundColor: 'white', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 15%, transparent)' }
  const fill = statusFill(scale, key)
  const color = scale.find((s) => s.key === key)?.color ?? 'var(--color-ink)'
  if (fill.tier === 'solid') return { backgroundColor: fill.background }
  const edge = fill.tier === 'outline' ? (fill.border ?? color) : `color-mix(in srgb, ${color} 25%, transparent)`
  return { backgroundColor: fill.background, boxShadow: `inset 0 0 0 1px ${edge}` }
}

/**
 * How the period went (§4.2): a proportion bar over every metric, what
 * changed since the prior period, and one toggle per status (in the tenant's
 * labels, worst first) plus Not reported. A toggle filters the tiles, keeps
 * focus and says how many metrics are now shown.
 */
export function HealthSummary({ title, period, total, counts, prior, priorLabel, selected, onSelect, scale }: HealthSummaryProps) {
  const headingId = useId()
  const [message, setMessage] = useState('')
  const byRank = [...scale].sort((a, b) => b.rank - a.rank)
  const worst = byRank[0]
  const best = byRank[byRank.length - 1]
  const levels: Level[] = [
    ...byRank.map((s) => ({
      key: s.key,
      label: s.label || s.key,
      better: s.key === best?.key ? ('up' as const) : s.key === worst?.key ? ('down' as const) : null,
    })),
    { key: NOT_REPORTED, label: NOT_REPORTED_LABEL, better: null },
  ].map((l) => {
    const count = counts.get(l.key) ?? 0
    return { ...l, count, delta: prior ? count - (prior.get(l.key) ?? 0) : null }
  })

  const shown = levels.filter((l) => l.count > 0)
  const barLabel = `${shown.map((l) => `${l.count} ${l.label}`).join(', ')} of ${metricsOf(total)}`
  const changes = levels.filter((l) => l.key !== NOT_REPORTED && l.delta)
  const worstGrew = changes.some((l) => l.key === worst?.key && (l.delta ?? 0) > 0)

  const spoken = (l: Level) => {
    if (l.delta === null) return ''
    if (l.delta === 0) return `, no change since ${priorLabel}`
    return `, ${l.delta > 0 ? 'up' : 'down'} ${Math.abs(l.delta)} since ${priorLabel}`
  }
  const press = (l: Level) => {
    if (selected === l.key) {
      onSelect('')
      setMessage('Showing all metrics')
      return
    }
    onSelect(l.key)
    const label = l.key === NOT_REPORTED ? NOT_REPORTED_LABEL.toLowerCase() : l.label
    setMessage(`Showing ${l.count} ${label} ${l.count === 1 ? 'metric' : 'metrics'}`)
  }

  return (
    <section aria-labelledby={headingId} className="@container rounded-lg border border-ink/20 bg-white p-4">
      <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 id={headingId} className="text-base font-semibold text-accent-deep">
              {title}
            </h2>
            <span className="text-xs text-ink/70">
              {metricsOf(total)} · {period}
            </span>
          </div>
          <div role="img" aria-label={barLabel} className="mt-2 flex h-3 gap-0.5 overflow-hidden rounded-md">
            {shown.map((l) => (
              <span key={l.key} data-status={l.key} className="block h-full min-w-1" style={{ ...segmentStyle(scale, l.key), flexGrow: l.count }} />
            ))}
          </div>
        </div>
        {prior && (
          <p data-testid="health-since" className="text-xs text-ink/70 sm:text-right">
            Since {priorLabel}:{' '}
            {changes.length === 0
              ? 'no change'
              : changes.map((l, i) => {
                  const text = `${Math.abs(l.delta!)} ${l.delta! > 0 ? 'more' : 'fewer'} ${l.label}`
                  return (
                    <span key={l.key}>
                      {i > 0 && ', '}
                      {l.key === worst?.key && worstGrew ? <span className="font-semibold text-status-r">{text}</span> : text}
                    </span>
                  )
                })}
          </p>
        )}
      </div>
      {/* By the card's own width: one column when narrow (the nav rail leaves phones little room), 2×2, then a row. */}
      <div role="group" aria-label="Show metrics by status" className="mt-3 grid grid-cols-1 gap-2 @2xs:grid-cols-2 @lg:flex @lg:flex-wrap">
        {levels.map((l) => {
          const pressed = selected === l.key
          const tone = deltaTone(l)
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={pressed}
              aria-label={`${l.label}: ${metricsOf(l.count)}${spoken(l)}`}
              onClick={() => press(l)}
              className={clsx(
                'grid min-h-9 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 rounded-lg border bg-white py-1 pl-2 pr-3 text-left',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep',
                pressed ? 'border-accent bg-accent/[0.08] ring-1 ring-inset ring-accent' : 'border-ink/20 hover:bg-cream',
              )}
            >
              <span className="row-span-2 self-center">
                {l.key === NOT_REPORTED ? (
                  <span className={clsx(CHIP_SIZE.md, 'border-ink/15 bg-white')} style={HATCH} />
                ) : (
                  <StatusChip status={l.key} scale={scale} />
                )}
              </span>
              <span className="text-base font-semibold leading-5 tabular-nums">{l.count}</span>
              <span className="min-w-0 text-xs break-words">{l.label}</span>
              {l.delta !== null && (
                <span className={clsx('col-span-2 text-[11px] leading-[14px]', TONE_CLASS[tone])}>
                  {l.delta === 0 ? 'no change' : `${l.delta > 0 ? '+' : '−'}${Math.abs(l.delta)} vs ${priorLabel}`}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p data-testid="health-live" role="status" className="sr-only">
        {message}
      </p>
    </section>
  )
}
