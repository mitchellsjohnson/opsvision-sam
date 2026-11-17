import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { textWidth, useFontsReady } from './textWidth'

describe('textWidth', () => {
  it('without a canvas, estimates from the font size', () => {
    expect(textWidth('abcd', '500 14px Inter')).toBe(Math.ceil(4 * 14 * 0.56))
    expect(textWidth('abcd', '500 14px Inter')).toBe(32)
    expect(textWidth('Last Sep 100.00%', '400 12px system-ui')).toBe(Math.ceil(16 * 12 * 0.56))
    expect(textWidth('', '600 14px Inter')).toBe(0)
  })
})

describe('useFontsReady', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts')
  afterEach(() => {
    if (original) Object.defineProperty(document, 'fonts', original)
    else delete (document as { fonts?: unknown }).fonts
  })

  it('is true without document.fonts', () => {
    expect('fonts' in document).toBe(false)
    expect(renderHook(() => useFontsReady()).result.current).toBe(true)
  })

  it('turns true once the fonts are ready', async () => {
    let resolve = () => {}
    const ready = new Promise<void>((r) => (resolve = r))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready } })
    const { result } = renderHook(() => useFontsReady())
    expect(result.current).toBe(false)
    await act(async () => {
      resolve()
      await ready
    })
    expect(result.current).toBe(true)
  })

  it('is true at once when the fonts have already loaded', () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded', ready: Promise.resolve() } })
    expect(renderHook(() => useFontsReady()).result.current).toBe(true)
  })
})
