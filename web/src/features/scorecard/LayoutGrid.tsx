import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { GripVertical } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../../api/errors'
import { useLayout, usePutDefaultLayout, usePutLayout } from '../../api/queries'
import type { components } from '../../api/schema'
import { menuItemHighlight } from '../../ui/focus'
import { applyLayout, defaultLayout, type LayoutCategory, type LayoutMetric } from './logic/layout'
import { moveBlock, reorderSectionDrop } from './logic/layoutReorder'

type LayoutItem = components['schemas']['LayoutItem']

export interface LayoutGridProps {
  scorecardId: string
  categories: LayoutCategory[]
  metricsByCategory: Record<string, LayoutMetric[]>
  isAdmin: boolean
  itemLabels: Record<string, string>
  metricCategories: Record<string, string>
  renderHealth: () => React.ReactNode
  renderRibbon: () => React.ReactNode
  renderNeeds: () => React.ReactNode
  renderUnreported: () => React.ReactNode
  renderSection: (categoryId: string) => React.ReactNode
  renderMetric: (metricKey: string) => React.ReactNode
}

const MOBILE_MAX_WIDTH = '(max-width: 767px)'

function displayOrder(items: LayoutItem[]): LayoutItem[] {
  const needs = items.find((i) => i.id === 'widget:needs')
  const visible = items.filter((i) => !i.hidden)
  const rest = visible.filter((i) => i.id !== 'widget:needs')
  if (needs && !needs.hidden) return [needs, ...rest]
  return rest
}

function hiddenCount(items: LayoutItem[]): number {
  return items.filter((i) => i.hidden).length
}

function restoreNextHidden(items: LayoutItem[]): LayoutItem[] {
  const next = items.find((i) => i.hidden)
  if (!next) return items
  return items.map((i) => (i.id === next.id ? { ...i, hidden: false } : i))
}

function labelFor(id: string, labels: Record<string, string>): string {
  if (labels[id]) return labels[id]
  if (id.startsWith('section:')) return labels[id] ?? id.slice('section:'.length)
  if (id.startsWith('metric:')) return labels[id] ?? id.slice('metric:'.length)
  return id
}

interface SortableTileProps {
  id: string
  item: LayoutItem
  label: string
  onUpdate: (next: LayoutItem[]) => void
  allItems: LayoutItem[]
  children: React.ReactNode
}

