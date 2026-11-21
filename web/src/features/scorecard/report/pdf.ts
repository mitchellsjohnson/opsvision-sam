import type { PDFDocument, PDFFont, PDFPage, RGB } from 'pdf-lib'
import { letterUsesInkOnWhite } from '../../../ui/contrast'
import { formatMetricValue } from '../format'
import {
  appendixValue,
  exportChart,
  goalSeries,
  healthParts,
  metricFacts,
  metricValue,
  noteSections,
  showsSummary,
  statusTable,
  SUMMARY_LINKS_SHOWN,
  SUMMARY_NOT_WRITTEN,
  tableCellText,
  tableChunks,
  type ReportMetric,
  type ReportModel,
} from './model'
import { safeHref } from '../../rca/rcaText'

type Lib = typeof import('pdf-lib')

/** US Letter landscape, in points. */
const PAGE_W = 792
const PAGE_H = 612
const M = 40
const CONTENT_TOP = PAGE_H - 110
const CONTENT_BOTTOM = 56

const INK = '#1D2433'
const ACCENT = '#5B4BDB'
const MUTED = '#4B5563'
const FAINT = '#6B7280'
const RULE = '#E5E7EB'
const CREAM = '#FFF6E5'
/** The status-r token: a missing exec summary. */
const RED = '#B42318'
const SERIES_COLORS = ['#5B4BDB', '#0E7490', '#475569', '#A21CAF', '#1D4ED8']

interface Ctx {
  lib: Lib
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
  model: ReportModel
  /** Per font, whether the standard font can encode each character. */
  encodable: WeakMap<PDFFont, Map<string, boolean>>
}

function color(ctx: Ctx, hex: string): RGB {
  const ok = /^#[0-9a-f]{6}$/i.test(hex) ? hex : INK
  const n = parseInt(ok.slice(1), 16)
  return ctx.lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function statusHex(ctx: Ctx, status: string): string {
  return ctx.model.statusColors[status] ?? INK
}

/** The standard fonts encode WinAnsi only: other characters become `?` instead of failing the export. */
function drawable(ctx: Ctx, font: PDFFont, text: string): string {
  let cache = ctx.encodable.get(font)
  if (!cache) {
    cache = new Map()
    ctx.encodable.set(font, cache)
  }
  let out = ''
  for (const raw of text) {
    const ch = /\s/.test(raw) ? ' ' : raw
    let ok = cache.get(ch)
    if (ok === undefined) {
      try {
        font.encodeText(ch)
        ok = true
      } catch {
        ok = false
      }
      cache.set(ch, ok)
    }
    out += ok ? ch : '?'
  }
  return out
}

interface TextOptions {
  size: number
  font?: PDFFont
  color?: string
  align?: 'left' | 'right' | 'center'
  /** Shortens the text with an ellipsis to fit. */
  maxWidth?: number
}

function text(ctx: Ctx, page: PDFPage, x: number, y: number, content: string, o: TextOptions) {
  const font = o.font ?? ctx.font
  let s = drawable(ctx, font, content)
  if (o.maxWidth !== undefined && font.widthOfTextAtSize(s, o.size) > o.maxWidth) {
    while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, o.size) > o.maxWidth) s = s.slice(0, -1)
    s = `${s}…`
  }
  const w = font.widthOfTextAtSize(s, o.size)
  const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x
  page.drawText(s, { x: left, y, size: o.size, font, color: color(ctx, o.color ?? INK) })
}

/** Word-wrapped lines of `content` no wider than `width`. */
function wrap(ctx: Ctx, content: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of content.split(/\r?\n/)) {
    let line = ''
    for (const word of drawable(ctx, font, paragraph).split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next
        continue
      }
      if (line) lines.push(line)
      line = word
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line)
  }
  return lines
}

