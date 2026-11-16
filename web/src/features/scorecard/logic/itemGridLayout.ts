export interface ItemGridLayout {
  /** How many of the latest columns to show. */
  count: number
  /** Each period column's width in px, gutters included. */
  cellWidth: number
  /** The name column's width in px; 0 when stacked. */
  nameWidth: number
  /** The value column's width in px; 0 when stacked. */
  valueWidth: number
  /** Whether the extra column (Red months) is shown. */
  extraShown: boolean
  /** Each item stacks: the name and value above, the cells below. */
  stacked: boolean
  /** The table's width: only as wide as it needs, so leftover space sits after it. */
  tableWidth: number
}

/** 24px cells plus a 2px gutter each side: the smallest target WCAG 2.2 allows. */
const CELL_MIN = 28
const CELL_MAX = 40
/** Stacked rows have no name beside the cells, so the cells may grow wider. */
const CELL_MAX_STACKED = 48
/** Cells widen past the minimum only once the name has this much. */
const NAME_COMFORT = 160
const NAME_MAX = 240

/**
 * Fits an item grid (items × periods) to its container (§6.3): inline when
 * the name, every column and the value fit; else the latest half, quarter
 * and so on, while at least `minInline` columns (or all, when fewer) remain;
 * else stacked, halving until the cells fit the width. The extra column
 * shows only when it fits too.
 */
export function itemGridLayout(
  width: number,
  total: number,
  opts: { valueWidth: number; extraWidth?: number; nameMin?: number; minInline?: number },
): ItemGridLayout {
  const { valueWidth, extraWidth = 0, nameMin = 96, minInline = 6 } = opts
  const all = Math.max(total, 1)
  const w = Math.floor(width)
  if (w <= 0) {
    // Not measured yet: the full window inline, at its widest.
    const extra = extraWidth > 0 ? extraWidth : 0
    return {
      count: all,
      cellWidth: CELL_MAX,
      nameWidth: NAME_MAX,
      valueWidth,
      extraShown: extraWidth > 0,
      stacked: false,
      tableWidth: NAME_MAX + all * CELL_MAX + valueWidth + extra,
    }
  }

  const floor = Math.min(minInline, all)
  for (let count = all; count >= floor; count = Math.ceil(count / 2)) {
    const need = nameMin + count * CELL_MIN + valueWidth
    if (need <= w) {
      const extraShown = extraWidth > 0 && need + extraWidth <= w
      const extra = extraShown ? extraWidth : 0
      const cellWidth = Math.min(CELL_MAX, Math.max(CELL_MIN, Math.floor((w - valueWidth - extra - NAME_COMFORT) / count)))
      const nameWidth = Math.min(NAME_MAX, w - valueWidth - extra - count * cellWidth)
      return { count, cellWidth, nameWidth, valueWidth, extraShown, stacked: false, tableWidth: nameWidth + count * cellWidth + valueWidth + extra }
    }
    if (count === 1) break
  }

  let count = all
  while (count > 1 && count * CELL_MIN > w) count = Math.ceil(count / 2)
  const cellWidth = Math.min(CELL_MAX_STACKED, Math.floor(w / count))
  return { count, cellWidth, nameWidth: 0, valueWidth: 0, extraShown: false, stacked: true, tableWidth: count * cellWidth }
}
