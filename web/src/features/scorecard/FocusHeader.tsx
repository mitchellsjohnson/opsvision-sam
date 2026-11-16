import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Sam } from '../../ui/Sam'

const ICON_BUTTON = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink/80 hover:bg-ink/5'

/**
 * The dialog's header row (§8.2): eyebrow and title on the left; previous and
 * next with the position, Ask SAM, More and Close on the right. Phones get two
 * rows: title and Close, then the metric nav, Ask SAM and More. One DOM in
 * both, so tab order and names do not change with the width.
 */
export function FocusHeader({
  eyebrow,
  title,
  position,
  prev,
  next,
  onAskSam,
  samOpen,
  menu,
}: {
  eyebrow: string
  title: string
  position: { index: number; total: number }
  prev: { name: string; onGo: () => void }
  next: { name: string; onGo: () => void }
  onAskSam: () => void
  samOpen: boolean
  menu: ReactNode
}) {
  const navigable = position.total > 1 && position.index > 0
  return (
    <div className="flex flex-wrap items-start gap-x-3">
      <div className="order-1 min-w-0 flex-1">
        {eyebrow && <p className="text-[11px] leading-4 font-semibold tracking-[0.04em] text-ink/70 uppercase">{eyebrow}</p>}
        <Dialog.Title className="text-xl font-semibold text-accent-deep">{title}</Dialog.Title>
      </div>
      <div className="order-3 mt-2 flex w-full items-center gap-1 sm:order-2 sm:mt-0 sm:w-auto">
        {navigable && (
          <nav aria-label="Metrics" className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`Previous metric: ${prev.name}`}
              aria-keyshortcuts="ArrowLeft"
              title="Previous metric (←)"
              className={ICON_BUTTON}
              onClick={prev.onGo}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </button>
            <span className="min-w-12 text-center text-xs text-ink/70 tabular-nums">
              {position.index} of {position.total}
            </span>
            <button
              type="button"
              aria-label={`Next metric: ${next.name}`}
              aria-keyshortcuts="ArrowRight"
              title="Next metric (→)"
              className={ICON_BUTTON}
              onClick={next.onGo}
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </nav>
        )}
        {navigable && <span aria-hidden="true" className="mx-2 hidden h-6 w-px bg-ink/15 sm:block" />}
        <span className="flex-1 sm:hidden" />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={samOpen}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent/40 bg-white px-2.5 text-sm font-medium text-accent-deep hover:bg-cream"
          onClick={onAskSam}
        >
          <Sam className="size-5" />
          Ask SAM
        </button>
        {menu}
      </div>
      <Dialog.Close asChild>
        <button type="button" aria-label="Close" title="Close (Esc)" className={`order-2 sm:order-3 ${ICON_BUTTON}`}>
          <X aria-hidden="true" className="size-4" />
        </button>
      </Dialog.Close>
    </div>
  )
}
