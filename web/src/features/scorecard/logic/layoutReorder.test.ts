import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { moveBlock, reorderSectionDrop } from './layoutReorder'

type LayoutItem = components['schemas']['LayoutItem']

function item(id: string): LayoutItem {
  return { id, size: 'small', hidden: false }
}

function ids(items: LayoutItem[]): string[] {
  return items.map((i) => i.id)
}

function uniqueIds(items: LayoutItem[]) {
  expect(new Set(ids(items)).size).toBe(items.length)
}

describe('moveBlock up on metrics', () => {
  it('swaps with the single previous item', () => {
    const items = [item('section:a'), item('metric:a1'), item('metric:a2')]
    const next = moveBlock(items, 2, 'up')
    expect(ids(next)).toEqual(['section:a', 'metric:a2', 'metric:a1'])
    uniqueIds(next)
  })

  it('swaps b1 with section B when B is the previous item', () => {
    const items = [item('section:a'), item('metric:a1'), item('section:b'), item('metric:b1')]
    const next = moveBlock(items, 3, 'up')
    expect(ids(next)).toEqual(['section:a', 'metric:a1', 'metric:b1', 'section:b'])
    uniqueIds(next)
  })
})

describe('moveBlock up on sections and widgets', () => {
  it('swaps the section block with the immediately previous block', () => {
    const items = [item('section:a'), item('metric:a1'), item('section:b'), item('metric:b1')]
    const next = moveBlock(items, 2, 'up')
    expect(ids(next)).toEqual(['section:b', 'metric:b1', 'section:a', 'metric:a1'])
    uniqueIds(next)
  })

  it('swaps with the widget block only when a widget sits between sections', () => {
    const items = [
      item('section:a'),
      item('metric:a1'),
      item('widget:x'),
      item('section:b'),
      item('metric:b1'),
    ]
    const next = moveBlock(items, 3, 'up')
    expect(ids(next)).toEqual(['section:a', 'metric:a1', 'section:b', 'metric:b1', 'widget:x'])
    uniqueIds(next)
  })
})

describe('reorderSectionDrop', () => {
  const five = [
    item('section:a'),
    item('metric:a1'),
    item('section:b'),
    item('metric:b1'),
    item('section:c'),
    item('metric:c1'),
  ]

  it('inserts the dragged section before the target block when moving up', () => {
    const next = reorderSectionDrop(five, 4, 2)
    expect(ids(next!)).toEqual(['section:a', 'metric:a1', 'section:c', 'metric:c1', 'section:b', 'metric:b1'])
  })

  it('inserts the dragged section after the target block when moving down', () => {
    const four = five.slice(0, 4)
    const next = reorderSectionDrop(four, 0, 2)
    expect(ids(next!)).toEqual(['section:b', 'metric:b1', 'section:a', 'metric:a1'])
  })

  it('does not reorder when dropping on a member of the same block', () => {
    const four = five.slice(0, 4)
    expect(reorderSectionDrop(four, 0, 1)).toBeNull()
  })
})

describe('metrics that follow a widget', () => {
  const items = [item('section:a'), item('metric:m1'), item('widget:needs'), item('metric:m2'), item('section:b')]

  it('moving section:b up keeps every item', () => {
    const next = moveBlock(items, 4, 'up')
    expect(ids(next)).toEqual(['section:a', 'metric:m1', 'widget:needs', 'section:b', 'metric:m2'])
    expect([...ids(next)].sort()).toEqual([...ids(items)].sort())
  })

  it('moving the widget down past the stray metric keeps every item', () => {
    const next = moveBlock(items, 2, 'down')
    expect(ids(next)).toEqual(['section:a', 'metric:m1', 'metric:m2', 'widget:needs', 'section:b'])
  })

  it('dragging section:b onto the stray metric keeps every item', () => {
    const next = reorderSectionDrop(items, 4, 3)!
    expect([...ids(next)].sort()).toEqual([...ids(items)].sort())
    uniqueIds(next)
  })
})
