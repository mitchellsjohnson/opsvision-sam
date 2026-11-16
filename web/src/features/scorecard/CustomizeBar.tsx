import clsx from 'clsx'

const BUTTON = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm'

/** The secondary 32px button of the layout controls. */
export const LAYOUT_BUTTON = clsx(BUTTON, 'border-ink/20 bg-white hover:bg-cream disabled:opacity-60')

/**
 * The sticky bar of Customize layout mode, under the control bar: what the
 * mode does, then Reset layout, Save as default (admins), Hidden (n) and Done.
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
      className="sticky top-[var(--control-bar-h,0px)] z-20 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent bg-white p-3 shadow-sm"
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-semibold">Customizing layout</p>
        <p className="text-xs text-ink/70 max-sm:hidden">
          Drag a tile by its handle, or use its menu. Keyboard: Space to pick up, arrow keys to move, Space to drop, Esc to
          cancel.
        </p>
        <p className="text-xs text-ink/70 sm:hidden">Use each tile’s menu to move, resize or hide it.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={LAYOUT_BUTTON} onClick={onReset}>
          Reset layout
        </button>
        {isAdmin && (
          <button type="button" className={LAYOUT_BUTTON} onClick={onSaveDefault}>
            Save as default
          </button>
        )}
        {hidden > 0 && (
          <button type="button" className={LAYOUT_BUTTON} onClick={onRestoreHidden}>
            Hidden ({hidden})
          </button>
        )}
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
