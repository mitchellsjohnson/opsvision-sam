import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { menuItemHighlight } from '../../ui/focus'

const ITEM = clsx(menuItemHighlight, 'flex h-8 cursor-default items-center justify-between gap-3 rounded-md px-2.5 text-sm')

/** A shortcut hint; the control's `aria-keyshortcuts` carries it for assistive technology. */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="rounded border border-ink/20 bg-white px-1 font-sans text-[11px] leading-4 font-medium text-ink/80"
    >
      {children}
    </kbd>
  )
}

/** The dialog's More actions menu (§8.3): copy link, table, present, exports, then the keyboard shortcuts switch. */
export function MoreMenu({
  onCopyLink,
  onTable,
  onPresent,
  onExport,
  shortcuts,
}: {
  onCopyLink: () => Promise<boolean>
  onTable: () => void
  onPresent: () => void
  onExport: (format: 'png' | 'svg' | 'csv') => void
  shortcuts?: { enabled: boolean; onToggle: (on: boolean) => void }
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="More actions"
        title="More actions"
        className="inline-flex size-8 items-center justify-center rounded-md text-ink/80 hover:bg-ink/5 data-[state=open]:bg-ink/[0.07]"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="More actions"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-[220px] rounded-lg border border-ink/20 bg-white p-1 shadow-lg"
        >
          <DropdownMenu.Item className={ITEM} aria-keyshortcuts="L" onSelect={() => void onCopyLink()}>
            Copy link
            <Kbd>L</Kbd>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} aria-keyshortcuts="T" onSelect={onTable}>
            View as table
            <Kbd>T</Kbd>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} aria-keyshortcuts="P" onSelect={onPresent}>
            Present
            <Kbd>P</Kbd>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-ink/10" />
          <DropdownMenu.Item className={ITEM} onSelect={() => onExport('png')}>
            Export PNG
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={() => onExport('svg')}>
            Export SVG
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={() => onExport('csv')}>
            Export CSV
          </DropdownMenu.Item>
          {shortcuts && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-ink/10" />
              <DropdownMenu.CheckboxItem className={ITEM} checked={shortcuts.enabled} onCheckedChange={shortcuts.onToggle}>
                Keyboard shortcuts: {shortcuts.enabled ? 'On' : 'Off'}
              </DropdownMenu.CheckboxItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
