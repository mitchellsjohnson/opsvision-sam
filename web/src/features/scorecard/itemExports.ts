import type { components } from '../../api/schema'
import { chartTheme, statusFill, TOKEN_TINTS } from './charts/chartTheme'
import type { Column } from './columns'
import { SVG_FONT, SVG_HEIGHT, SVG_WIDTH, toCsv, xmlEscape } from './exports'
import type { ItemRow } from './logic/itemGrid'
import { cellKey } from './viewHelpers'

type StatusLevel = components['schemas']['StatusLevel']

/** One row per item: name, group, a value per period (`n/a` when not applicable, blank when missing), then the current status. */
export function itemGridCsv(rows: ItemRow[], columns: Column[]): string {
  const out: (string | number | null)[][] = [['name', 'group', ...columns.map((c) => c.period), 'status']]
  for (const r of rows) {
    const values = columns.map((col) => {
      const cell = r.row.cells.find((c) => cellKey(c) === col.key)
      if (!cell) return null
      if (cell.naReason) return 'n/a'
      return cell.value ?? null
    })
    out.push([r.name, r.group, ...values, r.status])
  }
  return toCsv(out)
}

const INK = '#1D2433'
const TITLE = '#111827'
const MUTED = '#4B5563'
const FAINT = '#6B7280'
const RULE = '#E5E7EB'
const WHITE = '#FFFFFF'
const PAD = 64
const TABLE_TOP = 214
const TABLE_BOTTOM = SVG_HEIGHT - 72
const NAME_WIDTH = 380
const VALUE_WIDTH = 190
const ROW_MAX = 34
const ROW_MIN = 18

function n1(v: number): string {
  return String(Math.round(v * 10) / 10)
}

function text(x: number, y: number, content: string, o: { size: number; fill: string; role?: string; weight?: number; anchor?: 'middle' | 'end' }) {
  const parts = [`x="${n1(x)}"`, `y="${n1(y)}"`, `font-size="${o.size}"`, `fill="${o.fill}"`]
  if (o.weight) parts.push(`font-weight="${o.weight}"`)
  if (o.anchor) parts.push(`text-anchor="${o.anchor}"`)
  if (o.role) parts.push(`data-role="${o.role}"`)
  return `<text ${parts.join(' ')}>${xmlEscape(content)}</text>`
}

/** `hex` a share of the way from white: what the board's `color-mix(… 14%, white)` tint paints. */
function tint(hex: string): string {
  const token = TOKEN_TINTS[hex.toUpperCase()]
  if (token) return token.hex
  const ch = (i: number) =>
    Math.round(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) * 0.14 + 255 * 0.86)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

/** A status cell's fill, border and letter as literal colors: the board's tiers (soft, outlined, solid). */
function cellPaint(scale: StatusLevel[], status: string): { fill: string; stroke: string | null; letter: string } {
  const theme = chartTheme(scale, status)
  const color = /^#[0-9a-f]{6}$/i.test(theme.color) ? theme.color : INK
  const tier = statusFill(scale, status).tier
  if (tier === 'solid') return { fill: color, stroke: null, letter: theme.onColor.startsWith('#') ? theme.onColor : INK }
  return { fill: tint(color), stroke: tier === 'outline' ? color : null, letter: color }
}

/**
 * The item grid as a slide (1600 by 900): title, scope and range, the status
 * key, then a row per item in the given order with its name, group, a cell
 * per period and the selected period's value. Items that do not fit are
 * counted in a closing `and N more` line. All text is escaped.
 */