function newPage(ctx: Ctx, eyebrow: string, title: string): PDFPage {
  const page = ctx.doc.addPage([PAGE_W, PAGE_H])
  text(ctx, page, M, PAGE_H - 52, eyebrow, { size: 11, font: ctx.bold, color: ACCENT, maxWidth: PAGE_W - 2 * M })
  text(ctx, page, M, PAGE_H - 84, title, { size: 24, font: ctx.bold, maxWidth: PAGE_W - 2 * M })
  page.drawLine({ start: { x: M, y: 40 }, end: { x: PAGE_W - M, y: 40 }, thickness: 0.75, color: color(ctx, RULE) })
  text(ctx, page, M, 26, `OpsVision · ${ctx.model.title} · ${ctx.model.scopeLabel}`, { size: 9, color: FAINT, maxWidth: PAGE_W - 2 * M - 40 })
  text(ctx, page, PAGE_W - M, 26, String(ctx.doc.getPageCount()), { size: 9, color: FAINT, align: 'right' })
  return page
}

interface Line {
  text: string
  size: number
  font?: PDFFont
  color?: string
  indent?: number
  /** Space before the line. */
  gap?: number
  /** Points the next lines need on the same page; a line that would leave less starts a new page. */
  keep?: number
}

/** Writes wrapped lines from `y` down, continuing on new pages titled `continued`. */
function flow(ctx: Ctx, page: PDFPage, y: number, lines: Line[], continued: () => PDFPage): { page: PDFPage; y: number } {
  let cur = page
  let at = y
  for (const l of lines) {
    const font = l.font ?? ctx.font
    const indent = l.indent ?? 0
    at -= l.gap ?? 0
    if (l.keep && at - l.size * 1.35 - l.keep < CONTENT_BOTTOM) {
      cur = continued()
      at = CONTENT_TOP
    }
    for (const piece of wrap(ctx, l.text, font, l.size, PAGE_W - 2 * M - indent)) {
      if (at - l.size < CONTENT_BOTTOM) {
        cur = continued()
        at = CONTENT_TOP
      }
      at -= l.size * 1.35
      text(ctx, cur, M + indent, at, piece, { size: l.size, font, color: l.color })
    }
  }
  return { page: cur, y: at }
}

function coverPage(ctx: Ctx) {
  const { model } = ctx
  const page = ctx.doc.addPage([PAGE_W, PAGE_H])
  page.drawRectangle({ x: 0, y: 0, width: 14, height: PAGE_H, color: color(ctx, ACCENT) })
  text(ctx, page, 64, PAGE_H - 200, model.scorecardName, { size: 36, font: ctx.bold, maxWidth: PAGE_W - 128 })
  text(ctx, page, 64, PAGE_H - 240, `Monthly operating report · ${model.monthLabel}`, { size: 20, color: ACCENT })
  const info = [
    model.scopeLabel,
    model.companyName,
    model.statusLine,
    `Generated ${model.generatedLabel}`,
    `Methodology version: ${model.notes.versionIds.join(', ') || 'none'}`,
  ]
  info.forEach((line, i) => text(ctx, page, 64, PAGE_H - 300 - i * 22, line, { size: 14, color: MUTED, maxWidth: PAGE_W - 128 }))
}

function summaryPages(ctx: Ctx) {
  const { model } = ctx
  const page = newPage(ctx, model.monthLabel, 'Executive summary')
  const health = healthParts(model).join('   ·   ')
  const summary = model.summary ?? model.summaryFor ?? ''
  flow(
    ctx,
    page,
    CONTENT_TOP,
    [
      { text: health || 'No metrics reported', size: 15, font: ctx.bold },
      { text: summary || 'No summary written for this month.', size: 13, color: summary ? INK : MUTED, gap: 14 },
      ...model.facts.map((f, i) => ({ text: `•  ${f}`, size: 12, gap: i === 0 ? 14 : 2 })),
    ],
    () => newPage(ctx, model.monthLabel, 'Executive summary (continued)'),
  )
}

