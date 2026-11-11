import type { components } from '../../../api/schema'
import { letterUsesInkOnWhite } from '../../../ui/contrast'

type StatusLevel = components['schemas']['StatusLevel']

const SHAPES: Record<string, string> = { G: '●', Y: '▲', R: '◆' }

export interface StatusTheme {
  letter: string
  shape: string
  color: string
  /** Ink when tenant color fails contrast on white. */
  letterClass: string
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
    letterClass: ink ? 'text-ink' : '',
  }
}

export function defaultStatusScale(): StatusLevel[] {
  return DEFAULT_SCALE
}