export function itemGridSvg(input: { title: string; scope: string; rows: ItemRow[]; columns: Column[]; scale: StatusLevel[] }): string {
  const { title, scope, rows, columns, scale } = input
  const range = columns.length > 1 ? `${columns[0]!.fullLabel} – ${columns[columns.length - 1]!.fullLabel}` : (columns[0]?.fullLabel ?? '')
  const subtitle = [scope, range].filter(Boolean).join(' · ')
  const out: string[] = []
  out.push(`<rect data-role="background" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${WHITE}" />`)
  out.push(text(PAD, 78, title, { size: 40, weight: 600, fill: TITLE, role: 'title' }))
  out.push(text(PAD, 120, subtitle, { size: 22, fill: MUTED, role: 'subtitle' }))

  // The status key, best first, then no data and n/a.
  const legend: string[] = []
  let lx = PAD
  const key = (swatch: string, label: string) => {
    legend.push(swatch, text(lx + 30, 166, label, { size: 18, fill: MUTED }))
    lx += 30 + label.length * 18 * 0.56 + 28
  }
  for (const level of [...scale].sort((a, b) => a.rank - b.rank)) {
    const p = cellPaint(scale, level.key)
    key(
      `<rect x="${lx}" y="150" width="22" height="22" rx="3" fill="${p.fill}"${p.stroke ? ` stroke="${p.stroke}"` : ''} />` +
        text(lx + 11, 166, level.key, { size: 13, weight: 700, fill: p.letter, anchor: 'middle' }),
      level.label,
    )
  }
  key(`<circle cx="${lx + 11}" cy="161" r="3" fill="${INK}" fill-opacity="0.35" />`, 'No data')
  key(`<rect x="${lx}" y="150" width="22" height="22" rx="3" fill="${WHITE}" stroke="${RULE}" />`, 'n/a')
  out.push(`<g data-role="legend">${legend.join('')}</g>`)

  const cellsLeft = PAD + NAME_WIDTH
  const slot = Math.min(64, (SVG_WIDTH - PAD * 2 - NAME_WIDTH - VALUE_WIDTH) / Math.max(columns.length, 1))
  const valueX = cellsLeft + slot * columns.length + VALUE_WIDTH - 10
  columns.forEach((col, i) => {
    out.push(text(cellsLeft + slot * (i + 0.5), TABLE_TOP - 12, col.label, { size: 16, fill: MUTED, anchor: 'middle', role: 'x-label' }))
  })
  out.push(text(valueX, TABLE_TOP - 12, columns[columns.length - 1]?.label ?? '', { size: 16, weight: 600, fill: MUTED, anchor: 'end' }))
  out.push(`<line x1="${PAD}" x2="${n1(valueX)}" y1="${TABLE_TOP - 4}" y2="${TABLE_TOP - 4}" stroke="${RULE}" />`)

  const room = TABLE_BOTTOM - TABLE_TOP
  const rowHeight = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(room / Math.max(rows.length, 1))))
  const fits = Math.floor(room / rowHeight)
  const shown = rows.length > fits ? rows.slice(0, fits - 1) : rows
  const cellHeight = Math.max(12, rowHeight - 6)
  const size = Math.min(18, rowHeight - 8)
  shown.forEach((r, k) => {
    const top = TABLE_TOP + k * rowHeight
    const mid = top + rowHeight / 2 + size * 0.35
    const parts: string[] = [text(PAD, mid, r.name, { size, weight: 500, fill: INK, role: 'item-name' })]
    if (r.group) parts.push(text(PAD + NAME_WIDTH - 16, mid, r.group, { size: size - 3, fill: FAINT, anchor: 'end' }))
    r.cells.forEach((c, i) => {
      const x = cellsLeft + slot * i + 2
      const y = top + (rowHeight - cellHeight) / 2
      const w = slot - 4
      const attrs = `data-role="cell" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(cellHeight)}" rx="3"`
      if (c.kind === 'status') {
        const p = cellPaint(scale, c.status)
        parts.push(`<rect ${attrs} fill="${p.fill}"${p.stroke ? ` stroke="${p.stroke}"` : ''} />`)
        if (cellHeight >= 14) parts.push(text(x + w / 2, y + cellHeight / 2 + 4.5, c.status, { size: 13, weight: 700, fill: p.letter, anchor: 'middle' }))
      } else if (c.kind === 'na') {
        parts.push(`<rect ${attrs} fill="${WHITE}" stroke="${RULE}" />`)
      } else if (c.kind === 'unrated') {
        parts.push(`<rect ${attrs} fill="${INK}" fill-opacity="0.06" />`)
      } else {
        parts.push(`<rect ${attrs} fill="none" />`, `<circle cx="${n1(x + w / 2)}" cy="${n1(y + cellHeight / 2)}" r="2.5" fill="${INK}" fill-opacity="0.35" />`)
      }
    })
    parts.push(
      text(valueX, mid, r.reported ? r.display || r.status : 'Not reported', {
        size,
        weight: r.reported ? 600 : 400,
        fill: r.reported ? INK : FAINT,
        anchor: 'end',
        role: 'value',
      }),
    )
    out.push(`<g data-role="item" data-id="${xmlEscape(r.id)}">${parts.join('')}</g>`)
  })
  if (shown.length < rows.length) {
    const y = TABLE_TOP + shown.length * rowHeight + rowHeight / 2 + size * 0.35
    out.push(text(PAD, y, `and ${rows.length - shown.length} more`, { size, fill: MUTED, role: 'more' }))
  }

  out.push(`<line x1="${PAD}" x2="${SVG_WIDTH - PAD}" y1="${SVG_HEIGHT - 52}" y2="${SVG_HEIGHT - 52}" stroke="${RULE}" />`)
  out.push(text(PAD, SVG_HEIGHT - 22, 'OpsVision', { size: 16, fill: FAINT, role: 'footer' }))

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" font-family="${SVG_FONT}">
  <title>${xmlEscape(title)}</title>
  <desc>${xmlEscape(subtitle)}</desc>
  ${out.join('\n  ')}
</svg>`
}
