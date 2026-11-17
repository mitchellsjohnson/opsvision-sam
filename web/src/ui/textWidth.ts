import { useEffect, useState } from 'react'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

let context: Context2D | null | undefined

function measuringContext(): Context2D | null {
  if (context !== undefined) return context
  try {
    context =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : typeof document !== 'undefined'
          ? document.createElement('canvas').getContext('2d')
          : null
  } catch {
    context = null
  }
  return context
}

/**
 * The rendered width of `text` in `font` (a CSS font shorthand, e.g.
 * `500 14px system-ui`), in whole px. Without a canvas (tests), an estimate
 * from the font size: 0.56em a character.
 */
export function textWidth(text: string, font: string): number {
  const ctx = measuringContext()
  if (ctx) {
    ctx.font = font
    return Math.ceil(ctx.measureText(text).width)
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14)
  return Math.ceil(text.length * size * 0.56)
}

let family: string | undefined

/** The font shorthand for UI text at `weight` and `px`, in the page's own font family. */
export function uiFont(weight: number, px: number): string {
  if (family === undefined) {
    family = (typeof document !== 'undefined' && document.body && getComputedStyle(document.body).fontFamily) || 'system-ui, sans-serif'
  }
  return `${weight} ${px}px ${family}`
}

/**
 * False until the page's web fonts have loaded, then true, so widths
 * measured with a fallback font are measured again. True at once without
 * `document.fonts`, or when they already have.
 */
export function useFontsReady(): boolean {
  const fonts = typeof document !== 'undefined' ? (document as { fonts?: FontFaceSet }).fonts : undefined
  const [ready, setReady] = useState(() => !fonts || fonts.status === 'loaded')
  useEffect(() => {
    if (ready || !fonts) return
    let live = true
    void fonts.ready.then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [ready, fonts])
  return ready
}
