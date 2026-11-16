import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { defaultStatusScale } from './charts/chartTheme'
import { buildTrendColumns } from './columns'
import { SVG_HEIGHT, SVG_WIDTH } from './exports'
import { itemGridCsv, itemGridSvg } from './itemExports'
import { buildItemRows } from './logic/itemGrid'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

const columns = buildTrendColumns('2026-M10', 1)
const scale = defaultStatusScale()

function cellOf(id: string, period: string, v: number | null | 'na'): Cell {
  const value = v === 'na' ? null : v
  return {
    metricKey: 'uptime',
    subjectId: id,
    period,
    ytd: false,
    value,
    display: value === null ? '' : `${value.toFixed(2)}%`,
    status: value === null ? '' : value >= 99.9 ? 'G' : value > 99.8 ? 'Y' : 'R',
    naReason: v === 'na' ? 'Planned maintenance' : '',
    components: {},
    coverage: [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
  }
}

function service(id: string, name: string, values: (number | null | 'na')[]): ViewRow {
  return {
    metricKey: 'uptime',
    metricName: 'Uptime',
    categoryId: 'eng',
    subjectId: id,
    subjectName: name,
    subjectKind: 'item',
    format: 'percent2',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'uptime',
    definition: '',
    cells: columns.map((c, i) => cellOf(id, c.period, i < values.length ? values[i]! : 99.95)),
  }
}

const eleven = (v: number | null | 'na') => Array.from({ length: 11 }, () => v)
const rows = buildItemRows(
  [
    service('hooks', 'Webhooks', [...eleven(99.95), 99.06]),
    service('rd', 'R&D <API>', ['na', ...eleven(99.99).slice(1), 99.99]),
    service('push', 'Push Gateway', [...eleven(99.98), null]),
  ],
  columns,
  scale,
  (id) => (id === 'hooks' ? 'Platform' : 'Unassigned'),
  1,
)

function parseCsv(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .map((line) => line.slice(1, -1).split('","'))
}

describe('itemGridCsv', () => {
  it('one row per item: name, group, a value per period, then the current status', () => {
    const csv = parseCsv(itemGridCsv(rows, columns))
    expect(csv[0]).toEqual(['name', 'group', ...columns.map((c) => c.period), 'status'])
    expect(csv).toHaveLength(4)
    expect(csv[1]).toEqual(['Webhooks', 'Platform', ...eleven(99.95).map(String), '99.06', 'R'])
    // n/a stays n/a; an unreported month is blank.
    expect(csv[2]!.slice(0, 3)).toEqual(['R&D <API>', 'Unassigned', 'n/a'])
    expect(csv[3]!.slice(-2)).toEqual(['', ''])
  })
})

describe('itemGridSvg', () => {
  const doc = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')

  it('a slide with the title, scope and range, a row per item and a cell per period', () => {
    const svg = itemGridSvg({ title: 'Uptime', scope: 'All of Example Co', rows, columns, scale })
    const d = doc(svg)
    expect(d.querySelector('parsererror')).toBeNull()
    const root = d.documentElement
    expect(root.getAttribute('width')).toBe(String(SVG_WIDTH))
    expect(root.getAttribute('height')).toBe(String(SVG_HEIGHT))
    expect(d.querySelector('[data-role="title"]')?.textContent).toBe('Uptime')
    expect(d.querySelector('[data-role="subtitle"]')?.textContent).toBe('All of Example Co · Nov 2025 – Oct 2026')
    expect([...d.querySelectorAll('[data-role="item-name"]')].map((n) => n.textContent)).toEqual(['Webhooks', 'R&D <API>', 'Push Gateway'])
    expect(d.querySelectorAll('[data-role="cell"]')).toHaveLength(36)
    expect(d.querySelectorAll('[data-role="x-label"]')).toHaveLength(12)
    expect([...d.querySelectorAll('[data-role="value"]')].map((n) => n.textContent)).toEqual(['99.06%', '99.99%', 'Not reported'])
    expect(d.querySelector('[data-role="legend"]')?.textContent).toContain('Red')
    // Literal colors only: CSS variables do not resolve in a saved file.
    expect(svg).not.toContain('var(')
    expect(svg).not.toContain('color-mix')
  })

  it('many items: as many rows as fit, then how many more', () => {
    const many = buildItemRows(
      Array.from({ length: 60 }, (_, i) => service(`s${i}`, `Service ${String(i).padStart(2, '0')}`, [])),
      columns,
      scale,
      () => '',
      1,
    )
    const d = doc(itemGridSvg({ title: 'Uptime', scope: 'All', rows: many, columns, scale }))
    const names = d.querySelectorAll('[data-role="item-name"]')
    expect(names.length).toBeLessThan(60)
    expect(d.querySelector('[data-role="more"]')?.textContent).toBe(`and ${60 - names.length} more`)
    const ys = [...d.querySelectorAll('[data-role="cell"]')].map((c) => Number(c.getAttribute('y')) + Number(c.getAttribute('height')))
    expect(Math.max(...ys)).toBeLessThanOrEqual(SVG_HEIGHT - 60)
  })
})
