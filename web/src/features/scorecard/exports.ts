import type { components } from '../../api/schema'
import type { Column } from './columns'
import { cellKey } from './viewHelpers'

type ViewRow = components['schemas']['ViewRow']

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

export const SVG_WIDTH = 600
export const SVG_HEIGHT = 240

/** A standalone line chart of the chart's rows with status letters at each point. */
export function chartSvg(title: string, columns: Column[], chartRows: ViewRow[]): string {
  const allValues = chartRows.flatMap((row) =>
    columns
      .map((col) => row.cells.find((c) => cellKey(c) === col.key)?.value)
      .filter((v): v is number => v != null),
  )
  const min = allValues.length ? Math.min(...allValues) : 0
  const max = allValues.length ? Math.max(...allValues) : 100
  const span = max - min || 1
  const strokes = ['#1D2433', '#5B4BDB', '#0E7490', '#B45309']
  const polylines: string[] = []
  const letters: string[] = []
  const legends: string[] = []
  chartRows.forEach((row, rowIndex) => {
    const points: Array<{ x: number; y: number; status: string }> = []
    columns.forEach((col, i) => {
      const cell = row.cells.find((c) => cellKey(c) === col.key)
      const v = cell?.value
      if (v == null) return
      const x = 40 + (i / Math.max(columns.length - 1, 1)) * 520
      const y = 200 - ((v - min) / span) * 160
      points.push({ x, y, status: cell?.status ?? '' })
    })
    if (points.length === 0) return
    const color = strokes[rowIndex % strokes.length]!
    polylines.push(
      `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" />`,
    )
    for (const p of points) {
      if (p.status) {
        letters.push(`<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" font-size="12">${xmlEscape(p.status)}</text>`)
      }
    }
    if (chartRows.length > 1) {
      legends.push(`<text x="20" y="${44 + rowIndex * 16}" font-size="12" fill="${color}">${xmlEscape(row.subjectName)}</text>`)
    }
  })
  const safeTitle = xmlEscape(title)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">
  <title>${safeTitle}</title>
  <rect width="100%" height="100%" fill="#FFFFFF" />
  <text x="20" y="24" font-size="16" font-weight="600">${safeTitle}</text>
  ${legends.join('\n  ')}
  ${polylines.join('\n  ')}
  ${letters.join('\n  ')}
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

/** Renders the SVG to a PNG at the screen's pixel ratio and saves it. Rejects when the browser cannot. */
export async function metricPng(svg: string, filename: string): Promise<void> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('the chart image did not load'))
    img.src = svgDataUrl(svg)
  })
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(SVG_WIDTH * ratio)
  canvas.height = Math.round(SVG_HEIGHT * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.scale(ratio, ratio)
  ctx.drawImage(img, 0, 0, SVG_WIDTH, SVG_HEIGHT)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('no image')
  downloadBlob(filename, 'image/png', blob)
}
