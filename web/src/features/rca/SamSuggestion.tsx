import clsx from 'clsx'
import { primaryButton } from '../admin/formUi'

export interface SamSuggestionProps {
  text: string
  /** What the draft was written from: `from 3 services' attribution and 4 incidents`. */
  sources: string
  /** Keys SAM named that were not in the data it was given. */
  warnings: string[]
  onUse: () => void
  onDiscard: () => void
}

/** SAM's draft, shown inside the editor only, above the text box (spec §10.4); nothing changes until `Use this draft`. */
export function SamSuggestion({ text, sources, warnings, onUse, onDiscard }: SamSuggestionProps) {
  return (
    <section aria-label="Suggested by SAM" className="mt-2 rounded-md border border-accent/30 bg-accent/[0.05] p-2">
      <p className="text-[11px] leading-4">
        <span className="font-semibold uppercase tracking-wide text-accent-deep">Suggested by SAM</span>
        <span aria-hidden="true" className="text-ink/70">
          {' · '}
        </span>
        <span className="text-ink/70">{sources}</span>
      </p>
      <p dir="auto" className="mt-1 break-words text-sm leading-5">
        {text}
      </p>
      {warnings.map((k) => (
        <p key={k} className="mt-1 text-xs leading-4 text-status-y">
          SAM mentioned {k}, which is not linked to this metric. Check it before using this draft.
        </p>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={clsx(primaryButton, 'h-7 py-0 text-xs')} onClick={onUse}>
          Use this draft
        </button>
        <button
          type="button"
          className="h-7 rounded-md px-2.5 text-xs font-medium text-ink hover:bg-white"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </section>
  )
}
