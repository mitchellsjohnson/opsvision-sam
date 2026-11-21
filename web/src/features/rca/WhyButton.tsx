import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import type { SummaryDisplay } from './rcaState'
import { whyName } from './rcaText'
import { useWhyCardAnchor } from './WhyCardProvider'

const TAG = 'shrink-0 rounded px-1.5 text-[11px] font-semibold leading-4'
const NEEDED_TAG = clsx(TAG, 'border border-status-r text-status-r')
const NOT_YET_TAG = clsx(TAG, 'border border-dashed border-ink/40 text-ink/70')
const REVIEW_TAG = clsx(TAG, 'border border-status-y text-status-y')

export interface WhyButtonProps {
  /** The exec summary state, on company-standing surfaces only (`summaryDisplay`); omit elsewhere. */
  summary?: SummaryDisplay
  /** Whether the cell has attribution (`attributionAvailable`). */
  attribution: boolean
  /** The subject, or on company-standing surfaces the metric. */
  subjectName: string
  valueDisplay: string
  periodLabel: string
  /** Whether the name says the subject; false where the surface already names it. */
  nameSubject: boolean
  /** `summary` reads `Summary:` / the missing tag alone, for attention cards. */
  prefix?: 'why' | 'summary'
  /** One word (`Why`, `Summary`, `Needed`, `Review`), for status cells. */
  compact?: boolean
  /** A hint such as `Press Enter for why`, read as the description, never in the name. */
  hint?: string
  className?: string
  onOpen: (el: HTMLElement) => void
}

function Tag({ summary }: { summary: Extract<SummaryDisplay, { state: 'missing' }> }) {
  return summary.canEdit ? (
    <span data-tag="" className={NEEDED_TAG}>
      {summary.neededFor ? `Needed for ${summary.neededFor}` : 'Exec summary needed'}
    </span>
  ) : (
    <span data-tag="" className={NOT_YET_TAG}>
      No exec summary yet
    </span>
  )
}

function content(summary: SummaryDisplay | undefined, prefix: 'why' | 'summary', compact: boolean): ReactNode {
  if (compact) {
    if (!summary) return 'Why'
    if (summary.state === 'missing') return summary.neededFor ? 'Why' : 'Needed'
    return summary.state === 'stale' && summary.canEdit ? 'Review' : 'Summary'
  }
  if (!summary) return 'Why?'
  if (summary.state === 'missing') {
    return prefix === 'summary' ? (
      <Tag summary={summary} />
    ) : (
      <>
        <span className="shrink-0">Why?</span>
        <Tag summary={summary} />
      </>
    )
  }
  return (
    <>
      <span className="shrink-0">{prefix === 'summary' ? 'Summary:' : 'Why:'}</span>
      <span className="min-w-0 truncate text-ink/80">{summary.excerpt}</span>
      {summary.state === 'stale' && summary.canEdit && (
        <span data-tag="" className={REVIEW_TAG}>
          Review
        </span>
      )}
    </>
  )
}

/**
 * The Why? affordance on a cell (spec §10.1): opens the Why card through
 * `onOpen`. On company-standing surfaces it carries the exec summary state;
 * elsewhere it reads `Why?` when the cell has attribution. Draws nothing
 * when there is neither.
 */
export function WhyButton({
  summary,
  attribution,
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
  if (!summary && !attribution) return null
  const name = whyName({ summary, subjectName: nameSubject ? subjectName : undefined, valueDisplay, periodLabel })
  const excerpt = summary && summary.state !== 'missing' ? summary.excerpt : ''
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
      {content(summary, prefix, compact)}
    </button>
  )
}
