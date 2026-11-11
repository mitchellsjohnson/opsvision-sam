import type { components } from '../../../api/schema'

export type LayoutItem = components['schemas']['LayoutItem']

export interface LayoutCategory {
  id: string
}

export interface LayoutMetric {
  key: string
}

function layoutItem(id: string, size: LayoutItem['size']): LayoutItem {
  return { id, size, hidden: false }
}

export function defaultLayout(
  categories: LayoutCategory[],
  metricsByCategory: Record<string, LayoutMetric[]>,
): LayoutItem[] {
  const items: LayoutItem[] = [
    layoutItem('widget:health', 'wide'),
    layoutItem('widget:ribbon', 'wide'),
    layoutItem('widget:needs', 'wide'),
  ]
  for (const category of categories) {
    items.push(layoutItem(`section:${category.id}`, 'wide'))
    const metrics = metricsByCategory[category.id] ?? []
    for (const metric of metrics) {
      items.push(layoutItem(`metric:${metric.key}`, 'small'))
    }
  }
  items.push(layoutItem('widget:unreported', 'wide'))
  return items
}

function categoryForMetric(metricId: string, fallback: LayoutItem[]): string {
  let current = ''
  for (const item of fallback) {
    if (item.id.startsWith('section:')) current = item.id.slice('section:'.length)
    if (item.id === metricId) return current
  }
  return ''
}

function sectionMemberIds(sectionId: string, fallback: LayoutItem[]): Set<string> {
  const members = new Set<string>([`section:${sectionId}`])
  let inSection = false
  for (const item of fallback) {
    if (item.id === `section:${sectionId}`) {
      inSection = true
      continue
    }
    if (inSection && item.id.startsWith('section:')) break
    if (inSection) members.add(item.id)
  }
  return members
}

function insertAfterSection(result: LayoutItem[], sectionId: string, fallback: LayoutItem[]): number {
  const members = sectionMemberIds(sectionId, fallback)
  let last = -1
  for (let i = 0; i < result.length; i++) {
    if (members.has(result[i]!.id)) last = i
  }
  if (last >= 0) return last
  const sectionIdx = result.findIndex((i) => i.id === `section:${sectionId}`)
  return sectionIdx >= 0 ? sectionIdx : result.length - 1
}

export function applyLayout(fallback: LayoutItem[], saved: LayoutItem[]): LayoutItem[] {
  const known = new Set(fallback.map((i) => i.id))
  const merged = saved.filter((i) => known.has(i.id))
  const present = new Set(merged.map((i) => i.id))

  const missing = fallback.filter((i) => !present.has(i.id))
  for (const item of missing) {
    if (item.id.startsWith('metric:')) {
      const sectionId = categoryForMetric(item.id, fallback)
      const at = insertAfterSection(merged, sectionId, fallback)
      merged.splice(at + 1, 0, item)
    } else {
      let insertAt = merged.length
      const fallbackIndex = fallback.findIndex((f) => f.id === item.id)
      for (let i = 0; i < merged.length; i++) {
        const idx = fallback.findIndex((f) => f.id === merged[i]!.id)
        if (idx > fallbackIndex) {
          insertAt = i
          break
        }
      }
      merged.splice(insertAt, 0, item)
    }
    present.add(item.id)
  }

  return merged
}
