import type { components } from '../../../api/schema'
import { contrastRatio, letterUsesInkOnWhite } from '../../../ui/contrast'

type StatusLevel = components['schemas']['StatusLevel']

const SHAPES: Record<string, string> = { G: '●', Y: '▲', R: '◆' }
const WHITE = '#FFFFFF'
const INK = '#1D2433'

/** One color per series, in order; the first is accent-deep. Shared with the slide export. */
export const LINE_COLORS: readonly string[] = ['#3F33A8', '#0E7490', '#475569', '#A21CAF', '#1D4ED8']

/** White or ink, whichever reads better on `fill`; white on a non-hex fill (the ink fallback). */
function letterOn(fill: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return WHITE
  return contrastRatio(WHITE, fill) >= contrastRatio(INK, fill) ? WHITE : 'var(--color-ink)'
}

export interface StatusTheme {
  letter: string
  shape: string
  color: string
  /** The scale's name for the status, e.g. `Yellow`; '' when unknown. */
  label: string
  /** Ink when tenant color fails contrast on white. */
  letterClass: string
  /** The letter's color on a shape filled with `color`: white or ink, whichever has more contrast. */
  onColor: string
}

const DEFAULT_SCALE: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]

/** Status key → letter, shape, color, and contrast-safe letter styling. */
export function chartTheme(scale: StatusLevel[] | undefined, status: string): StatusTheme {
  const entries = scale?.length ? scale : DEFAULT_SCALE
  const entry = entries.find((s) => s.key === status)
  const letter = status || '—'
  const shape = SHAPES[status] ?? '●'
  const color = entry?.color ?? 'var(--color-ink)'
  const ink = letterUsesInkOnWhite(color)
  return {
    letter,
    shape,
    color,
    label: entry?.label ?? '',
    letterClass: ink ? 'text-ink' : '',
    onColor: letterOn(color),
  }
}

export function defaultStatusScale(): StatusLevel[] {
  return DEFAULT_SCALE
}

export type MoveTone = 'good' | 'bad' | 'neutral'

export interface Move {
  /** `▲` for a rise, `▼` for a fall, '' for none. */
  arrow: '▲' | '▼' | ''
  tone: MoveTone
}

/** Text color per tone; the arrow and the words carry the meaning too. */
export const MOVE_CLASS: Record<MoveTone, string> = {
  good: 'text-status-g',
  bad: 'text-status-r',
  neutral: 'text-ink/70',
}

/** Which way a value moved (`delta`, already rounded) and whether that is good for the metric's direction. */
export function valueMove(delta: number, direction: string): Move {
  if (delta === 0) return { arrow: '', tone: 'neutral' }
  const up = delta > 0
  const better = direction === 'lower_better' ? !up : direction === 'higher_better' ? up : null
  return { arrow: up ? '▲' : '▼', tone: better === null ? 'neutral' : better ? 'good' : 'bad' }
}
