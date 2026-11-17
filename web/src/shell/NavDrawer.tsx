import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

/**
 * The navigation on phones: a left drawer over the page. It opens on its first
 * link, closes on Esc, the close button or a link, and always hands focus back
 * to `returnFocus` (the menu button, which lives outside the dialog).
 */
export function NavDrawer({
  open,
  onOpenChange,
  returnFocus,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('a[href]')
            if (first) {
              e.preventDefault()
              first.focus()
            }
          }}
          onCloseAutoFocus={(e) => {
            if (returnFocus.current?.isConnected) {
              e.preventDefault()
              returnFocus.current.focus()
            }
          }}
          onClick={(e) => {
            if ((e.target as Element).closest('a[href]')) onOpenChange(false)
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(320px,85vw)] flex-col overflow-y-auto bg-cream shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-ink/15 px-3 py-2">
            <Dialog.Title className="text-base font-semibold text-accent-deep">Navigation</Dialog.Title>
            <Dialog.Close
              aria-label="Close navigation"
              className="flex size-8 items-center justify-center rounded-md text-ink hover:bg-white"
            >
              <X aria-hidden="true" className="size-4 shrink-0" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
