import { useCallback, useLayoutEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type RefCallback } from 'react'

export interface GridCellProps {
  tabIndex: 0 | -1
  'data-pos': string
  onKeyDown: KeyboardEventHandler<HTMLElement>
  onFocus: FocusEventHandler<HTMLElement>
  ref: RefCallback<HTMLElement>
}

export interface GridNavigationOptions {
  rowIds: string[]
  colCount: number
  /** `end` counts the column back from the last (selected) period, so it holds when `colCount` changes. */
  anchor: 'start' | 'end'
  /** Rows PageUp and PageDown move; 10 by default. */
  pageSize?: number
  /**
   * Rows may end in a trailing cell (column `colCount`, after the selected
   * period): → from the selected period reaches it and ← returns. End still
   * lands on the selected period. A row that draws no trailing cell keeps →
   * on the selected period.
   */
  trailing?: boolean
  onOpen: (rowId: string, col: number, el: HTMLElement) => void
  /** `W` on any cell (the trailing one included): that cell's Why card. */
  onWhy?: (rowId: string, col: number, el: HTMLElement) => void
}

export interface GridNavigation {
  active: { rowId: string; col: number }
  cellProps: (rowId: string, col: number) => GridCellProps
  /**
   * As `cellProps`, given the row's index and whether the cell holds the tab
   * stop. The same function while the column count holds, so a memoized row
   * that passes these in re-renders only when they change.
   */
  cellPropsFor: (rowId: string, col: number, index: number, active: boolean) => GridCellProps
  /** Moves the tab stop and focus to a row, at `col` or the active column. */
  focusRow: (rowId: string, col?: number) => void
}

const cellId = (rowId: string, col: number) => `${rowId}\u0000${col}`

/** Keys typed here belong to the field, even inside a cell. */
const EDITABLE = 'input, textarea, select, [contenteditable]'

/**
 * A roving tab stop over a grid of cells: one tab stop; arrows move, Home
 * goes to the first period, End to the selected one, PageUp and PageDown
 * move `pageSize` rows, Enter and Space open the cell, `W` asks why.
 */
export function useGridNavigation({ rowIds, colCount, anchor, pageSize = 10, trailing = false, onOpen, onWhy }: GridNavigationOptions): GridNavigation {
  // The row by id (by index once the id is gone) and the column as anchored: from the start, or back from the end.
  const [pos, setPos] = useState({ rowId: '', rowIndex: 0, at: 0 })
  const cells = useRef(new Map<string, HTMLElement>())
  // A move to a cell not drawn yet, and what had focus when it was asked for.
  const pending = useRef<{ id: string; from: Element | null } | null>(null)

  const last = Math.max(colCount - 1, 0)
  const maxCol = trailing ? last + 1 : last
  const clampCol = (col: number) => Math.max(0, Math.min(maxCol, col))
  const toCol = (at: number) => clampCol(anchor === 'end' ? last - at : at)
  const rowIndex = rowIds.includes(pos.rowId) ? rowIds.indexOf(pos.rowId) : Math.min(pos.rowIndex, Math.max(rowIds.length - 1, 0))
  const active = { rowId: rowIds[rowIndex] ?? '', col: toCol(pos.at) }

  const moveTo = (row: number, col: number) => {
    pending.current = null
    const index = Math.max(0, Math.min(rowIds.length - 1, row))
    const rowId = rowIds[index]
    if (rowId === undefined) return
    let c = clampCol(col)
    // A row with no trailing cell keeps the move on its selected period.
    if (c > last && !cells.current.has(cellId(rowId, c))) c = last
    setPos({ rowId, rowIndex: index, at: anchor === 'end' ? last - c : c })
    const el = cells.current.get(cellId(rowId, c))
    if (el) el.focus()
    else pending.current = { id: cellId(rowId, c), from: document.activeElement }
  }

  const focusRow = (rowId: string, col?: number) => {
    const index = rowIds.indexOf(rowId)
    if (index >= 0) moveTo(index, col ?? active.col)
  }

  // What the cells' handlers act on: the committed render's rows and moves (handlers run after commit).
  const latest = useRef({ rowIds, pageSize, onOpen, onWhy, moveTo })
  useLayoutEffect(() => {
    latest.current = { rowIds, pageSize, onOpen, onWhy, moveTo }
  })

  useLayoutEffect(() => {
    const queued = pending.current
    if (!queued) return
    // Focus moved on to something else (not just dropped to the body by a redraw): the move is stale.
    const now = document.activeElement
    if (now !== queued.from && now !== null && now !== document.body) {
      pending.current = null
      return
    }
    const el = cells.current.get(queued.id)
    if (el) {
      pending.current = null
      el.focus()
    }
  })

  const cellPropsFor = useCallback(
    (rowId: string, col: number, index: number, isActive: boolean): GridCellProps => {
      const id = cellId(rowId, col)
      const at = anchor === 'end' ? last - col : col
      return {
        tabIndex: isActive ? 0 : -1,
        'data-pos': `${index}:${at}`,
        ref: (el) => {
          if (el) cells.current.set(id, el)
          else cells.current.delete(id)
        },
        onFocus: () => {
          pending.current = null
          setPos({ rowId, rowIndex: latest.current.rowIds.indexOf(rowId), at })
        },
        onKeyDown: (e) => {
          if (e.altKey || e.ctrlKey || e.metaKey) return
          if (e.target !== e.currentTarget && e.target instanceof Element && e.target.closest(EDITABLE)) return
          const now = latest.current
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            now.onOpen(rowId, col, e.currentTarget)
            return
          }
          if (e.key === 'w' || e.key === 'W') {
            if (!now.onWhy || e.repeat) return
            e.preventDefault()
            now.onWhy(rowId, col, e.currentTarget)
            return
          }
          const row = now.rowIds.indexOf(rowId)
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [row, col - 1],
            ArrowRight: [row, col + 1],
            ArrowUp: [row - 1, col],
            ArrowDown: [row + 1, col],
            Home: [row, 0],
            End: [row, last],
            PageUp: [row - now.pageSize, col],
            PageDown: [row + now.pageSize, col],
          }
          const to = moves[e.key]
          if (!to) return
          e.preventDefault()
          now.moveTo(to[0], to[1])
        },
      }
    },
    [anchor, last],
  )

  const cellProps = (rowId: string, col: number) =>
    cellPropsFor(rowId, col, rowIds.indexOf(rowId), rowId === active.rowId && col === active.col)

  return { active, cellProps, cellPropsFor, focusRow }
}
