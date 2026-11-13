import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

interface ShellDockValue {
  open: boolean
  setOpen: (open: boolean) => void
  /** The dock element, once mounted; drawers portal into it. */
  dockElement: HTMLDivElement | null
  /** Callback ref for the dock element. */
  dockRef: (el: HTMLDivElement | null) => void
}

const ShellDockContext = createContext<ShellDockValue | null>(null)

export function ShellDockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [dockElement, setDockElement] = useState<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ open, setOpen, dockElement, dockRef: setDockElement }), [open, dockElement])
  return <ShellDockContext.Provider value={value}>{children}</ShellDockContext.Provider>
}

const noopDock: ShellDockValue = {
  open: false,
  setOpen: () => {},
  dockElement: null,
  dockRef: () => {},
}

export function useShellDock(): ShellDockValue {
  const ctx = useContext(ShellDockContext)
  return ctx ?? noopDock
}
