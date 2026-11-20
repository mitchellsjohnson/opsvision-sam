/** What each column of an item grid needs, measured from its content, in px. */
export interface ItemGridNeeds {
  /** The widest item name, with its right padding. */
  name: number
  /** The widest group name, with its padding; 0 when the items have fewer than two groups. */
  group: number
  /** The widest value cell, with its left padding. */
  value: number
  /** The extra column (Red months); 0 when the caller has none. */
  extra: number
}

export interface ItemGridLayout {
  /** How many of the latest columns to show. */
  count: number
  /** Each period column's width in px, gutters included. */
  cellWidth: number
  /** The name column's width in px; 0 when stacked. */
  nameWidth: number
  /** The group column's width in px; 0 when stacked or not shown. */
  groupWidth: number
  /** The value column's width in px; 0 when stacked. */
  valueWidth: number
  /** Whether the extra column (Red months) is shown. */
  extraShown: boolean
  /** Each item stacks: the name and value above, the cells below. */
  stacked: boolean
  /** The table's width: inline, always the full width given. */
  tableWidth: number
}

/** The md status chip's width (`w-7`), for value cells that hold one. */
export const CHIP_MD_WIDTH = 28

/** 24px cells plus a 2px gutter each side: the smallest target WCAG 2.2 allows. */
export const CELL_MIN = 28
/** Cells grow to this before anything else gets more; past it only once every column is full. */
const CELL_MAX = 96
/** Stacked rows have no name beside the cells, so the cells may grow wider. */
const CELL_MAX_STACKED = 56

function stackedLayout(width: number, total: number): ItemGridLayout {
  let count = Math.min(total, 6)
  while (count > 1 && count * CELL_MIN > width) count = Math.ceil(count / 2)
  const cellWidth = Math.min(CELL_MAX_STACKED, Math.floor(width / count))
  return { count, cellWidth, nameWidth: 0, groupWidth: 0, valueWidth: 0, extraShown: false, stacked: true, tableWidth: count * cellWidth }
}

/**
 * Fits an item grid (items × periods) to its container so it fills it
 * (§2.2). Below `stackBelow`, or when not even `minInline` columns fit
 * beside the name floor and the value, each item stacks. Inline, the
 * leftover goes, in order, to the extra column (whole), the name up to its
 * need, the group column (whole), the cells up to 96px each, then the cells
 * without a cap; the last few pixels go to the name, so the table is
 * exactly `width` wide.
 */
export function itemGridLayout(
  width: number,
  total: number,
  needs: ItemGridNeeds,
  opts: { minInline?: number; stackBelow?: number; nameFloor?: number } = {},
): ItemGridLayout {
  const { minInline = 6, stackBelow = 600, nameFloor = 240 } = opts
  const all = Math.max(total, 1)
  const w = Math.floor(width)
  if (w <= 0) {
    // Not measured yet: the full window inline, each column at its need.
    const extraShown = needs.extra > 0
    const nameWidth = needs.name
    return {
      count: all,
      cellWidth: CELL_MIN,
      nameWidth,
      groupWidth: needs.group,
      valueWidth: needs.value,
      extraShown,
      stacked: false,
      tableWidth: nameWidth + needs.group + all * CELL_MIN + needs.value + (extraShown ? needs.extra : 0),
    }
  }
  if (w < stackBelow) return stackedLayout(w, all)

  const floor = Math.min(minInline, all)
  for (let count = all; count >= floor; count = Math.ceil(count / 2)) {
    let nameWidth = Math.min(needs.name, nameFloor)
    const base = count * CELL_MIN + needs.value + nameWidth
    if (base <= w) {
      let rem = w - base
      const extraShown = needs.extra > 0 && needs.extra <= rem
      if (extraShown) rem -= needs.extra
      const toName = Math.min(rem, needs.name - nameWidth)
      nameWidth += toName
      rem -= toName
      const groupWidth = needs.group > 0 && needs.group <= rem ? needs.group : 0
      rem -= groupWidth
      let cellWidth = CELL_MIN + Math.min(CELL_MAX - CELL_MIN, Math.floor(rem / count))
      rem -= (cellWidth - CELL_MIN) * count
      if (cellWidth === CELL_MAX) {
        cellWidth += Math.floor(rem / count)
        rem %= count
      }
      nameWidth += rem
      return {
        count,
        cellWidth,
        nameWidth,
        groupWidth,
        valueWidth: needs.value,
        extraShown,
        stacked: false,
        tableWidth: w,
      }
    }
    if (count === 1) break
  }
  return stackedLayout(w, all)
}