/** A 1-2-5 axis over the values with about five steps. */
function axis(values: number[]): { lo: number; hi: number; ticks: number[] } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15
  const raw = (max - min + 2 * pad) / 5
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * magnitude
  let lo = Math.floor((min - pad) / step) * step
  const hi = Math.ceil((max + pad) / step) * step
  if (min >= 0 && lo < 0) lo = 0
  const ticks: number[] = []
  for (let k = 0; lo + k * step <= hi + step * 1e-6; k++) ticks.push(Number((lo + k * step).toFixed(10)))
  return { lo, hi, ticks }
}

/** The metric's months as vector lines or bars, each point lettered with its status. */
function drawChart(ctx: Ctx, page: PDFPage, metric: ReportMetric, kind: 'line' | 'bar', box: { x: number; y: number; w: number; h: number }) {
  const series = metric.series.slice(0, SERIES_COLORS.length)
  const points = series[0]!.points
  const values = series.flatMap((s) => s.points.map((p) => p.value).filter((v): v is number => v !== null))
  const goal = goalSeries(metric)
  const { lo, hi, ticks } = axis([...values, ...(goal ?? []).filter((v): v is number => v !== null)])
  const plotLeft = box.x + 52
  const plotRight = box.x + box.w
  const plotBottom = box.y + 30
  const plotTop = box.y + box.h
  const slot = (plotRight - plotLeft) / Math.max(points.length, 1)
  const xAt = (i: number) => plotLeft + slot * (i + 0.5)
  const yAt = (v: number) => plotBottom + ((v - lo) / (hi - lo || 1)) * (plotTop - plotBottom)

  for (const t of ticks) {
    const y = yAt(t)
    page.drawLine({ start: { x: plotLeft, y }, end: { x: plotRight, y }, thickness: 0.5, color: color(ctx, RULE) })
    text(ctx, page, plotLeft - 6, y - 3, formatMetricValue(metric.format, t), { size: 8, color: FAINT, align: 'right' })
  }
  points.forEach((p, i) => text(ctx, page, xAt(i), plotBottom - 16, p.label, { size: 9, color: MUTED, align: 'center' }))

  if (goal) {
    for (let i = 1; i < goal.length; i++) {
      const a = goal[i - 1]
      const b = goal[i]
      if (a == null || b == null) continue
      page.drawLine({ start: { x: xAt(i - 1), y: yAt(a) }, end: { x: xAt(i), y: yAt(b) }, thickness: 1, color: color(ctx, INK), dashArray: [6, 4] })
    }
    const first = goal.findIndex((v, i) => v !== null && goal[i + 1] != null)
    text(ctx, page, xAt(first) - slot / 2 + 4, yAt(goal[first]!) + 4, 'Goal', { size: 9, font: ctx.bold })
  }

  series.forEach((s, si) => {
    const lineColor = SERIES_COLORS[si]!
    if (kind === 'bar') {
      const width = (slot * 0.6) / series.length
      const base = yAt(Math.max(lo, Math.min(0, hi)))
      s.points.forEach((p, i) => {
        if (p.value === null) return
        const x = xAt(i) - (slot * 0.6) / 2 + si * width
        const top = yAt(p.value)
        page.drawRectangle({ x, y: Math.min(base, top), width, height: Math.abs(top - base), color: color(ctx, p.status ? statusHex(ctx, p.status) : lineColor), opacity: 0.85 })
        if (p.status) text(ctx, page, x + width / 2, Math.max(base, top) + 4, p.status, { size: 9, font: ctx.bold, color: letterHex(ctx, p.status), align: 'center' })
      })
      return
    }
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!
      const b = s.points[i]!
      if (a.value === null || b.value === null) continue
      page.drawLine({ start: { x: xAt(i - 1), y: yAt(a.value) }, end: { x: xAt(i), y: yAt(b.value) }, thickness: 2, color: color(ctx, lineColor) })
    }
    s.points.forEach((p, i) => {
      if (p.value === null) return
      const current = i === s.points.length - 1
      const r = current ? 9 : 7
      const fill = p.status ? statusHex(ctx, p.status) : lineColor
      page.drawCircle({ x: xAt(i), y: yAt(p.value), size: r, color: color(ctx, fill), borderColor: color(ctx, '#FFFFFF'), borderWidth: 1.5 })
      if (p.status) {
        text(ctx, page, xAt(i), yAt(p.value) - (current ? 3.5 : 3), p.status, {
          size: current ? 10 : 8,
          font: ctx.bold,
          color: letterUsesInkOnWhite(fill) ? INK : '#FFFFFF',
          align: 'center',
        })
      }
      if (current || series.length === 1) {
        text(ctx, page, xAt(i), yAt(p.value) + r + 4, p.display, { size: current ? 11 : 8, font: current ? ctx.bold : ctx.font, color: current ? INK : MUTED, align: 'center' })
      }
    })
  })

  if (series.length > 1) {
    let x = plotLeft
    series.forEach((s, si) => {
      page.drawLine({ start: { x, y: box.y + 2 }, end: { x: x + 16, y: box.y + 2 }, thickness: 2, color: color(ctx, SERIES_COLORS[si]!) })
      text(ctx, page, x + 20, box.y - 1, s.subject, { size: 8, color: MUTED })
      x += 28 + ctx.font.widthOfTextAtSize(drawable(ctx, ctx.font, s.subject), 8) + 12
    })
  }
}

