import { describe, expect, it } from 'vitest'
import { chartTheme } from './chartTheme'

const level = (color: string) => [{ key: 'X', label: 'Custom', color, rank: 1 }]

describe('chartTheme onColor', () => {
  it('letters a dark status shape in white', () => {
    expect(chartTheme(undefined, 'G').onColor).toBe('#FFFFFF')
  })

  it('letters a light status shape in ink', () => {
    expect(chartTheme(level('#F5A524'), 'X').onColor).toBe('var(--color-ink)')
  })

  it('picks white when neither reaches 4.5:1 but white reads better', () => {
    // White on #7A7A7A is about 4.3:1; ink is about 3.6:1.
    expect(chartTheme(level('#7A7A7A'), 'X').onColor).toBe('#FFFFFF')
  })

  it('letters an unknown status (ink fill) in white', () => {
    expect(chartTheme(undefined, 'Q').onColor).toBe('#FFFFFF')
  })
})
