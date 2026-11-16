import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AssistantContext } from '../../api/queries'
import { Sam } from '../../ui/Sam'
import { AskSamContext, useWideScreen, type AskSam } from './useAssistant'

const DrawerBody = lazy(() => import('./AskSamDrawerBody'))

interface DrawerState {
  isOpen: boolean
  context: AssistantContext
  threadId: string | null
  /** Bumped each time the person picks a chat. */
  chat: number
}

/** Hosts Ask SAM for the app: `useAskSam().open(context)` opens the drawer. */
export function AskSamProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DrawerState>({ isOpen: false, context: { page: 'other' }, threadId: null, chat: 0 })
  const returnFocus = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const wide = useWideScreen()
  // Over the full-screen chart dialog, SAM is modal too so it gets focus and scrolling.
  const modal = !wide || state.context.page === 'focus'

  const open = useCallback((context: AssistantContext) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setState((s) => ({ ...s, isOpen: true, context }))
  }, [])
  const close = useCallback(() => setState((s) => ({ ...s, isOpen: false })), [])
  const selectThread = useCallback(
    (threadId: string | null) => setState((s) => ({ ...s, threadId, chat: s.chat + 1 })),
    [],
  )
  // A chat started by a question becomes current, even if the drawer closed meanwhile,
  // unless the person has picked another chat since.
  const adoptThread = useCallback(
    (chat: number, threadId: string) => setState((s) => (s.chat === chat ? { ...s, threadId } : s)),
    [],
  )

  const value = useMemo<AskSam>(
    () => ({ open, isOpen: state.isOpen, docked: state.isOpen && !modal }),
    [open, state.isOpen, modal],
  )

  return (
    <AskSamContext.Provider value={value}>
      {children}
      <Dialog.Root open={state.isOpen} modal={modal} onOpenChange={(next) => !next && close()}>
        <Dialog.Portal>
          {modal && <Dialog.Overlay className="fixed inset-0 z-[60] bg-ink/40" />}
          <Dialog.Content
            ref={contentRef}
            data-ask-sam=""
            aria-describedby={undefined}
            aria-modal={modal || undefined}
            tabIndex={-1}
            onOpenAutoFocus={(e) => {
              // The composer takes focus once it renders (it waits for the key status).
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).focus()
            }}
            onCloseAutoFocus={(e) => {
              if (returnFocus.current?.isConnected) {
                e.preventDefault()
                returnFocus.current.focus()
              }
            }}
            // Beside the page, the page stays usable: working in it does not close SAM.
            onInteractOutside={(e) => {
              if (!modal) e.preventDefault()
            }}
            onEscapeKeyDown={(e) => {
              if (!modal && !contentRef.current?.contains(document.activeElement)) e.preventDefault()
            }}
            className={clsx(
              'fixed flex flex-col bg-cream text-ink outline-none',
              !wide
                ? 'inset-0 z-[70]'
                : clsx(
                    'inset-y-0 right-0 w-[26rem] max-w-full border-l border-ink/15 shadow-xl',
                    modal ? 'z-[70]' : 'z-30',
                  ),
            )}
          >
            <Suspense fallback={<DrawerLoading />}>
              <DrawerBody
                context={state.context}
                threadId={state.threadId}
                chat={state.chat}
                selectThread={selectThread}
                adoptThread={adoptThread}
                closeIfModal={modal ? close : undefined}
              />
            </Suspense>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AskSamContext.Provider>
  )
}

/** The drawer's frame while its content loads. */
function DrawerLoading() {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-ink/10 bg-white px-4 py-3">
        <Sam pose="mark" className="size-10 shrink-0" />
        <Dialog.Title className="min-w-0 flex-1 text-lg font-semibold leading-tight text-accent-deep">Ask SAM</Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" className="rounded-md p-1.5 text-ink hover:bg-cream">
            <X aria-hidden="true" className="size-5" />
          </button>
        </Dialog.Close>
      </div>
      <p role="status" className="px-4 py-4 text-sm text-ink/80">
        Loading…
      </p>
    </>
  )
}
