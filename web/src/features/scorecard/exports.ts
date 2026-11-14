import type { components } from '../../api/schema'
import { letterUsesInkOnWhite } from '../../ui/contrast'
import { statusIntervals } from './charts/bands'
import type { Column } from './columns'
import { formatMetricValue, metricDecimals } from './format'
import { cellKey } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']
type Band = components['schemas']['Band']

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/**
 * One CSV field per RFC 4180, always quoted. Text that a spreadsheet would
 * run as a formula (starting with = + - @) gets a leading apostrophe; plain
 * numbers, negative ones included, are left as numbers.
 */
export function csvField(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value)
  if (/^[=+\-@]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** CSV with a UTF-8 byte order mark and CRLF line endings. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`
}

/** One line per subject and period of the chart's rows. */
export function chartCsv(columns: Column[], chartRows: ViewRow[]): string {
  const rows: (string | number | null)[][] = [['subject', 'period', 'value', 'status']]
  for (const row of chartRows) {
    for (const col of columns) {
      const cell = row.cells.find((c) => cellKey(c) === col.key)
      rows.push([row.subjectName, col.period, cell?.value ?? null, cell?.status ?? ''])
    }
  }
  return toCsv(rows)
}

/** Text safe inside XML element content and attribute values. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** The exported chart is 16:9, the shape of a slide. */
export const SVG_WIDTH = 1600
export const SVG_HEIGHT = 900
/** PNG pixels per SVG unit: 3200 by 1800, sharp on a projector. */
export const PNG_SCALE = 2
export const SVG_FONT = '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif'

const INK = '#1D2433'
const TITLE = '#111827'
const MUTED = '#4B5563'
const FAINT = '#6B7280'
const GRID = '#E5E7EB'
const AXIS = '#9CA3AF'
const LINE_COLORS = ['#3F33A8', '#0E7490', '#475569', '#A21CAF', '#1D4ED8']

const PAD = 64
const HEADER_HEIGHT = 148
const PLOT_TOP = 176
const PLOT_BOTTOM = 712
const BAND_GUTTER = 64
const LEGEND_Y = 806
const RULE_Y = 836
const FOOTER_Y = 870

export interface ChartSvgInput {
  /** The metric name. */
  title: string
  /** What the chart covers: a unit's name, or the whole company. */
  scope: string
  /** The restated methodology version's name; '' when as reported. */
  restatedUnder: string
  format: string
  columns: Column[]
  /** One line per row. */
  rows: ViewRow[]
  scale: StatusLevel[]
  exportedAt?: Date
}

interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

interface Point {
  i: number
  x: number
  y: number
  display: string
  status: string
  current: boolean
}

function n1(v: number): string {
  return String(Math.round(v * 10) / 10)
}

/** Roughly how wide a line of the export's sans-serif text runs. */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.56
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

interface TextOptions {
  size: number
  fill: string
  role?: string
  weight?: number
  anchor?: 'start' | 'middle' | 'end'
  /** A white outline so the text reads over lines and tints. */
  halo?: boolean
}

function svgText(x: number, y: number, content: string, o: TextOptions): string {
  const parts = [`x="${n1(x)}"`, `y="${n1(y)}"`, `font-size="${o.size}"`, `fill="${o.fill}"`]
  if (o.weight) parts.push(`font-weight="${o.weight}"`)
  if (o.anchor && o.anchor !== 'start') parts.push(`text-anchor="${o.anchor}"`)
  if (o.halo) parts.push('stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round" paint-order="stroke"')
  if (o.role) parts.push(`data-role="${o.role}"`)
  return `<text ${parts.join(' ')}>${xmlEscape(content)}</text>`
}

function statusColor(scale: StatusLevel[], status: string): string {
  const color = scale.find((s) => s.key === status)?.color
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : INK
}

/** A status letter drawn in its color on white, or ink when the color is too light to read. */
function letterColor(color: string): string {
  return letterUsesInkOnWhite(color) ? INK : color
}

/** A 1-2-5 axis over the values with about five steps, no finer than the format shows. */
function valueAxis(values: number[], format: string): { lo: number; hi: number; ticks: number[] } {
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 100
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  const raw = Math.max((max - min + 2 * pad) / 5, 10 ** -metricDecimals(format))
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * magnitude
  let lo = Math.floor((min - pad) / step) * step
  let hi = Math.ceil((max + pad) / step) * step
  if (min >= 0 && lo < 0) lo = 0
  if (format.startsWith('percent') && max <= 100 && hi > 100 && lo < 100) hi = 100
  const ticks: number[] = []
  for (let k = 0; lo + k * step <= hi + step * 1e-6; k++) ticks.push(Number((lo + k * step).toFixed(10)))
  return { lo, hi, ticks }
}

/** `yyyy-mm-dd` in local time. */
function localDate(d: Date): string {
  const pad2 = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * A slide-ready line chart (1600 by 900): a header with the metric and what
 * the chart covers, value axis and gridlines, month labels, the status bands
 * as tints lettered on the right, each point's status letter and value, the
 * goal as a dashed line, a legend and a dated footer. All text is escaped.
 */
export function chartSvg(input: ChartSvgInput): string {
  const { title, scope, restatedUnder, format, columns, rows, scale } = input
  const lastKey = columns[columns.length - 1]?.key ?? ''
  const currentCells = rows.map((r) => r.cells.find((c) => cellKey(c) === lastKey))
  const ruleCell = currentCells.find((c) => c?.rule)
  const bands: Band[] | undefined = ruleCell?.rule?.type === 'bands' ? ruleCell.rule.bands : undefined
  const target = currentCells.find((c) => c?.target != null)?.target ?? null

  const series = rows.map((row) =>
    columns.map((col) => {
      const cell = row.cells.find((c) => cellKey(c) === col.key)
      const value = cell && cell.naReason === '' && cell.value != null ? cell.value : null
      return { value, status: cell?.status ?? '', display: value === null ? '' : cell?.display || formatMetricValue(format, value) }
    }),
  )
  const values = series.flatMap((s) => s.map((p) => p.value).filter((v): v is number => v !== null))
  const { lo, hi, ticks } = valueAxis(target === null ? values : [...values, target], format)
  const tickLabels = ticks.map((t) => formatMetricValue(format, t))

  const plotLeft = PAD + Math.max(...tickLabels.map((t) => textWidth(t, 18)), 40) + 20
  const plotRight = SVG_WIDTH - PAD - BAND_GUTTER
  const plotWidth = plotRight - plotLeft
  const slot = plotWidth / Math.max(columns.length, 1)
  const xAt = (i: number) => plotLeft + slot * (i + 0.5)
  const yAt = (v: number) => PLOT_BOTTOM - ((v - lo) / (hi - lo || 1)) * (PLOT_BOTTOM - PLOT_TOP)

  const out: string[] = []
  out.push(`<rect data-role="background" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#FFFFFF" />`)

  // Header band: nothing in the plot reaches above PLOT_TOP.
  const range =
    columns.length > 1 ? `${columns[0]!.fullLabel} – ${columns[columns.length - 1]!.fullLabel}` : (columns[0]?.fullLabel ?? '')
  const subtitle = [scope, range, restatedUnder ? `restated under ${restatedUnder}` : 'as reported'].filter(Boolean).join(' · ')
  out.push(`<rect data-role="header" x="0" y="0" width="${SVG_WIDTH}" height="${HEADER_HEIGHT}" fill="#FFFFFF" />`)
  out.push(svgText(PAD, 78, title, { size: 40, weight: 600, fill: TITLE, role: 'title' }))
  out.push(svgText(PAD, 120, subtitle, { size: 22, fill: MUTED, role: 'subtitle' }))

  out.push(
    `<rect data-role="plot" x="${n1(plotLeft)}" y="${PLOT_TOP}" width="${n1(plotWidth)}" height="${PLOT_BOTTOM - PLOT_TOP}" fill="none" />`,
  )

  // Status bands, light tints under everything else.
  const intervals = statusIntervals(bands, [lo, hi])
  for (const b of intervals) {
    const top = yAt(b.y1)
    const color = statusColor(scale, b.status)
    out.push(
      `<rect data-band="${xmlEscape(b.status)}" x="${n1(plotLeft)}" y="${n1(top)}" width="${n1(plotWidth)}" height="${n1(yAt(b.y0) - top)}" fill="${color}" fill-opacity="0.08" />`,
    )
  }

  ticks.forEach((t, k) => {
    const y = yAt(t)
    out.push(`<line data-role="gridline" x1="${n1(plotLeft)}" x2="${n1(plotRight)}" y1="${n1(y)}" y2="${n1(y)}" stroke="${GRID}" stroke-width="1" />`)
    out.push(svgText(plotLeft - 16, y + 6, tickLabels[k]!, { size: 18, fill: FAINT, anchor: 'end', role: 'y-tick' }))
  })
  out.push(`<line x1="${n1(plotLeft)}" x2="${n1(plotRight)}" y1="${PLOT_BOTTOM}" y2="${PLOT_BOTTOM}" stroke="${AXIS}" stroke-width="1.5" />`)

  columns.forEach((col, i) => {
    out.push(svgText(xAt(i), PLOT_BOTTOM + 34, col.label, { size: 18, fill: MUTED, anchor: 'middle', role: 'x-label' }))
    const year = /(\d{4})$/.exec(col.fullLabel)?.[1]
    const prevYear = i > 0 ? /(\d{4})$/.exec(columns[i - 1]!.fullLabel)?.[1] : undefined
    if (year && col.label !== col.fullLabel && !col.label.includes(year) && year !== prevYear) {
      out.push(svgText(xAt(i), PLOT_BOTTOM + 56, year, { size: 14, fill: FAINT, anchor: 'middle', role: 'x-year' }))
    }
  })

  const single = rows.length === 1
  // Two years of months leaves about 54 units a point: smaller marks keep the labels apart.
  const dense = columns.length > 14
  const goalY = target === null ? null : yAt(target)
  if (goalY !== null) {
    out.push(
      `<line data-role="goal" x1="${n1(plotLeft)}" x2="${n1(plotRight)}" y1="${n1(goalY)}" y2="${n1(goalY)}" stroke="${INK}" stroke-width="2" stroke-dasharray="10 8" />`,
    )
  }

  // Lines, broken where a month has no value.
  const taken: Box[] = []
  const pointMarks: string[] = []
  series.forEach((points, s) => {
    const color = LINE_COLORS[s % LINE_COLORS.length]!
    const placed: Point[] = []
    points.forEach((p, i) => {
      if (p.value === null) return
      placed.push({ i, x: xAt(i), y: yAt(p.value), display: p.display, status: p.status, current: i === columns.length - 1 })
    })
    const segments: Point[][] = []
    for (const p of placed) {
      const last = segments[segments.length - 1]
      if (last && last[last.length - 1]!.i === p.i - 1) last.push(p)
      else segments.push([p])
    }
    const lines = segments
      .filter((seg) => seg.length > 1)
      .map(
        (seg) =>
          `<polyline fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" points="${seg.map((p) => `${n1(p.x)},${n1(p.y)}`).join(' ')}" />`,
      )
    out.push(`<g data-role="series" data-subject="${xmlEscape(rows[s]!.subjectName)}">${lines.join('')}</g>`)

    for (const p of placed) {
      const marker = statusColor(scale, p.status)
      const r = p.current ? 17 : dense ? 11 : 13
      const size = p.current ? 24 : dense ? 14 : 17
      const parts: string[] = []
      if (p.current) parts.push(`<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r + 9}" fill="${marker}" fill-opacity="0.18" />`)
      parts.push(`<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}" fill="${p.status ? marker : color}" stroke="#FFFFFF" stroke-width="3" />`)
      if (p.status) {
        parts.push(
          svgText(p.x, p.y + (p.current ? 6 : dense ? 4 : 5), p.status, {
            size: p.current ? 17 : dense ? 12 : 14,
            weight: 700,
            fill: letterUsesInkOnWhite(marker) ? INK : '#FFFFFF',
            anchor: 'middle',
            role: 'point-letter',
          }),
        )
      }
      taken.push({ x0: p.x - r, x1: p.x + r, y0: p.y - r, y1: p.y + r })
      if (single || p.current) {
        let y = p.y - r - 12
        // A label may rise into the gap above the plot, never into the header.
        if (y - size < HEADER_HEIGHT + 6) y = p.y + r + size + 6
        const w = textWidth(p.display, size)
        taken.push({ x0: p.x - w / 2, x1: p.x + w / 2, y0: y - size, y1: y })
        parts.push(
          svgText(p.x, y, p.display, { size, weight: p.current ? 700 : 600, fill: p.current ? TITLE : MUTED, anchor: 'middle', halo: true, role: 'value-label' }),
        )
      }
      pointMarks.push(`<g data-role="point" data-current="${p.current}">${parts.join('')}</g>`)
    }
  })
  out.push(...pointMarks)

  // The goal's label goes at whichever end of its line is clear of the points.
  if (goalY !== null && target !== null) {
    const label = `Goal ${formatMetricValue(format, target)}`
    const w = textWidth(label, 17)
    const spots = [
      { x: plotLeft + 10, y: goalY - 10 },
      { x: plotLeft + 10, y: goalY + 26 },
      { x: plotRight - 10 - w, y: goalY - 10 },
      { x: plotRight - 10 - w, y: goalY + 26 },
    ].filter((s) => s.y - 17 > PLOT_TOP && s.y < PLOT_BOTTOM)
    const spot =
      spots.find((s) => !taken.some((b) => overlaps(b, { x0: s.x, x1: s.x + w, y0: s.y - 17, y1: s.y + 4 }))) ??
      spots[0] ?? { x: plotLeft + 10, y: Math.max(goalY - 10, PLOT_TOP + 22) }
    out.push(svgText(spot.x, spot.y, label, { size: 17, weight: 600, fill: INK, halo: true, role: 'goal-label' }))
  }

  for (const b of intervals) {
    const color = statusColor(scale, b.status)
    const mid = (yAt(b.y0) + yAt(b.y1)) / 2
    out.push(`<rect x="${n1(plotRight + 14)}" y="${n1(mid - 16)}" width="36" height="32" rx="6" fill="${color}" fill-opacity="0.14" />`)
    out.push(svgText(plotRight + 32, mid + 6, b.status, { size: 18, weight: 700, fill: letterColor(color), anchor: 'middle', role: 'band-letter' }))
  }

  // Legend: the lines, the goal, then the bands best first.
  const legend: string[] = []
  let x = plotLeft
  const item = (swatch: string, label: string) => {
    legend.push(swatch)
    legend.push(svgText(x + 44, LEGEND_Y, label, { size: 18, fill: MUTED, role: 'legend-item' }))
    x += 44 + textWidth(label, 18) + 36
  }
  const swatchY = LEGEND_Y - 6
  rows.forEach((r, s) => {
    const color = LINE_COLORS[s % LINE_COLORS.length]!
    item(
      `<line x1="${n1(x)}" x2="${n1(x + 32)}" y1="${swatchY}" y2="${swatchY}" stroke="${color}" stroke-width="4" stroke-linecap="round" />`,
      single ? 'Value' : r.subjectName,
    )
  })
  if (target !== null) {
    item(
      `<line x1="${n1(x)}" x2="${n1(x + 32)}" y1="${swatchY}" y2="${swatchY}" stroke="${INK}" stroke-width="2" stroke-dasharray="8 5" />`,
      `Goal ${formatMetricValue(format, target)}`,
    )
  }
  const shown = new Set(intervals.map((b) => b.status))
  for (const level of [...scale].sort((a, b) => a.rank - b.rank)) {
    if (!shown.has(level.key)) continue
    const color = statusColor(scale, level.key)
    item(
      `<rect x="${n1(x + 4)}" y="${swatchY - 12}" width="24" height="24" rx="4" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-opacity="0.5" />`,
      `${level.key} ${level.label}`,
    )
  }
  out.push(`<g data-role="legend">${legend.join('')}</g>`)

  out.push(`<line x1="${PAD}" x2="${SVG_WIDTH - PAD}" y1="${RULE_Y}" y2="${RULE_Y}" stroke="${GRID}" stroke-width="1" />`)
  out.push(svgText(PAD, FOOTER_Y, `OpsVision · exported ${localDate(input.exportedAt ?? new Date())}`, { size: 16, fill: FAINT, role: 'footer' }))

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" font-family="${SVG_FONT}">
  <title>${xmlEscape(title)}</title>
  <desc>${xmlEscape(subtitle)}</desc>
  ${out.join('\n  ')}
</svg>`
}

/** Saves `body` as a file. The object URL is revoked on the next tick, after the download starts. */
export function downloadBlob(filename: string, mime: string, body: string | Blob) {
  const blob = body instanceof Blob ? body : new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** An SVG as a `data:` URL, which the app's CSP allows for images (`blob:` it does not). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Renders the SVG to a 2x PNG (3200 by 1800) and saves it. Rejects when the browser cannot. */
export async function metricPng(svg: string, filename: string): Promise<void> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('the chart image did not load'))
    img.src = svgDataUrl(svg)
  })
  const canvas = document.createElement('canvas')
  canvas.width = SVG_WIDTH * PNG_SCALE
  canvas.height = SVG_HEIGHT * PNG_SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.scale(PNG_SCALE, PNG_SCALE)
  ctx.drawImage(img, 0, 0, SVG_WIDTH, SVG_HEIGHT)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('no image')
  downloadBlob(filename, 'image/png', blob)
}
