import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { chartTheme, statusFill } from '../../features/scorecard/charts/chartTheme'
import type { BoardCell } from '../../features/scorecard/logic/statusBoard'
import type { StatusLevel } from './StatusChip'
import type { GridCellProps } from './useGridNavigation'

/** Diagonal hairlines: not applicable, quieter than any status and unlike the no-data dot. */
export const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-ink) 18%, transparent) 0 1px, transparent 1px 5px)',
}

export const UNRATED_CLASS = 'border-transparent bg-ink/[0.06]'

export function NoDataDot() {
  return <span data-dot="" aria-hidden="true" className="size-1 rounded-full bg-ink/35" />
}

const HEIGHT = { md: 'h-6', sm: 'h-[18px]', xs: 'h-3.5' } as const

export interface StatusCellProps {
  cell: BoardCell
  /** The accessible name, e.g. from `cellName`. */
  name: string
  scale: StatusLevel[]
  /** `md` is the 24px board button; `sm` 18px and `xs` 14px are for decorative use. */
  size?: 'md' | 'sm' | 'xs'
  /** A `span` hidden from assistive technology, with no handlers: the enclosing control names the status. */
  decorative?: boolean
  /** `shape` draws the status's shape instead of its letter, for cells too narrow for the letter. */
  glyph?: 'letter' | 'shape'
  tip?: ReactNode
  grid?: GridCellProps
  onOpen?: (el: HTMLElement) => void
}

/** One period's status: the tier fill and letter, a hatch for n/a, a dot for no data. */
export function StatusCell({ cell, name, scale, size = 'md', decorative = false, glyph = 'letter', tip, grid, onOpen }: StatusCellProps) {
  const fill = cell.kind === 'status' ? statusFill(scale, cell.status) : null
  const className = clsx(
    'flex w-full items-center justify-center rounded-[3px] border border-transparent text-[11px] font-semibold leading-none',
    HEIGHT[size],
    cell.kind === 'na' && 'border-ink/15 bg-white',
    cell.kind === 'unrated' && UNRATED_CLASS,
  )
  const style = fill
    ? { backgroundColor: fill.background, color: fill.letter, borderColor: fill.border ?? 'transparent' }
    : cell.kind === 'na'
      ? HATCH
      : undefined
  const content = (
    <>
      {fill && chartTheme(scale, cell.status)[glyph === 'shape' ? 'shape' : 'letter']}
      {cell.kind === 'missing' && <NoDataDot />}
    </>
  )

  if (decorative) {
    return (
      <span aria-hidden="true" data-kind={cell.kind} data-tier={fill?.tier} className={className} style={style}>
        {content}
      </span>
    )
  }

  const button = (
    <button
      type="button"
      {...grid}
      data-kind={cell.kind}
      data-tier={fill?.tier}
      aria-label={name}
      className={clsx(
        className,
        'transition-shadow hover:ring-2 hover:ring-ink/40',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink focus-visible:inset-ring-1 focus-visible:inset-ring-white',
      )}
      style={style}
      // The grid opens on Space keydown; stop the button's own keyup click from opening it twice.
      onKeyUp={grid ? (e) => e.key === ' ' && e.preventDefault() : undefined}
      onClick={onOpen ? (e) => onOpen(e.currentTarget) : undefined}
    >
      {content}
    </button>
  )

  if (!tip) return button
  return (
    <Tooltip.Root delayDuration={150}>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className="z-50">
          {tip}
          <Tooltip.Arrow width={10} height={5} className="fill-ink" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