function SortableTile({ id, item, label, onUpdate, allItems, children }: SortableTileProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  }

  const index = allItems.findIndex((i) => i.id === item.id)

  const apply = (mutator: (items: LayoutItem[]) => LayoutItem[]) => {
    onUpdate(mutator([...allItems]))
  }

  const isMetric = item.id.startsWith('metric:')

  return (
    <div
      ref={setNodeRef}
      style={style}
      role={isMetric ? undefined : 'article'}
      aria-label={isMetric ? undefined : label}
      className="relative rounded-lg border border-transparent"
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="rounded border border-ink/20 bg-white p-1 hover:bg-cream"
          aria-label={`Drag ${label}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden size={16} />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className="rounded border border-ink/20 bg-white px-2 py-1 text-xs hover:bg-cream"
            aria-label="Layout options"
          >
            ⋮
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="z-50 min-w-40 rounded-md border border-ink/20 bg-white p-1 shadow-lg">
              <DropdownMenu.Item
                className={menuItemHighlight}
                onSelect={() => apply((items) => items.map((i) => (i.id === item.id ? { ...i, size: 'small' } : i)))}
              >
                Small
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItemHighlight}
                onSelect={() => apply((items) => items.map((i) => (i.id === item.id ? { ...i, size: 'wide' } : i)))}
              >
                Wide
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItemHighlight}
                onSelect={() => apply((items) => items.map((i) => (i.id === item.id ? { ...i, hidden: true } : i)))}
              >
                Hide
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-ink/10" />
              <DropdownMenu.Item className={menuItemHighlight} onSelect={() => apply((items) => moveBlock(items, index, 'up'))}>
                Move up
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItemHighlight}
                onSelect={() => apply((items) => moveBlock(items, index, 'down'))}
              >
                Move down
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItemHighlight}
                onSelect={() => apply((items) => moveBlock(items, index, 'top'))}
              >
                Move to top
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {children}
    </div>
  )
}

export function LayoutGrid({
  scorecardId,
  categories,
  metricsByCategory,
  isAdmin,
  itemLabels,
  metricCategories,
  renderHealth,
  renderRibbon,
  renderNeeds,
  renderUnreported,
  renderSection,
  renderMetric,
}: LayoutGridProps) {
  const layout = useLayout(scorecardId)
  const putLayout = usePutLayout(scorecardId)
  const putDefault = usePutDefaultLayout(scorecardId)
  const [announcement, setAnnouncement] = useState('')

  const fallback = useMemo(
    () => defaultLayout(categories, metricsByCategory),
    [categories, metricsByCategory],
  )

  const merged = useMemo(
    () => applyLayout(fallback, layout.data?.items ?? []),
    [fallback, layout.data?.items],
  )

  const [pointerDrag, setPointerDrag] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return !window.matchMedia(MOBILE_MAX_WIDTH).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(MOBILE_MAX_WIDTH)
    const sync = () => setPointerDrag(!mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const pointerActivation = pointerDrag
    ? { distance: 8 }
    : { distance: Number.MAX_SAFE_INTEGER }
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: pointerActivation })
  const sensors = useSensors(keyboardSensor, pointerSensor)

  const persist = useCallback(
    async (items: LayoutItem[]) => {
      const revision = layout.data?.revision ?? 0
      try {
        await putLayout.mutateAsync({ items, expectedRevision: revision })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await layout.refetch()
          return
        }
        throw err
      }
    },
    [layout, putLayout],
  )

  const onUpdate = useCallback(
    (items: LayoutItem[]) => {
      void persist(items)
    },
    [persist],
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = merged.findIndex((i) => i.id === active.id)
    const newIndex = merged.findIndex((i) => i.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const normalized = active.id.toString().startsWith('section:')
      ? reorderSectionDrop(merged, oldIndex, newIndex)
      : arrayMove(merged, oldIndex, newIndex)
    if (normalized === null) return

    setAnnouncement(`Moved ${labelFor(active.id.toString(), itemLabels)}`)
    void persist(normalized)
  }

  const saveAsDefault = useCallback(async () => {
    try {
      await putDefault.mutateAsync({
        items: merged,
        expectedRevision: layout.data?.defaultRevision ?? 0,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await layout.refetch()
        return
      }
      throw err
    }
  }, [putDefault, merged, layout])

  const visible = displayOrder(merged)
  const hidden = hiddenCount(merged)

  const renderNode = (item: LayoutItem) => {
    if (item.id === 'widget:health') return renderHealth()
    if (item.id === 'widget:ribbon') return renderRibbon()
    if (item.id === 'widget:needs') return renderNeeds()
    if (item.id === 'widget:unreported') return renderUnreported()
    if (item.id.startsWith('section:')) return renderSection(item.id.slice('section:'.length))
    if (item.id.startsWith('metric:')) return renderMetric(item.id.slice('metric:'.length))
    return null
  }

  return (
    <div className="mt-6">
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm hover:bg-cream"
          onClick={() => void persist(fallback)}
        >
          Reset layout
        </button>
        {isAdmin && (
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm hover:bg-cream"
            onClick={() => void saveAsDefault()}
          >
            Save as default
          </button>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm hover:bg-cream"
            onClick={() => void persist(restoreNextHidden(merged))}
          >
            Hidden ({hidden})
          </button>
        )}
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="grid gap-4 sm:grid-cols-2">
            {visible.map((item) => {
              const label = labelFor(item.id, itemLabels)
              const node = renderNode(item)
              if (!node) return null
              const span = item.size === 'wide' ? 'sm:col-span-2' : ''
              const isMetric = item.id.startsWith('metric:')
              return (
                <div key={item.id} className={span}>
                  <SortableTile
                    id={item.id}
                    item={item}
                    label={label}
                    onUpdate={onUpdate}
                    allItems={merged}
                  >
                    {isMetric ? (
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/70">
                          {metricCategories[item.id.slice('metric:'.length)] ?? ''}
                        </p>
                        {node}
                      </div>
                    ) : (
                      node
                    )}
                  </SortableTile>
                </div>
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}
