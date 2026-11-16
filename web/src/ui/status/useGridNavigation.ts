import { useLayoutEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type RefCallback } from 'react'

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
  onOpen: (rowId: string, col: number, el: HTMLElement) => void
}

export interface GridNavigation {
  active: { rowId: string; col: number }
  cellProps: (rowId: string, col: number) => GridCellProps
  /** Moves the tab stop and focus to a row, at `col` or the active column. */
  focusRow: (rowId: string, col?: number) => void
}

const cellId = (rowId: string, col: number) => `${rowId}\u0000${col}`

/**
 * A roving tab stop over a grid of cells: one tab stop; arrows move, Home
 * goes to the first period, End to the selected one, PageUp and PageDown
 * move `pageSize` rows, Enter and Space open the cell.
 */
export function useGridNavigation({ rowIds, colCount, anchor, pageSize = 10, onOpen }: GridNavigationOptions): GridNavigation {
  // The row by id (by index once the id is gone) and the column as anchored: from the start, or back from the end.
  const [pos, setPos] = useState({ rowId: '', rowIndex: 0, at: 0 })
  const cells = useRef(new Map<string, HTMLElement>())
  const pending = useRef<string | null>(null)

  const last = Math.max(colCount - 1, 0)
  const clampCol = (col: number) => Math.max(0, Math.min(last, col))
  const toCol = (at: number) => (anchor === 'end' ? last - clampCol(at) : clampCol(at))
  const toAt = (col: number) => (anchor === 'end' ? last - col : col)
  const rowIndex = rowIds.includes(pos.rowId) ? rowIds.indexOf(pos.rowId) : Math.min(pos.rowIndex, Math.max(rowIds.length - 1, 0))
  const active = { rowId: rowIds[rowIndex] ?? '', col: toCol(pos.at) }

  useLayoutEffect(() => {
    if (pending.current === null) return
    const el = cells.current.get(pending.current)
    if (el) {
      pending.current = null
      el.focus()
    }
  })

  const moveTo = (row: number, col: number) => {
    const index = Math.max(0, Math.min(rowIds.length - 1, row))
    const rowId = rowIds[index]
    if (rowId === undefined) return
    const c = clampCol(col)
    setPos({ rowId, rowIndex: index, at: toAt(c) })
    const el = cells.current.get(cellId(rowId, c))
    if (el) el.focus()
    else pending.current = cellId(rowId, c)
  }

  const cellProps = (rowId: string, col: number): GridCellProps => {
    const id = cellId(rowId, col)
    const index = rowIds.indexOf(rowId)
    return {
      tabIndex: rowId === active.rowId && col === active.col ? 0 : -1,
      'data-pos': `${index}:${toAt(col)}`,
      ref: (el) => {
        if (el) cells.current.set(id, el)
        else cells.current.delete(id)
      },
      onFocus: () => setPos({ rowId, rowIndex: index, at: toAt(col) }),
      onKeyDown: (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(rowId, col, e.currentTarget)
          return
        }
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [index, col - 1],
          ArrowRight: [index, col + 1],
          ArrowUp: [index - 1, col],
          ArrowDown: [index + 1, col],
          Home: [index, 0],
          End: [index, last],
          PageUp: [index - pageSize, col],
          PageDown: [index + pageSize, col],
        }
        const to = moves[e.key]
        if (!to) return
        e.preventDefault()
        moveTo(to[0], to[1])
      },
    }
  }

  const focusRow = (rowId: string, col?: number) => {
    const index = rowIds.indexOf(rowId)
    if (index >= 0) moveTo(index, col ?? active.col)
  }

  return { active, cellProps, focusRow }
}