function letterHex(ctx: Ctx, status: string): string {
  const c = statusHex(ctx, status)
  return letterUsesInkOnWhite(c) ? INK : c
}

/** A status table (period, value, letter) with its top at `top`; returns the bottom. */
function drawStatusTable(ctx: Ctx, page: PDFPage, metric: ReportMetric, x: number, top: number, width: number, size: number): number {
  const { header, rows } = statusTable(metric)
  const rowH = size + 8
  const first = Math.min(width * 0.4, 110)
  const rest = (width - first) / Math.max(header.length - 1, 1)
  const colX = (i: number) => (i === 0 ? x : x + first + rest * (i - 1))
  const colW = (i: number) => (i === 0 ? first : rest)
  page.drawRectangle({ x, y: top - rowH, width, height: rowH, color: color(ctx, CREAM) })
  header.forEach((h, i) =>
    text(ctx, page, i === 0 ? colX(i) + 4 : colX(i) + colW(i) - 4, top - rowH + 5, h, { size, font: ctx.bold, align: i === 0 ? 'left' : 'right', maxWidth: colW(i) - 8 }),
  )
  let y = top - rowH
  for (const r of rows) {
    y -= rowH
    page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color: color(ctx, RULE) })
    r.cells.forEach((c, i) => {
      const letter = r.status !== '' && i === r.cells.length - 1
      text(ctx, page, i === 0 ? colX(i) + 4 : colX(i) + colW(i) - 4, y + 5, c, {
        size,
        font: letter ? ctx.bold : ctx.font,
        color: letter ? letterHex(ctx, r.status) : INK,
        align: i === 0 ? 'left' : 'right',
        maxWidth: colW(i) - 8,
      })
    })
  }
  return y
}

