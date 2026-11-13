import { describe, expect, it } from 'vitest'
import { bandStatus, statusIntervals } from './bands'

describe('bandStatus', () => {
  it('takes the first matching band in order and falls back to the else band', () => {
    const bands = [
      { status: 'G', op: '<=', value: 5 },
      { status: 'Y', op: '<=', value: 10 },
      { status: 'R', op: '', value: 0 },
    ]
    expect(bandStatus(bands, 3)).toBe('G')
    expect(bandStatus(bands, 5)).toBe('G')
    expect(bandStatus(bands, 7)).toBe('Y')
    expect(bandStatus(bands, 11)).toBe('R')
  })

  it('is empty when no band matches and there is no else band', () => {
    expect(bandStatus([{ status: 'G', op: '>', value: 5 }], 1)).toBe('')
  })
})

describe('statusIntervals', () => {
  it('[G <= 5, Y <= 10, R else] tints 0-5 green, 5-10 yellow, above 10 red', () => {
    const bands = [
      { status: 'G', op: '<=', value: 5 },
      { status: 'Y', op: '<=', value: 10 },
      { status: 'R', op: '', value: 0 },
    ]
    expect(statusIntervals(bands, [0, 20])).toEqual([
      { y0: 0, y1: 5, status: 'G' },
      { y0: 5, y1: 10, status: 'Y' },
      { y0: 10, y1: 20, status: 'R' },
    ])
  })

  it('[R < 90, Y < 95, G else] tints below 90 red, 90-95 yellow, 95 and above green', () => {
    const bands = [
      { status: 'R', op: '<', value: 90 },
      { status: 'Y', op: '<', value: 95 },
      { status: 'G', op: '', value: 0 },
    ]
    expect(statusIntervals(bands, [80, 100])).toEqual([
      { y0: 80, y1: 90, status: 'R' },
      { y0: 90, y1: 95, status: 'Y' },
      { y0: 95, y1: 100, status: 'G' },
    ])
  })

  it('a >= rule: [G >= 90, Y >= 80, R else]', () => {
    const bands = [
      { status: 'G', op: '>=', value: 90 },
      { status: 'Y', op: '>=', value: 80 },
      { status: 'R', op: '', value: 0 },
    ]
    expect(statusIntervals(bands, [70, 100])).toEqual([
      { y0: 70, y1: 80, status: 'R' },
      { y0: 80, y1: 90, status: 'Y' },
      { y0: 90, y1: 100, status: 'G' },
    ])
  })

  it('a > rule shadowed by an earlier band keeps the earlier status (first match wins)', () => {
    const bands = [
      { status: 'G', op: '>', value: 50 },
      { status: 'R', op: '>', value: 80 },
      { status: 'Y', op: '', value: 0 },
    ]
    expect(statusIntervals(bands, [0, 100])).toEqual([
      { y0: 0, y1: 50, status: 'Y' },
      { y0: 50, y1: 100, status: 'G' },
    ])
  })

  it('merges adjacent intervals with the same status and clips to the domain', () => {
    const bands = [
      { status: 'G', op: '>=', value: 90 },
      { status: 'G', op: '>=', value: 80 },
      { status: 'R', op: '', value: 0 },
    ]
    expect(statusIntervals(bands, [85, 120])).toEqual([{ y0: 85, y1: 120, status: 'G' }])
    expect(statusIntervals(bands, [0, 100])).toEqual([
      { y0: 0, y1: 80, status: 'R' },
      { y0: 80, y1: 100, status: 'G' },
    ])
  })

  it('leaves a gap where no band matches', () => {
    expect(statusIntervals([{ status: 'G', op: '>=', value: 50 }], [0, 100])).toEqual([{ y0: 50, y1: 100, status: 'G' }])
  })

  it('has no intervals without bands', () => {
    expect(statusIntervals(undefined, [0, 1])).toEqual([])
    expect(statusIntervals([], [0, 1])).toEqual([])
  })
})
