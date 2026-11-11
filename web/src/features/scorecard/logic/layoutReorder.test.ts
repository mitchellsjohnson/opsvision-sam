import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { moveBlock, reorderSectionAfterDrop } from './layoutReorder'

type LayoutItem = components['schemas']['LayoutItem']

function item(id: string): LayoutItem {
  return { id, size: 'small', hidden: false }
}

describe('moveBlock up', () => {
  const items = [
    item('section:a'),
    item('metric:a1'),
    item('section:b'),
    item('metric:b1'),
  ]

  it('on the first metric under a section, moves that metric to the end of the previous section', () => {
    const next = moveBlock(items, 3, 'up')
    expect(next.map((i) => i.id)).toEqual(['section:a', 'metric:a1', 'metric:b1', 'section:b'])
    expect(new Set(next.map((i) => i.id)).size).toBe(next.length)
  })

  it('on a section marker, swaps that block with the previous block', () => {
    const next = moveBlock(items, 2, 'up')
    expect(next.map((i) => i.id)).toEqual(['section:b', 'metric:b1', 'section:a', 'metric:a1'])
    expect(new Set(next.map((i) => i.id)).size).toBe(next.length)
  })
})

describe('reorderSectionAfterDrop', () => {
  const items = [item('section:a'), item('metric:a1'), item('section:b'), item('metric:b1')]

  it('inserts the dragged section block after the block dropped on', () => {
    const next = reorderSectionAfterDrop(items, 0, 2)
    expect(next?.map((i) => i.id)).toEqual(['section:b', 'metric:b1', 'section:a', 'metric:a1'])
  })

  it('does not reorder when dropping on a member of the same block', () => {
    expect(reorderSectionAfterDrop(items, 0, 1)).toBeNull()
  })
})