function metricPage(ctx: Ctx, metric: ReportMetric, attention: boolean) {
  const page = newPage(ctx, attention ? 'Needs attention' : metric.categoryName, metric.name)
  const kind = exportChart(metric)
  const left = { x: M, y: 80, w: 440, h: CONTENT_TOP - 90 }
  if (kind === 'table') drawStatusTable(ctx, page, metric, left.x, CONTENT_TOP, left.w, 12)
  else drawChart(ctx, page, metric, kind, left)

  const rx = 510
  const rw = PAGE_W - M - rx
  let y = CONTENT_TOP - 28
  text(ctx, page, rx, y, metricValue(metric) || 'No value', { size: 28, font: ctx.bold, maxWidth: rw })
  y -= 24
  if (metric.status) {
    text(ctx, page, rx, y, metric.status, { size: 14, font: ctx.bold, color: letterHex(ctx, metric.status) })
    text(ctx, page, rx + ctx.bold.widthOfTextAtSize(drawable(ctx, ctx.bold, metric.status), 14) + 6, y, metric.statusLabel, { size: 14 })
  } else {
    text(ctx, page, rx, y, 'Not reported', { size: 14, color: MUTED })
  }
  for (const f of metricFacts(metric)) {
    for (const line of wrap(ctx, f, ctx.font, 11, rw)) {
      y -= 16
      text(ctx, page, rx, y, line, { size: 11, color: MUTED })
    }
  }
  if (showsSummary(metric)) {
    drawSummary(ctx, page, metric, rx, y - 22, rw)
    return
  }
  if (kind !== 'table') drawStatusTable(ctx, page, metric, rx, y - 18, rw, 9)
}

/**
 * A metric page's exec summary under the facts: the text, byline, the first
 * three link titles and how many more the appendix lists, then the
 * attribution line. A missing summary prints only `Exec summary not written yet`.
 */
function drawSummary(ctx: Ctx, page: PDFPage, metric: ReportMetric, x: number, top: number, width: number) {
  const s = metric.summary!
  let y = top
  const line = (content: string, size: number, o: { font?: PDFFont; color?: string } = {}) => {
    for (const piece of wrap(ctx, content, o.font ?? ctx.font, size, width)) {
      if (y - size < CONTENT_BOTTOM) return
      y -= size * 1.35
      text(ctx, page, x, y, piece, { size, font: o.font, color: o.color })
    }
  }
  line('Exec summary', 10, { font: ctx.bold })
  if (s.state === 'missing' || !s.text) {
    line(SUMMARY_NOT_WRITTEN, 11, { font: ctx.bold, color: RED })
  } else {
    line(s.text, 11)
    const byline = [s.author, s.date].filter(Boolean).join(' · ')
    if (byline) line(byline, 9, { color: FAINT })
    const shown = s.links.slice(0, SUMMARY_LINKS_SHOWN)
    for (const l of shown) line(l.title, 10, { color: safeHref(l.url) ? ACCENT : INK })
    const more = s.linksTotal - shown.length
    if (more > 0) line(`+ ${more} more link${more === 1 ? '' : 's'} in the appendix`, 9, { color: MUTED })
  }
  if (s.attributionLine) {
    y -= 4
    line(`Attribution: ${s.attributionLine}`, 9, { color: MUTED })
  }
}

/** `Exec summaries · Oct 2026`: every summary of the month with each link's title and https URL (no annotations in v1). */
function appendixPages(ctx: Ctx) {
  const { model } = ctx
  if (model.execSummaries.length === 0) return
  const title = `Exec summaries · ${model.monthLabel}`
  const lines: Line[] = []
  model.execSummaries.forEach((n, i) => {
    lines.push({ text: [n.name, appendixValue(n)].filter(Boolean).join(' · '), size: 12, font: ctx.bold, gap: i === 0 ? 0 : 14, keep: 40 })
    if (n.text === null) lines.push({ text: SUMMARY_NOT_WRITTEN, size: 11, font: ctx.bold, color: RED, gap: 2 })
    else lines.push({ text: n.text, size: 11, gap: 2 })
    for (const l of n.links) {
      lines.push({ text: l.title, size: 10, indent: 8, gap: 4, keep: 14 })
      const href = safeHref(l.url)
      if (href) lines.push({ text: href, size: 9, color: MUTED, indent: 8 })
    }
  })
  flow(ctx, newPage(ctx, model.monthLabel, title), CONTENT_TOP, lines, () => newPage(ctx, model.monthLabel, `${title} (continued)`))
}

