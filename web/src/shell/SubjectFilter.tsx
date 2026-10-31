import * as Popover from '@radix-ui/react-popover'
import { ChevronDown } from 'lucide-react'
import { usePeriodState } from './usePeriodState'

export interface SubjectOption {
  id: string
  name: string
}

/** Multi-select of subjects (org units); the selection lives in `?subject=` params. */
export function SubjectFilter({ subjects }: { subjects: SubjectOption[] | undefined }) {
  const [{ subjects: selected }, update] = usePeriodState()
  const summary =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? (subjects?.find((s) => s.id === selected[0])?.name ?? '1 selected')
        : `${selected.length} selected`

  function toggle(id: string, on: boolean) {
    update({ subjects: on ? [...selected, id] : selected.filter((s) => s !== id) })
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={!subjects || subjects.length === 0}
        className="flex items-center gap-2 rounded-md border border-ink/30 bg-white px-3 py-1.5 text-sm disabled:opacity-60"
      >
        Subjects: {summary}
        <ChevronDown aria-hidden="true" size={16} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Filter by subject"
          align="start"
          sideOffset={4}
          className="z-50 max-h-80 min-w-56 overflow-auto rounded-md border border-ink/20 bg-white p-3 shadow-lg"
        >
          <ul className="space-y-1">
            {(subjects ?? []).map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={selected.includes(s.id)}
                    onChange={(e) => toggle(s.id, e.target.checked)}
                  />
                  {s.name}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-3 text-sm font-medium text-accent-deep underline disabled:opacity-50"
            disabled={selected.length === 0}
            onClick={() => update({ subjects: [] })}
          >
            Clear selection
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
