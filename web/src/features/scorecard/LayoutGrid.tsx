import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { Check, EllipsisVertical, GripVertical, LayoutDashboard } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/errors'
import { useLayout, usePutDefaultLayout, usePutLayout } from '../../api/queries'
import type { components } from '../../api/schema'
import { menuItemHighlight } from '../../ui/focus'
import { useElementWidth } from '../../ui/useElementWidth'
import { CustomizeBar, LAYOUT_BUTTON } from './CustomizeBar'
import { applyLayout, defaultLayout, type LayoutCategory, type LayoutMetric } from './logic/layout'
import { moveBlock, reorderSectionDrop } from './logic/layoutReorder'

type LayoutItem = components['schemas']['LayoutItem']

export interface LayoutGridProps {
  scorecardId: string
  categories: LayoutCategory[]
  metricsByCategory: Record<string, LayoutMetric[]>
  isAdmin: boolean
  itemLabels: Record<string, string>
  /** Category names by metric key, for the eyebrow over a tile that is not under its own section. */
  metricCategories: Record<string, string>
  renderHealth: () => React.ReactNode
  renderRibbon: () => React.ReactNode
  renderNeeds: () => React.ReactNode
  renderUnreported: () => React.ReactNode
  renderSection: (categoryId: string) => React.ReactNode
  renderMetric: (metricKey: string) => React.ReactNode
  /** Places the `Customize layout` button, e.g. beside the page title; above the grid when absent. */
  renderHeaderActions?: (button: ReactNode) => ReactNode
}

const MOBILE_MAX_WIDTH = '(max-width: 767px)'
/** The toolbar's inset from the tile edge (right-2) plus room between it and the header. */
const TOOLBAR_GAP = 16
const PINNED = ['widget:health', 'widget:needs']

const ICON_BUTTON =
  'flex size-8 items-center justify-center rounded-md border border-ink/20 bg-white text-ink/80 hover:bg-cream hover:text-ink'
const MENU_ITEM = clsx(menuItemHighlight, 'flex h-8 cursor-default items-center justify-between gap-4 rounded px-2.5 text-sm')

/** Visible items in display order: Health, then Needs attention, pinned to the top. */
function displayOrder(items: LayoutItem[]): LayoutItem[] {
  const visible = items.filter((i) => !i.hidden)
  const pinned = PINNED.flatMap((id) => visible.filter((i) => i.id === id))
  return [...pinned, ...visible.filter((i) => !PINNED.includes(i.id))]
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
  if (id.startsWith('section:')) return id.slice('section:'.length)
  if (id.startsWith('metric:')) return id.slice('metric:'.length)
  return id
}

interface SortableTileProps {
  id: string
  item: LayoutItem
  label: string
  editing: boolean
  onUpdate: (next: LayoutItem[]) => void
  allItems: LayoutItem[]
  children: React.ReactNode
}

