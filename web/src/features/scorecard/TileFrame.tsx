import clsx from 'clsx'
import { Maximize2 } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import type { components } from '../../api/schema'
import { SCROLL_MARGIN } from './SectionHeader'

type ViewRow = components['schemas']['ViewRow']

export interface TileFrameProps {
  head: ViewRow
  /** The 12px threshold and direction line under the title (`thresholdText`). */
  threshold: string
  /** The value row: value, status chip and change; in `window`, the line saying what is missing. */
  value: ReactNode
  /** 12px extras at the end of the value row: since when, YTD, components. */
  extras?: ReactNode
  /** An optional 12px sentence under the value row (coarse, stopped, sparse, company total). */
  context?: string
  /** An optional link row after a rule. */
  footer?: ReactNode
  /** Opens the metric full screen; `trigger` gets focus back on close. */
  onExpand: (trigger: HTMLElement) => void
  /** `stopped`: the value is history. `window`: nothing in the window, so no plot and no Expand. */
  state: 'normal' | 'stopped' | 'window'
  /** The kind's chart region. */
  children: ReactNode
}

/**
 * Every Overview metric tile: an `article` titled by its `h3`, the threshold
 * line, an Expand icon button, the value row, an optional context sentence,
 * the chart and an optional footer. A click on the card outside its controls
 * expands it too (pointer only; Expand is the keyboard path and gets focus back).
 */
export function TileFrame({ head, threshold, value, extras, context, footer, onExpand, state, children }: TileFrameProps) {
  const expandRef = useRef<HTMLButtonElement>(null)
  const empty = state === 'window'

  return (
    // A pointer shortcut only: the Expand button is the keyboard and screen reader path.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <article
      aria-label={head.metricName}
      style={{ scrollMarginTop: SCROLL_MARGIN }}
      className={clsx(
        'flex h-full min-w-0 flex-col gap-2 rounded-lg border border-ink/20 bg-white p-4',
        !empty && 'cursor-pointer hover:border-accent',
      )}
      onClick={(e) => {
        if (empty || !expandRef.current) return
        if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return
        onExpand(expandRef.current)
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold break-words">
            {head.metricName}
          </h3>
          {threshold && <p className="text-xs text-ink/70">{threshold}</p>}
        </div>
        {!empty && (
          <button
            ref={expandRef}
            type="button"
            aria-label={`Expand ${head.metricName}`}
            className="-mr-2 -mt-2 flex size-8 shrink-0 items-center justify-center rounded-md text-ink/80 hover:bg-ink/[0.06] hover:text-ink"
            onClick={(e) => onExpand(e.currentTarget)}
          >
            <Maximize2 aria-hidden="true" size={16} />
          </button>
        )}
      </div>
      {empty ? (
        <div>
          <p className="text-sm font-medium">{value}</p>
          {context && <p className="text-xs text-ink/70">{context}</p>}
        </div>
      ) : (
        <>
          <div
            data-tile-value=""
            className={clsx('flex flex-wrap items-baseline gap-x-2 gap-y-1', state === 'stopped' && 'text-ink/70')}
          >
            {value}
            {extras && <span className="text-xs text-ink/70">{extras}</span>}
          </div>
          {context && <p className="text-xs text-ink/70">{context}</p>}
          <div className="min-w-0">{children}</div>
        </>
      )}
      {footer && (
        <div data-tile-footer="" className={clsx('text-xs', !empty && 'mt-auto border-t border-ink/10 pt-2')}>
          {footer}
        </div>
      )}
    </article>
  )
}
