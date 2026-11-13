import { useEffect, useState } from 'react'

/** A callback ref and the element's rendered height in pixels (0 until measured), kept current by a ResizeObserver. */
export function useElementHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!element) return
    const measure = () => setHeight(element.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(element)
    return () => ro.disconnect()
  }, [element])
  return [setElement, height]
}
