import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sam } from './Sam'

describe('Sam', () => {
  it('shows the neutral mark by default, hidden from assistive technology', () => {
    const { container } = render(<Sam />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/brand/sam/sam-mark.svg')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })

  it('picks the file for each pose', () => {
    const { container } = render(<Sam pose="celebrating" />)
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/brand/sam/sam-full-celebrating.svg')
  })
})
