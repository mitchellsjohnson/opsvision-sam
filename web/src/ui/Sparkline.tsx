import { useSyncExternalStore } from 'react'
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from 'recharts'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION).matches
    : false
}

/** True when the person asked the system to reduce motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

export interface SparklinePoint {
  /** Column label, e.g. `Oct`. */
  label: string
  /** Null leaves a gap (no data, or not applicable). */
  value: number | null
}

export interface SparklineProps {
  points: SparklinePoint[]
  /** The goal, drawn as a dashed line; null for none. */
  target: number | null
  /** Plain-text trend summary for assistive technology, e.g. "Trend over 12 months: from 76% to 84%; goal 90%". */
  summary: string
  height?: number
}

/** The y range: the values and the goal, with some air around them. */
function domain(points: SparklinePoint[], target: number | null): [number, number] {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (target !== null) values.push(target)
  if (values.length === 0) return [0, 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  return [min - pad, max + pad]
}

/**
 * A small trend line with an optional dashed goal line. The graphic is hidden
 * from assistive technology; the visually hidden summary carries its meaning.
 * Animation is off when the person prefers reduced motion.
 */
export function Sparkline({ points, target, summary, height = 56 }: SparklineProps) {
  const reduced = usePrefersReducedMotion()
  return (
    <div>
      <div
        data-testid="sparkline-graphic"
        data-animated={String(!reduced)}
        aria-hidden="true"
        className="text-accent-deep"
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 200, height }}>
          <LineChart
            data={points}
            margin={{ top: 4, right: 6, bottom: 4, left: 6 }}
            accessibilityLayer={false}
          >
            <YAxis hide domain={domain(points, target)} />
            {target !== null && (
              <ReferenceLine y={target} stroke="var(--color-ink)" strokeDasharray="4 3" strokeWidth={1} />
            )}
            <Line
              type="linear"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2}
              dot={{ r: 2, fill: 'currentColor', stroke: 'currentColor' }}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={!reduced}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <span className="sr-only">{summary}</span>
    </div>
  )
}
