function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** WCAG contrast ratio between two sRGB hex colors. */
export function contrastRatio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE = '#FFFFFF'

/** True when status color on white fails WCAG 4.5:1 for normal text — use ink for the letter. */
export function letterUsesInkOnWhite(color: string): boolean {
  return contrastRatio(color, WHITE) < 4.5
}
