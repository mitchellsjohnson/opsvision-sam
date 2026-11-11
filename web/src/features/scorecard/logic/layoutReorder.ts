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

function previousBlockRange(items: LayoutItem[], beforeIndex: number): [number, number] | null {
  if (beforeIndex <= 0) return null
  let i = beforeIndex - 1
  while (i >= 0 && !items[i]!.id.startsWith('section:')) i--
  if (i >= 0) return blockRange(items, i)
  return blockRange(items, beforeIndex - 1)
}

function isFirstMetricInSection(items: LayoutItem[], index: number): boolean {
  if (!items[index]!.id.startsWith('metric:')) return false
  return index > 0 && items[index - 1]!.id.startsWith('section:')
}

/** Move up: section blocks swap with the previous block; a section's first metric joins the prior section. */
export function moveBlock(items: LayoutItem[], index: number, where: 'up' | 'down' | 'top'): LayoutItem[] {
  const [start, end] = blockRange(items, index)
  const block = items.slice(start, end + 1)
  const before = items.slice(0, start)
  const after = items.slice(end + 1)

  if (where === 'top') {
    return [...block, ...before, ...after]
  }

  if (where === 'up') {
    if (isFirstMetricInSection(items, index)) {
      let prevSection = -1
      for (let i = index - 2; i >= 0; i--) {
        if (items[i]!.id.startsWith('section:')) {
          prevSection = i
          break
        }
      }
      if (prevSection < 0) return items
      const [, prevEnd] = blockRange(items, prevSection)
      const metric = items[index]!
      const rest = items.filter((_, i) => i !== index)
      const insertAt = index < prevEnd ? prevEnd - 1 : prevEnd
      return [...rest.slice(0, insertAt + 1), metric, ...rest.slice(insertAt + 1)]
    }

    if (start === 0) return items
    const prev = previousBlockRange(items, start)
    if (!prev) return items
    const [prevStart, prevEnd] = prev
    const prevBlock = items.slice(prevStart, prevEnd + 1)
    return [...items.slice(0, prevStart), ...block, ...prevBlock, ...items.slice(end + 1)]
  }

  const nextStart = end + 1
  if (nextStart >= items.length) return items
  const [nextBlockStart, nextEnd] = blockRange(items, nextStart)
  const nextBlock = items.slice(nextBlockStart, nextEnd + 1)
  const gap = items.slice(end + 1, nextBlockStart)
  const tail = items.slice(nextEnd + 1)
  return [...before, ...nextBlock, ...gap, ...block, ...tail]
}

/** Drag a section block so it sits after the block dropped on; no-op when dropping on the same block. */
export function reorderSectionAfterDrop(
  items: LayoutItem[],
  activeIndex: number,
  overIndex: number,
): LayoutItem[] | null {
  const [activeStart, activeEnd] = blockRange(items, activeIndex)
  const [overStart] = blockRange(items, overIndex)
  if (overStart >= activeStart && overStart <= activeEnd) return null

  const activeBlock = items.slice(activeStart, activeEnd + 1)
  const overId = items[overIndex]!.id
  const without = [...items.slice(0, activeStart), ...items.slice(activeEnd + 1)]
  const newOverIndex = without.findIndex((i) => i.id === overId)
  if (newOverIndex < 0) return null
  const [, newOverEnd] = blockRange(without, newOverIndex)
  const insertAt = newOverEnd + 1
  return [...without.slice(0, insertAt), ...activeBlock, ...without.slice(insertAt)]
}
