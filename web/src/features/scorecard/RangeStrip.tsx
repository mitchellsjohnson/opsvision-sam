import type { KeyboardEvent } from 'react'
import { MOVE_CLASS } from './charts/chartTheme'
import { RANGES, type RangeChange, type RangeKey } from './charts/ranges'

/** Range tabs under the chart, each with the change over its range, and a caption saying what that change compares. */
export function RangeStrip({
  selected,
  onSelect,
  changeFor,
  noDataFor,
  caption,
  hidden = false,
}: {
  selected: RangeKey
  onSelect: (key: RangeKey) => void
  changeFor: (key: RangeKey) => RangeChange | null
  /** A range whose first column has no value: it reads `No data then` and cannot be picked (§4). */
  noDataFor?: (key: RangeKey) => boolean
  caption: string
  hidden?: boolean
}) {
  if (hidden) return null
  // Arrow keys, Home and End move between the ranges that can be picked.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: 0 }
    const group = e.currentTarget.parentElement
    if (!(e.key in keys) || !group) return
    const stops = [...group.querySelectorAll<HTMLButtonElement>('button:not([aria-disabled="true"])')]
    if (stops.length === 0) return
    e.preventDefault()
    const at = stops.indexOf(e.currentTarget)
    const to =
      e.key === 'Home' ? 0 : e.key === 'End' ? stops.length - 1 : (Math.max(at, 0) + keys[e.key]! + stops.length) % stops.length
    stops[to]!.focus()
  }
  return (
    <div data-range-strip="" className="mt-3">
      {/* Three a row on phones, so `8.8% worse` keeps to one line (§7). */}
      <div role="group" aria-label="Range" className="grid grid-cols-3 gap-1 sm:grid-cols-5">
        {RANGES.map(({ key, label }) => {
          const noData = noDataFor?.(key) ?? false
          const change = noData ? null : changeFor(key)
          const pressed = selected === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={pressed}
              aria-disabled={noData || undefined}
              tabIndex={noData ? -1 : undefined}
              aria-label={
                noData
                  ? `${label}, no data then`
                  : !change
                    ? `${label}, change not available`
                    : change.move.arrow
                      ? `${label}, change ${change.text}`
                      : `${label}, no change`
              }
              className={`rounded-md px-1 py-1.5 text-center text-sm ${noData ? 'cursor-default text-ink/70' : pressed ? 'bg-ink/[0.07] font-semibold shadow-[inset_0_-2px_0_var(--color-accent)]' : 'hover:bg-ink/5'}`}
              onClick={() => !noData && onSelect(key)}
              onKeyDown={onKeyDown}
            >
              <span className="block">{label}</span>
              {noData ? (
                <span data-no-data="" className="block text-[11px] leading-4 text-ink/70">
                  No data then
                </span>
              ) : change ? (
                <span
                  data-tone={change.move.tone}
                  className={`block text-[11px] leading-4 font-medium whitespace-nowrap tabular-nums sm:text-xs ${MOVE_CLASS[change.move.tone]}`}
                >
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
