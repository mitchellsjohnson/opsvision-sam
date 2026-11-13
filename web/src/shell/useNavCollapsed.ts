import { useCallback, useState } from 'react'

/** Where the collapsed choice is remembered between visits. */
export const NAV_COLLAPSED_KEY = 'opsvision.nav.collapsed'

/** Below this width the nav starts collapsed until the person chooses. */
const NARROW_QUERY = '(max-width: 1439px)'

function read(): boolean {
  try {
    const stored = localStorage.getItem(NAV_COLLAPSED_KEY)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    // Storage can be blocked; fall through to the screen-size default.
  }
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches
}

/**
 * Whether the side navigation is collapsed to an icon rail, and a toggle that
 * remembers the choice. With no saved choice it opens collapsed on narrow
 * screens and expanded otherwise.
 */
export function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(read)
  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, String(next))
      } catch {
        // The choice still applies for this visit.
      }
      return next
    })
  }, [])
  return [collapsed, toggle]
}
