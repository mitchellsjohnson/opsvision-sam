import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'

interface ShellDockValue {
  open: boolean
  setOpen: (open: boolean) => void
  dockRef: RefObject<HTMLDivElement | null>
}

const ShellDockContext = createContext<ShellDockValue | null>(null)

export function ShellDockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const value = useMemo(() => ({ open, setOpen, dockRef }), [open])
  return <ShellDockContext.Provider value={value}>{children}</ShellDockContext.Provider>
}

const noopDock: ShellDockValue = {
  open: false,
  setOpen: () => {},
  dockRef: { current: null },
}

export function useShellDock(): ShellDockValue {
  const ctx = useContext(ShellDockContext)
  return ctx ?? noopDock
}
