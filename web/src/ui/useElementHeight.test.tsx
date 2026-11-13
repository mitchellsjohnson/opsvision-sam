import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useElementHeight } from './useElementHeight'

function Probe() {
  const [ref, height] = useElementHeight<HTMLDivElement>()
  return (
    <div ref={ref} data-testid="probe">
      {height}
    </div>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useElementHeight', () => {
  it('reports the element height and follows resizes', () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    let height = 96
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect)
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('96')
    height = 130
    act(() => callbacks.forEach((cb) => cb()))
    expect(screen.getByTestId('probe').textContent).toBe('130')
  })
})
