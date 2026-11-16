import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { EllipsisVertical } from 'lucide-react'
import { menuItemHighlight } from '../../ui/focus'

const BUTTON = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm'

/** The secondary 32px button of the layout controls. */
export const LAYOUT_BUTTON = clsx(BUTTON, 'border-ink/20 bg-white hover:bg-cream disabled:opacity-60')

const MENU_ITEM = clsx(menuItemHighlight, 'flex h-8 cursor-default items-center rounded px-2.5 text-sm')

/**
 * The sticky bar of Customize layout mode, under the control bar: what the
 * mode does, then Reset layout, Save as default (admins), Hidden (n) and Done.
 * On phones it is one row: the title, a menu with the other actions, and Done.
 * It sits above a tile being dragged (z-30).
 */
export function CustomizeBar({
  isAdmin,
  hidden,
  onReset,
  onSaveDefault,
  onRestoreHidden,
  onDone,
}: {
  isAdmin: boolean
  hidden: number
  onReset: () => void
  onSaveDefault: () => void
  onRestoreHidden: () => void
  onDone: () => void
}) {
  return (
    <div
      role="region"
      aria-label="Customize layout"
      className="sticky top-[var(--control-bar-h,0px)] z-40 mb-4 flex items-center gap-x-3 gap-y-2 rounded-lg border border-accent bg-white p-2 shadow-sm sm:flex-wrap sm:p-3"
    >
      <div className="min-w-0 flex-1 sm:basis-64">
        <p className="truncate text-sm font-semibold">Customizing layout</p>
        <p className="text-xs text-ink/70 max-sm:hidden">
          Drag a tile by its handle, or use its menu. Keyboard: Space to pick up, arrow keys to move, Space to drop, Esc to
          cancel.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
        <button type="button" className={clsx(LAYOUT_BUTTON, 'max-sm:hidden')} onClick={onReset}>
          Reset layout
        </button>
        {isAdmin && (
          <button type="button" className={clsx(LAYOUT_BUTTON, 'max-sm:hidden')} onClick={onSaveDefault}>
            Save as default
          </button>
        )}
        {hidden > 0 && (
          <button type="button" className={clsx(LAYOUT_BUTTON, 'max-sm:hidden')} onClick={onRestoreHidden}>
            Hidden ({hidden})
          </button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label="More layout actions"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-ink/20 bg-white text-ink/80 hover:bg-cream hover:text-ink data-[state=open]:bg-cream sm:hidden"
          >
            <EllipsisVertical aria-hidden size={16} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-ink/20 bg-white p-1 shadow-lg"
            >
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs text-ink/70">
                Use each tile’s menu to move, resize or hide it.
              </DropdownMenu.Label>
              <DropdownMenu.Item className={MENU_ITEM} onSelect={onReset}>
                Reset layout
              </DropdownMenu.Item>
              {isAdmin && (
                <DropdownMenu.Item className={MENU_ITEM} onSelect={onSaveDefault}>
                  Save as default
                </DropdownMenu.Item>
              )}
              {hidden > 0 && (
                <DropdownMenu.Item className={MENU_ITEM} onSelect={onRestoreHidden}>
                  Hidden ({hidden})
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className={clsx(BUTTON, 'border-accent-deep bg-accent-deep font-medium text-white hover:bg-accent')}
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  )
}
