import type { components } from '../../../api/schema'

type LayoutItem = components['schemas']['LayoutItem']

export function blockRange(items: LayoutItem[], index: number): [number, number] {
  const id = items[index]!.id
  if (id.startsWith('section:')) {
    let end = index
    for (let i = index + 1; i < items.length; i++) {
      const next = items[i]!.id
      if (next.startsWith('section:') || next.startsWith('widget:')) break
      end = i
    }
    return [index, end]
  }
  return [index, index]
}

/** The layout block that contains this index (section+metrics, or a single widget/metric). */
export function blockContaining(items: LayoutItem[], index: number): [number, number] {
  const id = items[index]!.id
  if (id.startsWith('section:') || id.startsWith('widget:')) return blockRange(items, index)
  if (id.startsWith('metric:')) {
    let i = index
    while (i >= 0 && !items[i]!.id.startsWith('section:')) i--
    if (i >= 0) return blockRange(items, i)
    return [index, index]
  }
  return [index, index]
}

function swapWithPreviousItem(items: LayoutItem[], index: number): LayoutItem[] {
  if (index <= 0) return items
  const next = [...items]
  ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
  return next
}

function swapWithNextItem(items: LayoutItem[], index: number): LayoutItem[] {
  if (index >= items.length - 1) return items
  const next = [...items]
  ;[next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
  return next
}

function swapBlockWithPreviousBlock(items: LayoutItem[], index: number): LayoutItem[] {
  const [start, end] = blockRange(items, index)
  if (start === 0) return items
  const [prevStart, prevEnd] = blockContaining(items, start - 1)
  const activeBlock = items.slice(start, end + 1)
  const prevBlock = items.slice(prevStart, prevEnd + 1)
  return [...items.slice(0, prevStart), ...activeBlock, ...prevBlock, ...items.slice(end + 1)]
}

function swapBlockWithNextBlock(items: LayoutItem[], index: number): LayoutItem[] {
  const [start, end] = blockRange(items, index)
  if (end >= items.length - 1) return items
  const [nextStart, nextEnd] = blockContaining(items, end + 1)
  const activeBlock = items.slice(start, end + 1)
  const nextBlock = items.slice(nextStart, nextEnd + 1)
  return [...items.slice(0, start), ...nextBlock, ...items.slice(end + 1, nextStart), ...activeBlock, ...items.slice(nextEnd + 1)]
}

export function moveBlock(items: LayoutItem[], index: number, where: 'up' | 'down' | 'top'): LayoutItem[] {
  const id = items[index]!.id

  if (where === 'top') {
    const [start, end] = blockRange(items, index)
    const block = items.slice(start, end + 1)
    return [...block, ...items.slice(0, start), ...items.slice(end + 1)]
  }

  if (where === 'up') {
    if (id.startsWith('metric:')) return swapWithPreviousItem(items, index)
    if (id.startsWith('section:') || id.startsWith('widget:')) return swapBlockWithPreviousBlock(items, index)
    return items
  }

  if (id.startsWith('metric:')) return swapWithNextItem(items, index)
  if (id.startsWith('section:') || id.startsWith('widget:')) return swapBlockWithNextBlock(items, index)
  return items
}

/** Section drag: insert before or after the target block; no-op when dropping inside the dragged block. */
export function reorderSectionDrop(
  items: LayoutItem[],
  activeIndex: number,
  overIndex: number,
): LayoutItem[] | null {
  const [activeStart, activeEnd] = blockRange(items, activeIndex)
  if (overIndex >= activeStart && overIndex <= activeEnd) return null

  const activeBlock = items.slice(activeStart, activeEnd + 1)
  const without = [...items.slice(0, activeStart), ...items.slice(activeEnd + 1)]
  const overId = items[overIndex]!.id
  const overPos = without.findIndex((i) => i.id === overId)
  if (overPos < 0) return null

  const [targetStart, targetEnd] = blockContaining(without, overPos)
  const insertAt = activeStart < overIndex ? targetEnd + 1 : targetStart
  return [...without.slice(0, insertAt), ...activeBlock, ...without.slice(insertAt)]
}
