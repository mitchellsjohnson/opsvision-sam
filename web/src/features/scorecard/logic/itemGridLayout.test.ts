import { describe, expect, it } from 'vitest'
import { itemGridLayout } from './itemGridLayout'

describe('itemGridLayout', () => {
  const dlg = (w: number) => itemGridLayout(w, 12, { valueWidth: w < 640 ? 76 : 136, extraWidth: 112, nameMin: 96 })
  const tile = (w: number) => itemGridLayout(w, 12, { valueWidth: 72, nameMin: 80 })

  it('dialog grid: the spec table', () => {
    expect(dlg(1296)).toMatchObject({ count: 12, cellWidth: 40, nameWidth: 240, extraShown: true, stacked: false, tableWidth: 968 })
    expect(dlg(880)).toMatchObject({ count: 12, cellWidth: 39, nameWidth: 164, extraShown: true })
    expect(dlg(624)).toMatchObject({ count: 12, cellWidth: 28, nameWidth: 100, extraShown: true })
    expect(dlg(342)).toMatchObject({ count: 6, cellWidth: 28, nameWidth: 98, extraShown: false, stacked: false })
    expect(dlg(312)).toMatchObject({ count: 6, cellWidth: 48, stacked: true })
    expect(dlg(272)).toMatchObject({ count: 6, cellWidth: 45, stacked: true })
  })

  it('tile mini board: the spec table', () => {
    expect(tile(528)).toMatchObject({ count: 12, cellWidth: 28, nameWidth: 120 })
    expect(tile(320)).toMatchObject({ count: 6, cellWidth: 28, nameWidth: 80 })
  })

  it('24 columns stay inline when they fit', () => {
    expect(itemGridLayout(1296, 24, { valueWidth: 136, extraWidth: 112 })).toMatchObject({ count: 24, stacked: false })
  })

  it('the table is only as wide as it needs; stacked tables are the cells only', () => {
    const inline = dlg(880)
    expect(inline.tableWidth).toBe(inline.nameWidth + 12 * inline.cellWidth + inline.valueWidth + 112)
    expect(inline.valueWidth).toBe(136)
    const stacked = dlg(272)
    expect(stacked).toMatchObject({ nameWidth: 0, valueWidth: 0, extraShown: false, tableWidth: 6 * 45 })
  })

  it('fewer items than the inline minimum halve no further than the total', () => {
    expect(itemGridLayout(300, 4, { valueWidth: 76, nameMin: 96 })).toMatchObject({ count: 4, stacked: false })
    // Five columns do not fit beside the name and value, and five is the floor: stack.
    expect(itemGridLayout(300, 5, { valueWidth: 76, nameMin: 96 })).toMatchObject({ count: 5, stacked: true })
  })

  it('never puts cells under the 24px target', () => {
    for (let w = 240; w <= 1920; w += 7) {
      const l = dlg(w)
      expect(l.cellWidth).toBeGreaterThanOrEqual(28)
      expect(l.tableWidth).toBeLessThanOrEqual(w)
    }
  })

  it('before it is measured, lays out the full window inline', () => {
    expect(dlg(0)).toMatchObject({ count: 12, stacked: false, extraShown: true })
  })
})
