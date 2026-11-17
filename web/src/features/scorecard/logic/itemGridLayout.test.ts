import { describe, expect, test } from 'vitest'
import { CHIP_MD_WIDTH, itemGridLayout } from './itemGridLayout'

const needs = { name: 332, group: 76, value: 132, extra: 112 }

describe('itemGridLayout', () => {
  test.each([
    [1774, { count: 12, cellWidth: 93, nameWidth: 338, groupWidth: 76, extraShown: true, stacked: false, tableWidth: 1774 }],
    [1294, { count: 12, cellWidth: 53, nameWidth: 338, groupWidth: 76, extraShown: true, stacked: false, tableWidth: 1294 }],
    [1134, { count: 12, cellWidth: 40, nameWidth: 334, groupWidth: 76, extraShown: true, stacked: false, tableWidth: 1134 }],
    [878, { count: 12, cellWidth: 28, nameWidth: 298, groupWidth: 0, extraShown: true, stacked: false, tableWidth: 878 }],
    [600, { count: 6, cellWidth: 28, nameWidth: 300, groupWidth: 0, extraShown: false, stacked: false, tableWidth: 600 }],
    [340, { count: 6, cellWidth: 56, stacked: true, tableWidth: 336 }],
    [310, { count: 6, cellWidth: 51, stacked: true, tableWidth: 306 }],
  ])('deployments at %i', (w, want) => expect(itemGridLayout(w, 12, needs)).toMatchObject(want))

  test('24 short names at 1294', () =>
    expect(itemGridLayout(1294, 12, { name: 150, group: 76, value: 132, extra: 112 })).toMatchObject({ cellWidth: 68, nameWidth: 158 }))

  test('24 months', () => {
    expect(itemGridLayout(1294, 24, needs)).toMatchObject({ count: 24, cellWidth: 29, nameWidth: 354, groupWidth: 0 })
    expect(itemGridLayout(878, 24, needs)).toMatchObject({ count: 12 })
  })

  test('very wide: cells take the rest, not the name', () =>
    expect(itemGridLayout(2400, 12, needs)).toMatchObject({ cellWidth: 145, nameWidth: 340 }))

  test('tile', () => {
    const t = { group: 0, value: 68, extra: 0 }
    expect(itemGridLayout(536, 12, { ...t, name: 332 }, { nameFloor: 200, stackBelow: 400 })).toMatchObject({
      count: 6,
      nameWidth: 300,
      stacked: false,
    })
    expect(itemGridLayout(536, 12, { ...t, name: 120 }, { nameFloor: 200, stackBelow: 400 }).count).toBe(12)
    expect(itemGridLayout(358, 12, { ...t, name: 332 }, { nameFloor: 200, stackBelow: 400 }).stacked).toBe(true)
  })

  test('inline always fills; the name takes at most count − 1 px past its need', () => {
    for (let w = 600; w <= 2400; w += 37) {
      const l = itemGridLayout(w, 12, needs)
      if (l.stacked) continue
      expect(l.nameWidth + l.groupWidth + l.count * l.cellWidth + l.valueWidth + (l.extraShown ? 112 : 0)).toBe(w)
      expect(l.nameWidth).toBeLessThanOrEqual(needs.name + l.count - 1)
      expect(l.tableWidth).toBe(w)
    }
  })

  test('cells never go under the 24px target, inline or stacked', () => {
    for (let w = 240; w <= 2400; w += 7) {
      const l = itemGridLayout(w, 12, needs)
      expect(l.cellWidth).toBeGreaterThanOrEqual(28)
      expect(l.tableWidth).toBeLessThanOrEqual(w)
    }
  })

  test('stacked rows have no name, group, value or extra column', () =>
    expect(itemGridLayout(340, 12, needs)).toMatchObject({ nameWidth: 0, groupWidth: 0, valueWidth: 0, extraShown: false }))

  test('fewer columns than the inline minimum halve no further than the total', () => {
    expect(itemGridLayout(700, 4, needs)).toMatchObject({ count: 4, stacked: false })
    expect(itemGridLayout(340, 4, needs)).toMatchObject({ count: 4, cellWidth: 56, stacked: true })
  })

  test('before it is measured, lays out the full window inline', () =>
    expect(itemGridLayout(0, 12, needs)).toMatchObject({ count: 12, stacked: false, extraShown: true }))

  test('the md chip is 28px wide', () => expect(CHIP_MD_WIDTH).toBe(28))
})
