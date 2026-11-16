import { useLayoutEffect, useState } from 'react'

/** A callback ref and the element's rendered width in pixels (0 until measured), measured before paint and kept current by a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(element)
    return () => ro.disconnect()
  }, [element])
  return [setElement, width]
}
