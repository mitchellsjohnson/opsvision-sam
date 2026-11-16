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

/** `soft`: the best status, a tint. `outline`: a middle status, a tint with a border. `solid`: the worst status, a full fill. */
export type FillTier = 'soft' | 'outline' | 'solid'

export interface StatusFill {
  tier: FillTier
  /** A CSS color: a token, a `color-mix()` tint, or the status color. */
  background: string
  letter: string
  /** The border color on an outlined tint; null otherwise. */
  border: string | null
}

/** The default statuses' tints, from the design tokens. */
export const TOKEN_TINTS: Record<string, { css: string; hex: string }> = {
  '#137A3A': { css: 'var(--color-status-g-bg)', hex: '#E3F6EA' },
  '#8A5A00': { css: 'var(--color-status-y-bg)', hex: '#FFF3D6' },
}
const TINT_PERCENT = 14

/** `hex` mixed with white, `share` of the way to `hex`: what `color-mix(in srgb, hex 14%, white)` paints. */
function mixWithWhite(hex: string, share: number): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
    return Math.round(c * share + 255 * (1 - share))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

/**
 * How a status cell is filled so exceptions stand out: the best status is a
 * soft tint, a middle one a tint with a border, the worst a solid fill. A tint
 * whose letter would fall under 4.5:1 is filled solid instead.
 */
export function statusFill(scale: StatusLevel[] | undefined, status: string): StatusFill {
  const entries = scale?.length ? scale : DEFAULT_SCALE
  const theme = chartTheme(scale, status)
  const solid: StatusFill = { tier: 'solid', background: theme.color, letter: theme.onColor, border: null }
  const entry = entries.find((s) => s.key === status)
  const ranks = entries.map((s) => s.rank)
  if (!entry || !/^#[0-9a-f]{6}$/i.test(entry.color) || entry.rank >= Math.max(...ranks)) return solid
  const token = TOKEN_TINTS[entry.color.toUpperCase()]
  const tint = token?.hex ?? mixWithWhite(entry.color, TINT_PERCENT / 100)
  if (contrastRatio(entry.color, tint) < 4.5) return solid
  const soft = entry.rank <= Math.min(...ranks)
  return {
    tier: soft ? 'soft' : 'outline',
    background: token?.css ?? `color-mix(in srgb, ${entry.color} ${TINT_PERCENT}%, white)`,
    letter: entry.color,
    border: soft ? null : entry.color,
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
