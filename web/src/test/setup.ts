import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { server, state } from './server'

// Radix primitives use pointer-capture and scroll APIs jsdom does not have.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// axe probes canvas support for color-contrast checks; jsdom has none.
HTMLCanvasElement.prototype.getContext = () => null

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  state.role = 'admin'
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
  sessionStorage.clear()
  localStorage.clear()
})
afterAll(() => server.close())