function SortableTile({ id, item, label, editing, onUpdate, allItems, children }: SortableTileProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  })
  // Published so a tile's header can keep clear of the toolbar over its top-right corner.
  const [toolbarRef, toolbarWidth] = useElementWidth<HTMLDivElement>()
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ['--tile-toolbar' as string]: editing ? `${Math.ceil(toolbarWidth) + TOOLBAR_GAP}px` : '0px',
  }

  const index = allItems.findIndex((i) => i.id === item.id)
  const apply = (mutator: (items: LayoutItem[]) => LayoutItem[]) => onUpdate(mutator([...allItems]))
  const setItem = (patch: Partial<LayoutItem>) => apply((items) => items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)))
  const isSection = item.id.startsWith('section:')
  const name = isSection ? `section ${label}` : label

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-layout-item={item.id}
      className={clsx(
        'relative h-full',
        editing && 'rounded-[10px] outline-2 outline-offset-[3px] outline-dashed outline-accent/45',
        isDragging && 'z-30 shadow-lg outline-solid outline-accent',
      )}
    >
      {editing && (
        <>
          <span className="pointer-events-none absolute -top-3 left-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-full bg-accent-deep px-2 py-0.5 text-[11px] font-semibold leading-4 text-white">
            {isSection ? `Section · ${label}` : `${label} · ${item.size === 'wide' ? 'Wide' : 'Small'}`}
          </span>
          <div ref={toolbarRef} className="absolute right-2 top-2 z-10 flex items-center gap-1">
            <button
              type="button"
              ref={setActivatorNodeRef}
              className={clsx(ICON_BUTTON, 'cursor-grab max-sm:hidden')}
              {...attributes}
              {...listeners}
              aria-label={`Move ${name}. Space to pick up`}
            >
              <GripVertical aria-hidden size={16} />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className={clsx(ICON_BUTTON, 'data-[state=open]:bg-cream')} aria-label={`Layout options for ${name}`}>
                <EllipsisVertical aria-hidden size={16} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 min-w-48 rounded-lg border border-ink/20 bg-white p-1 shadow-lg"
                >
                  {isSection ? (
                    <>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'up'))}>
                        Move section up
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'down'))}>
                        Move section down
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'top'))}>
                        Move section to top
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="my-1 h-px bg-ink/10" />
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setItem({ hidden: true })}>
                        Hide section header
                      </DropdownMenu.Item>
                    </>
                  ) : (
                    <>
                      <DropdownMenu.RadioGroup
                        value={item.size}
                        onValueChange={(size) => setItem({ size: size as LayoutItem['size'] })}
                      >
                        {(['small', 'wide'] as const).map((size) => (
                          <DropdownMenu.RadioItem key={size} value={size} className={MENU_ITEM}>
                            {size === 'small' ? 'Small' : 'Wide'}
                            <DropdownMenu.ItemIndicator>
                              <Check aria-hidden size={16} />
                            </DropdownMenu.ItemIndicator>
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setItem({ hidden: true })}>
                        Hide
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="my-1 h-px bg-ink/10" />
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'up'))}>
                        Move up
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'down'))}>
                        Move down
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => apply((items) => moveBlock(items, index, 'top'))}>
                        Move to top
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </>
      )}
      <div inert={editing} className={clsx('h-full', editing && 'opacity-70')}>
        {children}
      </div>
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
  renderHeaderActions,
}: LayoutGridProps) {
  const layout = useLayout(scorecardId)
  const putLayout = usePutLayout(scorecardId)
  const putDefault = usePutDefaultLayout(scorecardId)
  const [saveError, setSaveError] = useState('')
  const [editing, setEditing] = useState(false)
  const customizeRef = useRef<HTMLButtonElement>(null)
  // A tile picked up with the keyboard: Esc cancels the move, not the mode.
  const dragging = useRef(false)

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

  const leave = useCallback(() => {
    setEditing(false)
    customizeRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!editing) return
    // Radix menus and dialogs mark the Esc they handle with preventDefault.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dragging.current) return
      leave()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editing, leave])

  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const pointerActivation = pointerDrag
    ? { distance: 8 }
    : { distance: Number.MAX_SAFE_INTEGER }
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: pointerActivation })
  const sensors = useSensors(keyboardSensor, pointerSensor)

  const persist = useCallback(
    async (items: LayoutItem[]) => {
      const revision = layout.data?.revision ?? 0
      setSaveError('')
      try {
        await putLayout.mutateAsync({ items, expectedRevision: revision })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setSaveError('Someone else changed this layout. We reloaded it.')
          await layout.refetch()
          return
        }
        setSaveError(`We couldn’t save your layout, so we put it back. ${err instanceof Error ? err.message : ''}`.trim())
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
    dragging.current = false
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = merged.findIndex((i) => i.id === active.id)
    const newIndex = merged.findIndex((i) => i.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const normalized = active.id.toString().startsWith('section:')
      ? reorderSectionDrop(merged, oldIndex, newIndex)
      : arrayMove(merged, oldIndex, newIndex)
    if (normalized === null) return
    void persist(normalized)
  }

  const saveAsDefault = useCallback(async () => {
    setSaveError('')
    try {
      await putDefault.mutateAsync({
        items: merged,
        expectedRevision: layout.data?.defaultRevision ?? 0,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSaveError('Someone else changed the default layout. We reloaded it; try again.')
        await layout.refetch()
        return
      }
      setSaveError(`We couldn’t save the default layout. ${err instanceof Error ? err.message : ''}`.trim())
    }
  }, [putDefault, merged, layout])

  const visible = displayOrder(merged)
  const hidden = hiddenCount(merged)

  const categoryOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const [categoryId, metrics] of Object.entries(metricsByCategory)) {
      for (const m of metrics) map.set(`metric:${m.key}`, categoryId)
    }
    return map
  }, [metricsByCategory])

  const name = (id: UniqueIdentifier) => labelFor(id.toString(), itemLabels)
  const position = (id: UniqueIdentifier) => visible.findIndex((i) => i.id === id) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}. Position ${position(active.id)} of ${visible.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${name(active.id)} is at position ${position(over.id)} of ${visible.length}.` : `${name(active.id)} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${name(active.id)} at position ${position(over.id)} of ${visible.length}.` : `Dropped ${name(active.id)}.`,
    onDragCancel: ({ active }) => `Move cancelled. ${name(active.id)} is back at position ${position(active.id)} of ${visible.length}.`,
  }

  const renderNode = (item: LayoutItem) => {
    if (item.id === 'widget:health') return renderHealth()
    if (item.id === 'widget:ribbon') return renderRibbon()
    if (item.id === 'widget:needs') return renderNeeds()
    if (item.id === 'widget:unreported') return renderUnreported()
    if (item.id.startsWith('section:')) return renderSection(item.id.slice('section:'.length))
    if (item.id.startsWith('metric:')) return renderMetric(item.id.slice('metric:'.length))
    return null
  }

  const customize = (
    <button
      ref={customizeRef}
      type="button"
      className={LAYOUT_BUTTON}
      aria-pressed={editing}
      onClick={() => (editing ? leave() : setEditing(true))}
    >
      <LayoutDashboard aria-hidden size={16} />
      Customize layout
    </button>
  )

  // The section each visible item sits under, for the eyebrow of a tile moved out of its own.
  const sectionAbove = new Map<string, string>()
  let section = ''
  for (const item of visible) {
    if (item.id.startsWith('section:')) section = item.id.slice('section:'.length)
    else if (!item.id.startsWith('metric:')) section = ''
    sectionAbove.set(item.id, section)
  }

  return (
    <>
      {renderHeaderActions ? renderHeaderActions(customize) : <div className="mt-4 flex justify-end">{customize}</div>}
      <div className="mt-6">
        {saveError && (
          <p role="alert" className="mb-3 rounded-md border border-status-r bg-status-r-bg px-3 py-2 text-sm">
            {saveError}
          </p>
        )}
        {editing && (
          <CustomizeBar
            isAdmin={isAdmin}
            hidden={hidden}
            onReset={() => void persist(fallback)}
            onSaveDefault={() => void saveAsDefault()}
            onRestoreHidden={() => void persist(restoreNextHidden(merged))}
            onDone={leave}
          />
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable: 'Press Space to pick up. Use the arrow keys to move, Space to drop, Escape to cancel.',
            },
          }}
          onDragStart={() => (dragging.current = true)}
          onDragCancel={() => (dragging.current = false)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={visible.map((i) => i.id)} strategy={rectSortingStrategy}>
            <div className={clsx('grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2', editing && 'gap-y-6 pt-2')}>
              {visible.map((item) => {
                const node = renderNode(item)
                if (!node) return null
                const label = labelFor(item.id, itemLabels)
                const span = item.size === 'wide' ? 'sm:col-span-2' : ''
                const isMetric = item.id.startsWith('metric:')
                const metricKey = item.id.slice('metric:'.length)
                const eyebrow = isMetric && categoryOf.get(item.id) !== sectionAbove.get(item.id) ? (metricCategories[metricKey] ?? '') : ''
                return (
                  <div key={item.id} className={clsx('min-w-0', span)}>
                    <SortableTile
                      id={item.id}
                      item={item}
                      label={label}
                      editing={editing}
                      onUpdate={onUpdate}
                      allItems={merged}
                    >
                      {eyebrow ? (
                        <div className="flex h-full flex-col">
                          <p
                            data-eyebrow=""
                            className="mb-1 text-[11px] font-semibold uppercase leading-4 tracking-[0.04em] text-ink/70"
                          >
                            {eyebrow}
                          </p>
                          <div className="min-h-0 flex-1">{node}</div>
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
    </>
  )
}
