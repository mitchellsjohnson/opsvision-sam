import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Where turning shortcuts off is remembered on this device; the server preferences have no field for it. */
export const SHORTCUTS_KEY = 'opsvision.shortcuts'

/** Keys typed here belong to the control: text entry, arrow-key widgets, the range strip and chart points. */
const IGNORE = [
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role=grid]',
  '[role=menu]',
  '[role=menuitem]',
  '[role=radiogroup]',
  '[role=listbox]',
  '[data-range-strip]',
  '[data-point-button]',
].join(',')

export interface DialogShortcutHandlers {
  prev: () => void
  next: () => void
  range?: (n: 1 | 2 | 3 | 4 | 5) => void
  table: () => void
  copyLink: () => void
  present: () => void
  /** `J` and `K`: the next and previous item, in a drill-in only. */
  nextItem?: () => void
  prevItem?: () => void
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== 'off'
  } catch {
    // Storage can be blocked; shortcuts stay on.
    return true
  }
}

/**
 * Single-key shortcuts inside a dialog: arrows for previous and next, `1`–`5`
 * for ranges, `T` table, `L` copy link, `P` present, `J`/`K` next and
 * previous item. Never with Cmd, Ctrl or
 * Alt (so the browser's own shortcuts keep working), never on auto-repeat,
 * never inside the controls in `IGNORE`, and switchable off (WCAG 2.1.4).
 */
export function useDialogShortcuts(
  ref: RefObject<HTMLElement | null>,
  handlers: DialogShortcutHandlers,
  options?: { rangeKeys?: 3 | 5 },
): { enabled: boolean; setEnabled: (on: boolean) => void } {
  const [enabled, setEnabledState] = useState(readEnabled)
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const rangeKeys = options?.rangeKeys ?? 5

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on)
    try {
      if (on) localStorage.removeItem(SHORTCUTS_KEY)
      else localStorage.setItem(SHORTCUTS_KEY, 'off')
    } catch {
      // The choice still applies for this visit.
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    // On the document, so handlers inside the dialog (React's included) have had their turn and `defaultPrevented` is final.
    const onKeyDown = (e: KeyboardEvent) => {
      // A held key repeats; one press is one move.
      if (e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const root = ref.current
      const target = e.target
      if (!root || !(target instanceof Element) || !root.contains(target)) return
      if (target.closest(IGNORE)) return
      const h = latest.current
      let action: (() => void) | undefined
      if (e.key === 'ArrowLeft') action = h.prev
      else if (e.key === 'ArrowRight') action = h.next
      else if (/^[1-5]$/.test(e.key)) {
        const n = Number(e.key) as 1 | 2 | 3 | 4 | 5
        if (h.range && n <= rangeKeys) action = () => h.range!(n)
      } else {
        const key = e.key.toLowerCase()
        if (key === 't') action = h.table
        else if (key === 'l') action = h.copyLink
        else if (key === 'p') action = h.present
        else if (key === 'j') action = h.nextItem
        else if (key === 'k') action = h.prevItem
      }
      if (!action) return
      e.preventDefault()
      action()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, ref, rangeKeys])

  return { enabled, setEnabled }
}
