import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../../ui/contrast'
import tokensCss from '../../../ui/tokens.css?raw'
import { barFill, chartTheme, defaultStatusScale, MOVE_CLASS, statusFill, TOKEN_TINTS, valueMove } from './chartTheme'

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

describe('statusFill: exception-first tiers', () => {
  it('fills the best status with a soft tint, lettered in its color', () => {
    expect(statusFill(undefined, 'G')).toEqual({ tier: 'soft', background: 'var(--color-status-g-bg)', letter: '#137A3A', border: null })
  })

  it('outlines a middle status on its tint', () => {
    expect(statusFill(undefined, 'Y')).toEqual({ tier: 'outline', background: 'var(--color-status-y-bg)', letter: '#8A5A00', border: '#8A5A00' })
  })

  it('fills the worst status solid, lettered white', () => {
    expect(statusFill(undefined, 'R')).toEqual({ tier: 'solid', background: '#B42318', letter: '#FFFFFF', border: null })
  })

  it('the tints match the status tokens in tokens.css', () => {
    const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokensCss)?.[1]?.toUpperCase()
    for (const key of ['g', 'y']) {
      const tint = TOKEN_TINTS[token(`status-${key}`)!]
      expect(tint, key).toEqual({ css: `var(--color-status-${key}-bg)`, hex: token(`status-${key}-bg`) })
    }
  })

  it('the token tints keep the letter at 4.5:1 or more', () => {
    expect(contrastRatio('#137A3A', '#E3F6EA')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#8A5A00', '#FFF3D6')).toBeGreaterThanOrEqual(4.5)
  })

  it('derives a 14% tint for a tenant color whose letter still reads on it', () => {
    const scale = [
      { key: 'A', label: 'Fine', color: '#1D4ED8', rank: 1 },
      { key: 'B', label: 'Bad', color: '#7F1D1D', rank: 2 },
    ]
    expect(statusFill(scale, 'A')).toEqual({ tier: 'soft', background: 'color-mix(in srgb, #1D4ED8 14%, white)', letter: '#1D4ED8', border: null })
  })

  it('falls back to solid when the letter would fail 4.5:1 on the tint', () => {
    const scale = [
      { key: 'A', label: 'Fine', color: '#F5D90A', rank: 1 },
      { key: 'B', label: 'Bad', color: '#7F1D1D', rank: 2 },
    ]
    expect(statusFill(scale, 'A')).toEqual({ tier: 'solid', background: '#F5D90A', letter: 'var(--color-ink)', border: null })
  })

  it('fills an unknown status solid', () => {
    expect(statusFill(undefined, 'Q').tier).toBe('solid')
  })
})

describe('barFill: bars by tier', () => {
  const scale = defaultStatusScale()

  it('Green is its soft tint with a 1px Green edge; Yellow its tint with a Yellow edge; Red solid', () => {
    expect(barFill(scale, 'G')).toEqual({ fill: '#E3F6EA', stroke: '#137A3A' })
    expect(barFill(scale, 'Y')).toEqual({ fill: '#FFF3D6', stroke: '#8A5A00' })
    expect(barFill(scale, 'R')).toEqual({ fill: '#B42318', stroke: '#B42318' })
  })

  it('every edge reads at 3:1 or more on white, a light tenant color and a bar with no status included', () => {
    const light = [
      { key: 'A', label: 'Fine', color: '#F5D90A', rank: 1 },
      { key: 'B', label: 'Watch', color: '#7DD3FC', rank: 2 },
      { key: 'C', label: 'Bad', color: '#FDA4AF', rank: 3 },
    ]
    for (const [s, status] of [
      [scale, 'G'],
      [scale, 'Y'],
      [scale, 'R'],
      [scale, ''],
      [light, 'A'],
      [light, 'B'],
      [light, 'C'],
    ] as const) {
      const { fill, stroke } = barFill([...s], status)
      expect(fill, status).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(contrastRatio(stroke, '#FFFFFF'), `${status} edge`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('valueMove', () => {
  it('a rise is good when higher is better and bad when lower is better', () => {
    expect(valueMove(2, 'higher_better')).toEqual({ arrow: '▲', tone: 'good' })
    expect(valueMove(2, 'lower_better')).toEqual({ arrow: '▲', tone: 'bad' })
  })

  it('a fall is bad when higher is better and good when lower is better', () => {
    expect(valueMove(-2, 'higher_better')).toEqual({ arrow: '▼', tone: 'bad' })
    expect(valueMove(-2, 'lower_better')).toEqual({ arrow: '▼', tone: 'good' })
  })

  it('no move is neutral, with no arrow', () => {
    expect(valueMove(0, 'higher_better')).toEqual({ arrow: '', tone: 'neutral' })
  })

  it('colors good, bad and neutral with status tokens and ink', () => {
    expect(MOVE_CLASS).toEqual({ good: 'text-status-g', bad: 'text-status-r', neutral: 'text-ink/70' })
  })
})
