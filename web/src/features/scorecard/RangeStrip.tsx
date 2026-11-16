import { MOVE_CLASS } from './charts/chartTheme'
import { RANGES, type RangeChange, type RangeKey } from './charts/ranges'

/** Range tabs under the chart, each with the change over its range, and a caption saying what that change compares. */
export function RangeStrip({
  selected,
  onSelect,
  changeFor,
  caption,
  hidden = false,
}: {
  selected: RangeKey
  onSelect: (key: RangeKey) => void
  changeFor: (key: RangeKey) => RangeChange | null
  caption: string
  hidden?: boolean
}) {
  if (hidden) return null
  return (
    <div data-range-strip="" className="mt-3">
      <div role="group" aria-label="Range" className="grid grid-cols-5 gap-1">
        {RANGES.map(({ key, label }) => {
          const change = changeFor(key)
          const pressed = selected === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={pressed}
              aria-label={!change ? `${label}, change not available` : change.move.arrow ? `${label}, change ${change.text}` : `${label}, no change`}
              className={`rounded-md px-1 py-1.5 text-center text-sm ${pressed ? 'bg-ink/[0.07] font-semibold shadow-[inset_0_-2px_0_var(--color-accent)]' : 'hover:bg-ink/5'}`}
              onClick={() => onSelect(key)}
            >
              <span className="block">{label}</span>
              {change ? (
                <span data-tone={change.move.tone} className={`block text-[11px] leading-4 font-medium tabular-nums sm:text-xs ${MOVE_CLASS[change.move.tone]}`}>
                  {change.move.arrow && <span className="mr-0.5">{change.move.arrow}</span>}
                  {change.text}
                </span>
              ) : (
                <span className="block text-[11px] leading-4 font-medium text-ink/70 sm:text-xs">—</span>
              )}
            </button>
          )
        })}
      </div>
      {caption && <p className="mt-1 text-center text-[11px] leading-4 text-ink/70">{caption}</p>}
    </div>
  )
}
