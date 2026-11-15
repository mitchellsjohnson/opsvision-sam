import { describe, expect, it } from 'vitest'
import { chartTheme, MOVE_CLASS, valueMove } from './chartTheme'

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
