import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import type { WhyDisplay } from './rcaState'
import { rollupTag, whyName } from './rcaText'
import { useWhyCardAnchor } from './WhyCardProvider'

const TAG = 'shrink-0 rounded px-1.5 text-[11px] font-semibold leading-4'
const NEEDED_TAG = clsx(TAG, 'border border-dashed border-ink/40 text-ink/70')
const REVIEW_TAG = clsx(TAG, 'border border-status-y text-status-y')

export interface WhyButtonProps {
  display: WhyDisplay
  subjectName: string
  valueDisplay: string
  periodLabel: string
  /** Whether the name says the subject; false where the surface already names it. */
  nameSubject: boolean
  /** `rca` reads `RCA:` / `RCA needed` / `RCA · Review`, for places that already show a "why" line. */
  prefix?: 'why' | 'rca'
  /** One word (`Why`, `RCA`, `Review`), for status cells. */
  compact?: boolean
  /** A hint such as `Press Enter for why`, read as the description, never in the name. */
  hint?: string
  className?: string
  onOpen: (el: HTMLElement) => void
}

function Excerpt({ lead, text }: { lead: string; text: string }) {
  return (
    <>
      <span className="shrink-0">{lead}</span>
      <span className="min-w-0 truncate text-ink/80">{text}</span>
    </>
  )
}

function content(display: WhyDisplay, prefix: 'why' | 'rca', compact: boolean): ReactNode {
  const editorStale = display.state === 'stale' && display.canEdit
  if (compact) {
    if (display.state === 'written' || display.state === 'stale') return editorStale ? 'Review' : 'RCA'
    return 'Why'
  }
  if (prefix === 'rca') {
    switch (display.state) {
      case 'available':
        return 'RCA'
      case 'needed':
        return display.canEdit ? <span className={NEEDED_TAG}>RCA needed</span> : 'No RCA yet'
      case 'written':
      case 'stale':
        return editorStale ? (
          <>
            <span className="shrink-0">RCA · </span>
            <span className={REVIEW_TAG}>Review</span>
          </>
        ) : (
          <Excerpt lead="RCA:" text={display.excerpt} />
        )
      case 'rollup':
        return display.showCounts ? `RCAs: ${rollupTag(display.neededBelow, display.staleBelow)}` : 'RCA'
    }
  }
  switch (display.state) {
    case 'available':
      return 'Why?'
    case 'needed':
      return (
        <>
          <span className="shrink-0">Why?</span>
          {display.canEdit && <span className={NEEDED_TAG}>RCA needed</span>}
        </>
      )
    case 'written':
    case 'stale':
      return (
        <>
          <Excerpt lead="Why:" text={display.excerpt} />
          {editorStale && <span className={REVIEW_TAG}>Review</span>}
        </>
      )
    case 'rollup':
      return (
        <>
          <span className="shrink-0">Why?</span>
          {display.showCounts && <span className={NEEDED_TAG}>{rollupTag(display.neededBelow, display.staleBelow)}</span>}
        </>
      )
  }
}

/** The Why? affordance on a cell (spec §10.1): opens the Why card through `onOpen`. */
export function WhyButton({
  display,
  subjectName,
  valueDisplay,
  periodLabel,
  nameSubject,
  prefix = 'why',
  compact = false,
  hint,
  className,
  onOpen,
}: WhyButtonProps) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const openAnchor = useWhyCardAnchor()
  const name = whyName({ display, subjectName: nameSubject ? subjectName : undefined, valueDisplay, periodLabel })
  const excerpt = display.state === 'written' || display.state === 'stale' ? display.excerpt : ''
  const description = [excerpt, hint].filter(Boolean).join(' ')
  return (
    // aria-description (ARIA 1.3) is newer than jsx-a11y's role table.
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <button
      ref={setEl}
      type="button"
      aria-label={name}
      aria-description={description || undefined}
      aria-haspopup="dialog"
      aria-expanded={el !== null && openAnchor === el}
      onClick={(e) => onOpen(e.currentTarget)}
      className={clsx(
        '-mx-1 inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium leading-4 text-accent-deep hover:bg-accent/[0.06]',
        className,
      )}
    >
      {content(display, prefix, compact)}
    </button>
  )
}