function tablePages(ctx: Ctx) {
  const { model } = ctx
  const first = model.columns[0]?.fullLabel ?? ''
  const last = model.columns.filter((c) => !c.ytd).at(-1)?.fullLabel ?? ''
  const metricW = 210
  const colW = (PAGE_W - 2 * M - metricW) / Math.max(model.columns.length, 1)
  const rowH = 28
  tableChunks(model).forEach((rows, i) => {
    const page = newPage(ctx, `${model.scopeLabel} · ${first} – ${last}`, i === 0 ? 'Scorecard table' : 'Scorecard table (continued)')
    let y = CONTENT_TOP
    page.drawRectangle({ x: M, y: y - rowH, width: PAGE_W - 2 * M, height: rowH, color: color(ctx, CREAM) })
    text(ctx, page, M + 6, y - rowH + 10, 'Metric', { size: 11, font: ctx.bold })
    model.columns.forEach((c, k) => text(ctx, page, M + metricW + colW * (k + 1) - 6, y - rowH + 10, c.label, { size: 11, font: ctx.bold, align: 'right' }))
    y -= rowH
    for (const r of rows) {
      y -= rowH
      page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.5, color: color(ctx, RULE) })
      text(ctx, page, M + 6, y + 10, r.name, { size: 11, maxWidth: metricW - 12 })
      r.cells.forEach((c, k) => {
        const right = M + metricW + colW * (k + 1) - 6
        const value = c.naReason ? 'n/a' : c.display || '—'
        if (!c.status) {
          text(ctx, page, right, y + 10, tableCellText(c), { size: 10, align: 'right', maxWidth: colW - 10 })
          return
        }
        const letterW = ctx.bold.widthOfTextAtSize(drawable(ctx, ctx.bold, c.status), 10)
        text(ctx, page, right, y + 10, c.status, { size: 10, font: ctx.bold, color: letterHex(ctx, c.status), align: 'right' })
        text(ctx, page, right - letterW - 4, y + 10, value, { size: 10, align: 'right', maxWidth: colW - letterW - 14 })
      })
    }
  })
}

function notesPages(ctx: Ctx) {
  const { model } = ctx
  const lines: Line[] = []
  noteSections(model).forEach((s, i) => {
    lines.push({ text: s.heading, size: 14, font: ctx.bold, gap: i === 0 ? 0 : 12 })
    for (const l of s.lines) lines.push({ text: `•  ${l}`, size: 11, color: MUTED, indent: 8, gap: 2 })
  })
  flow(ctx, newPage(ctx, model.monthLabel, 'Notes'), CONTENT_TOP, lines, () => newPage(ctx, model.monthLabel, 'Notes (continued)'))
}

/**
 * The report as a US Letter landscape PDF titled `<scorecard> · <month>`:
 * real text throughout, and charts drawn as vector lines with each point's
 * status letter.
 */
export async function buildPdf(model: ReportModel): Promise<Uint8Array> {
  const lib = await import('pdf-lib')
  const doc = await lib.PDFDocument.create()
  doc.setTitle(model.title, { showInWindowTitleBar: true })
  doc.setSubject(`Monthly operating report, ${model.scopeLabel}`)
  doc.setAuthor('OpsVision')
  doc.setCreator('OpsVision')
  doc.setLanguage('en-US')
  const ctx: Ctx = {
    lib,
    doc,
    font: await doc.embedFont(lib.StandardFonts.Helvetica),
    bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    model,
    encodable: new WeakMap(),
  }
  coverPage(ctx)
  summaryPages(ctx)
  const attention = new Set(model.needsAttention.map((m) => m.key))
  for (const m of model.needsAttention) metricPage(ctx, m, true)
  for (const c of model.categories) for (const m of c.metrics) if (!attention.has(m.key)) metricPage(ctx, m, false)
  tablePages(ctx)
  appendixPages(ctx)
  notesPages(ctx)
  return doc.save()
}
