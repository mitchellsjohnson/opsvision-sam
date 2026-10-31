import { describe, expect, it } from 'vitest'
import tokensCss from './tokens.css?raw'

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokensCss)
  if (!m?.[1]) throw new Error(`missing token ${name}`)
  return m[1]
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE = '#FFFFFF'

// axe's color-contrast check cannot run in jsdom, so the colors the focus
// styles use are verified here against the surfaces they sit on.
describe('focus and highlight colors', () => {
  it('focus ring on dark header surfaces (white on accent-deep) is at least 3:1', () => {
    expect(ratio(WHITE, token('accent-deep'))).toBeGreaterThanOrEqual(3)
  })

  it('focus ring on light surfaces (accent-deep) is at least 3:1 on white and cream', () => {
    expect(ratio(token('accent-deep'), WHITE)).toBeGreaterThanOrEqual(3)
    expect(ratio(token('accent-deep'), token('cream'))).toBeGreaterThanOrEqual(3)
  })

  it('amber ring on the header (skip link) is at least 3:1', () => {
    expect(ratio(token('amber'), token('accent-deep'))).toBeGreaterThanOrEqual(3)
  })

  it('highlighted menu items (white text on accent) meet 4.5:1 and stand out from the white menu', () => {
    expect(ratio(WHITE, token('accent'))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(token('accent'), WHITE)).toBeGreaterThanOrEqual(3)
  })

  it('the old highlight (cream on white) was too faint, which is why it was replaced', () => {
    expect(ratio(token('cream'), WHITE)).toBeLessThan(3)
  })
})
