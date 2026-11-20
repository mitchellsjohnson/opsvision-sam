import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { useRef, useState } from 'react'
import { splitItemName } from '../../features/scorecard/logic/itemName'

/**
 * An item name on one line that keeps the part siblings differ in (§2.3):
 * the head shortens first, to as little as 4 characters; only then is the
 * tail, separator included, cut, at its start. The full name is always the
 * text, and pointer hover on a cut name shows it with the group. The gap
 * before the tail is drawn at the end of the head (`[data-name-head]::after`
 * in `index.css`), so a cut head's ellipsis takes it and no double gap shows;
 * the tail's own leading space stays in the text but is not drawn.
 */
export function ItemName({ name, group, className }: { name: string; group?: string; className?: string }) {
  const { head, tail } = splitItemName(name)
  const headRef = useRef<HTMLSpanElement>(null)
  const tailRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const cut = () => [headRef.current, tailRef.current].some((el) => el !== null && el.scrollWidth > el.clientWidth)
  const lead = head ? (/^\s*/.exec(tail)?.[0] ?? '') : ''
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root open={open} onOpenChange={(next) => setOpen(next && cut())}>
        <Tooltip.Trigger asChild>
          <span data-name="" className={clsx('flex min-w-0 max-w-full', className)}>
            {head && (
              <span ref={headRef} data-name-head={lead ? '' : undefined} className="min-w-0 shrink truncate">
                {head}
              </span>
            )}
            {head ? (
              // Right to left, so a tail too long even for its space loses its start, never the ending siblings differ in.
              <span
                ref={tailRef}
                className="max-w-[calc(100%-4ch)] shrink-0 overflow-hidden text-ellipsis whitespace-pre [direction:rtl]"
              >
                <bdi dir="ltr">
                  {lead && (
                    <span data-gap="" className="hidden">
                      {lead}
                    </span>
                  )}
                  {tail.slice(lead.length)}
                </bdi>
              </span>
            ) : (
              <span ref={tailRef} className="min-w-0 truncate">
                {tail}
              </span>
            )}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-80 rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-lg"
          >
            {name}
            {group && <span className="text-white/75"> · {group}</span>}
            <Tooltip.Arrow width={10} height={5} className="fill-ink" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
