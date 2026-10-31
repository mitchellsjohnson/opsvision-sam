import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface FootnoteProps {
  /** Symbol that ties the note to its reference in the table, e.g. "*" or "1". */
  marker?: string
  id?: string
  className?: string
  children: ReactNode
}

/** A small note under a table or chart. */
export function Footnote({ marker, id, className, children }: FootnoteProps) {
  return (
    <p id={id} className={clsx('text-xs leading-5 text-ink/80', className)}>
      {marker && (
        <sup aria-hidden="true" className="mr-1 font-semibold">
          {marker}
        </sup>
      )}
      {children}
    </p>
  )
}
