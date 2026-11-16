import clsx from 'clsx'
import type { CSSProperties } from 'react'
import type { components } from '../../api/schema'
import { chartTheme, statusFill } from '../../features/scorecard/charts/chartTheme'

export type StatusLevel = components['schemas']['StatusLevel']

const CHIP_BASE = 'inline-flex shrink-0 items-center justify-center gap-px rounded-[3px] border font-semibold leading-none'

/** Chip boxes: `md` is 28×16 with an 11px letter, `lg` 36×20 with a 12px letter. */
export const CHIP_SIZE = {
  md: clsx(CHIP_BASE, 'h-4 w-7 text-[11px]'),
  lg: clsx(CHIP_BASE, 'h-5 w-9 text-xs'),
} as const

/** The tier fill of a status as inline style: background, letter color and border. */
export function fillStyle(scale: StatusLevel[], status: string): CSSProperties {
  const fill = statusFill(scale, status)
  return { backgroundColor: fill.background, color: fill.letter, borderColor: fill.border ?? 'transparent' }
}

/** A status chip with its shape and letter, filled as the cells are: for the legend and value columns. */
export function StatusChip({ status, scale, size = 'md' }: { status: string; scale: StatusLevel[]; size?: 'md' | 'lg' }) {
  const theme = chartTheme(scale, status)
  return (
    <span className={CHIP_SIZE[size]} style={fillStyle(scale, status)}>
      <span aria-hidden="true">{theme.shape}</span>
      {theme.letter}
    </span>
  )
}
