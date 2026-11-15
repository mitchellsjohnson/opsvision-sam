import type { components } from '../../../api/schema'
import { letterUsesInkOnWhite } from '../../../ui/contrast'

type StatusLevel = components['schemas']['StatusLevel']

const SHAPES: Record<string, string> = { G: '●', Y: '▲', R: '◆' }

/** One color per series, in order; the first is accent-deep. Shared with the slide export. */
export const LINE_COLORS = ['#3F33A8', '#0E7490', '#475569', '#A21CAF', '#1D4ED8']

export interface StatusTheme {
  letter: string
  shape: string
  color: string
  /** The scale's name for the status, e.g. `Yellow`; '' when unknown. */
  label: string
  /** Ink when tenant color fails contrast on white. */
  letterClass: string
  /** The letter's color on a shape filled with `color`: white, or ink when white fails contrast. */
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
    onColor: ink ? 'var(--color-ink)' : '#FFFFFF',
  }
}

export function defaultStatusScale(): StatusLevel[] {
  return DEFAULT_SCALE
}
