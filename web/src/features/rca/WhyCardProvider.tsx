import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MetricSummary, RcaCellRef } from '../../api/queries'
import { WhyCard } from './WhyCard'

export interface WhyCardOpenOptions {
  /** The card's title; the subject's name by default. Append ` · {metric}` where the surface does not name the metric. */
  title?: string
  /** Show the value row, as from the Exec summaries view or the Report; phones always show it. */
  showValue?: boolean
  /** The cell's displayed value, for the error sentence when the card cannot load. */
  display?: string
  /** After the metric's exec summary is saved (the stored summary) or deleted (null) from this card. */
  onChange?: (summary: MetricSummary | null) => void
}

export interface WhyCardApi {
  /** Opens the card for one cell, anchored to `anchor`; focus returns there on close. Replaces any open card. */
  open(ref: RcaCellRef, anchor: HTMLElement, opts?: WhyCardOpenOptions): void
  close(): void
}

interface Session {
  id: number
  ref: RcaCellRef
  anchor: HTMLElement
  opts: WhyCardOpenOptions
}

const NOOP: WhyCardApi = { open: () => {}, close: () => {} }
const ApiContext = createContext<WhyCardApi>(NOOP)
const AnchorContext = createContext<HTMLElement | null>(null)
const AnnounceContext = createContext<(message: string) => void>(() => {})

/** Opens the scorecard's one Why card. Outside a `WhyCardProvider` it does nothing. */
export function useWhyCard(): WhyCardApi {
  return useContext(ApiContext)
}

/** The element the open card is anchored to, or null: for `aria-expanded` on triggers. */
export function useWhyCardAnchor(): HTMLElement | null {
  return useContext(AnchorContext)
}

/** Announces a short status (`Exec summary saved`) in the card's polite live region. */
export function useWhyCardAnnounce(): (message: string) => void {
  return useContext(AnnounceContext)
}

/**
 * Hosts the scorecard's Why card, one at a time: a popover anchored to the
 * trigger from 640px up, a bottom sheet below. Mounted once in the scorecard
 * frame, so every view and the full-screen dialog share it.
 */
export function WhyCardProvider({ scorecardId, children }: { scorecardId: string; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [live, setLive] = useState('')
  const nextId = useRef(0)

  const open = useCallback((ref: RcaCellRef, anchor: HTMLElement, opts: WhyCardOpenOptions = {}) => {
    nextId.current += 1
    setLive('')
    setSession({ id: nextId.current, ref, anchor, opts })
  }, [])
  const close = useCallback(() => setSession(null), [])
  const api = useMemo(() => ({ open, close }), [open, close])
  const announce = useCallback((message: string) => setLive(message), [])

  return (
    <ApiContext.Provider value={api}>
      <AnchorContext.Provider value={session?.anchor ?? null}>
        <AnnounceContext.Provider value={announce}>
          {children}
          {session && (
            <WhyCard
              key={session.id}
              scorecardId={scorecardId}
              cell={session.ref}
              anchor={session.anchor}
              opts={session.opts}
              onClosed={close}
            />
          )}
          <p role="status" data-testid="why-live" className="sr-only">
            {live}
          </p>
        </AnnounceContext.Provider>
      </AnchorContext.Provider>
    </ApiContext.Provider>
  )
}
