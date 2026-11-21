import type PptxGenJS from 'pptxgenjs'
import { letterUsesInkOnWhite } from '../../../ui/contrast'
import type { components } from '../../../api/schema'
import {
  appendixValue,
  exportChart,
  goalSeries,
  healthParts,
  metricFacts,
  metricNotes,
  metricValue,
  noteSections,
  statusTable,
  SUMMARY_LINKS_SHOWN,
  SUMMARY_NOT_WRITTEN,
  showsSummary,
  tableCellText,
  tableChunks,
  type ExecSummaryNote,
  type ReportMetric,
  type ReportModel,
} from './model'
import { safeHref } from '../../rca/rcaText'

type RcaLink = components['schemas']['RcaLink']
type Slide = PptxGenJS.Slide
type TableRow = PptxGenJS.TableRow
type TextRun = PptxGenJS.TextProps

const INK = '1D2433'
const ACCENT = '5B4BDB'
const MUTED = '4B5563'
const FAINT = '6B7280'
const RULE = 'E5E7EB'
const CREAM = 'FFF6E5'
/** The status-r token: a missing exec summary. */
const RED = 'B42318'
const FONT = 'Arial'
/** The appendix table: where it starts, its columns (Metric, Value, Exec summary, Links) and type sizes. */
const APPENDIX_TOP = 1.3
const APPENDIX_COLS = [1.8, 0.9, 3.6, 2.7]
const APPENDIX_FONT = 9
const APPENDIX_LINK_FONT = 8
/** Table cell margins, inches: PowerPoint's Normal, set explicitly so the height estimate holds. */
const CELL_PAD_X = 0.1
const CELL_PAD_Y = 0.05
/** The appendix rows' room on a slide, inches: from under the header row to above the footer rule at 5.15. */
export const APPENDIX_ROOM = 5.05 - APPENDIX_TOP - ((APPENDIX_FONT * 1.2) / 72 + 2 * CELL_PAD_Y)
const SERIES_COLORS = ['5B4BDB', '0E7490', '475569', 'A21CAF', '1D4ED8']
/** Wrapped notes lines per slide before the notes continue on another. */
const NOTES_LINES = 16
const NOTES_FONT = 12
/** Slide width and margin, inches (16:9 is 10 by 5.625). */
const W = 10
const M = 0.5

function hex(color: string | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1).toUpperCase() : INK
}

/** A status letter's color: the tenant color, or ink when it is too light on white. */
function letterColor(model: ReportModel, status: string): string {
  const color = model.statusColors[status]
  return color && !letterUsesInkOnWhite(color) ? hex(color) : INK
}

function versionsNote(model: ReportModel): string {
  return `Methodology version: ${model.notes.versionIds.join(', ') || 'none'}`
}

/** About how many inches a line of Arial runs: a character averages a bit over half the font size. */
function textInches(text: string, fontSize: number): number {
  return (text.length * fontSize * 0.55) / 72
}

/**
 * The largest size, from `size` down to `min`, at which `text` fits on one
 * line `width` inches wide. pptxgenjs cannot measure text, and PowerPoint
 * applies "shrink on overflow" only once the box is edited.
 */
function fitSize(text: string, size: number, min: number, width: number): number {
  const fits = textInches(text, size) <= width ? size : Math.floor((size * width) / textInches(text, size))
  return Math.max(min, Math.min(size, fits))
}

/** About how many lines `text` wraps to in a box `width` inches wide. */
function wrappedLines(text: string, fontSize: number, width: number): number {
  return Math.max(1, Math.ceil(textInches(text, fontSize) / width))
}

function header(slide: Slide, model: ReportModel, eyebrow: string, title: string) {
  slide.addText(eyebrow, { x: M, y: 0.25, w: W - 2 * M, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: ACCENT, fit: 'shrink' })
  slide.addText(title, {
    x: M,
    y: 0.55,
    w: W - 2 * M,
    h: 0.6,
    fontFace: FONT,
    fontSize: fitSize(title, 26, 14, W - 2 * M - 0.2),
    bold: true,
    color: INK,
    fit: 'shrink',
  })
  slide.addShape('line', { x: M, y: 5.15, w: W - 2 * M, h: 0, line: { color: RULE, width: 1 } })
  slide.addText(`OpsVision · ${model.title} · ${model.scopeLabel}`, {
    x: M,
    y: 5.2,
    w: W - 2 * M,
    h: 0.3,
    fontFace: FONT,
    fontSize: 9,
    color: FAINT,
  })
}

function coverSlide(pres: PptxGenJS, model: ReportModel) {
  const slide = pres.addSlide()
  slide.background = { color: 'FFFFFF' }
  slide.addShape('rect', { x: 0, y: 0, w: 0.25, h: 5.625, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } })
  slide.addText(model.scorecardName, { x: 0.8, y: 1.2, w: 8.6, h: 0.9, fontFace: FONT, fontSize: 36, bold: true, color: INK })
  slide.addText(`Monthly operating report · ${model.monthLabel}`, {
    x: 0.8,
    y: 2.1,
    w: 8.6,
    h: 0.5,
    fontFace: FONT,
    fontSize: 20,
    color: ACCENT,
  })
  slide.addText(
    [
      model.scopeLabel,
      model.companyName,
      model.statusLine,
      `Generated ${model.generatedLabel}`,
      `Methodology version: ${model.notes.versionIds.join(', ') || 'none'}`,
    ].join('\n'),
    { x: 0.8, y: 2.9, w: 8.6, h: 1.8, fontFace: FONT, fontSize: 14, color: MUTED, valign: 'top' },
  )
  slide.addNotes(`Monthly operating report for ${model.scopeLabel}, ${model.monthLabel}. ${model.statusLine}.\n${versionsNote(model)}`)
}

function summarySlide(pres: PptxGenJS, model: ReportModel) {
  const slide = pres.addSlide()
  header(slide, model, model.monthLabel, 'Executive summary')
  const health = healthParts(model).join('   ·   ')
  slide.addText(health || 'No metrics reported', {
    x: M,
    y: 1.3,
    w: W - 2 * M,
    h: 0.4,
    fontFace: FONT,
    fontSize: 16,
    bold: true,
    color: INK,
  })
  const summary = model.summary ?? model.summaryFor ?? ''
  slide.addText(summary || 'No summary written for this month.', {
    x: M,
    y: 1.85,
    w: W - 2 * M,
    h: 1.5,
    fontFace: FONT,
    fontSize: 14,
    color: summary ? INK : MUTED,
    italic: !model.summary,
    valign: 'top',
    fill: { color: CREAM },
    margin: 8,
  })
  if (model.facts.length > 0) {
    slide.addText(
      model.facts.map((f) => ({ text: f, options: { bullet: true, breakLine: true } })),
      { x: M, y: 3.5, w: W - 2 * M, h: 1.5, fontFace: FONT, fontSize: 13, color: INK, valign: 'top' },
    )
  }
  slide.addNotes(`${model.summary ?? model.summaryFor ?? ''}\n${model.facts.join('\n')}\n${versionsNote(model)}`.trimStart())
}

function statusTableRows(model: ReportModel, metric: ReportMetric, fontSize: number): TableRow[] {
  const { header: head, rows } = statusTable(metric)
  const headCell = (text: string) => ({ text, options: { bold: true, color: INK, fill: { color: CREAM }, fontSize } })
  return [
    head.map(headCell),
    ...rows.map((r) =>
      r.cells.map((text, i) => ({
        text,
        options:
          r.status && i === r.cells.length - 1
            ? { bold: true, color: letterColor(model, r.status), fontSize, align: 'center' as const }
            : { color: INK, fontSize, align: i === 0 ? ('left' as const) : ('right' as const) },
      })),
    ),
  ]
}

/** A link title as a run: a hyperlink when its URL is https (`safeHref`), else plain text. */
function linkRun(title: string, url: string, fontSize?: number): TextRun {
  const href = safeHref(url)
  return { text: title, options: { ...(href ? { hyperlink: { url: href }, color: ACCENT } : { color: INK }), ...(fontSize ? { fontSize } : {}) } }
}

/**
 * The metric slide's `Exec summary` box: the text, byline and first three
 * links, then how many more the appendix lists. A missing summary prints
 * only `Exec summary not written yet`.
 */
function summaryRuns(metric: ReportMetric): TextRun[] {
  const s = metric.summary!
  if (s.state === 'missing' || !s.text) return [{ text: SUMMARY_NOT_WRITTEN, options: { color: RED, bold: true } }]
  const runs: TextRun[] = [{ text: s.text, options: { color: INK, breakLine: true } }]
  const byline = [s.author, s.date].filter(Boolean).join(' · ')
  if (byline) runs.push({ text: byline, options: { color: FAINT, fontSize: 9, breakLine: true } })
  const shown = s.links.slice(0, SUMMARY_LINKS_SHOWN)
  shown.forEach((l, i) => {
    if (i > 0) runs.push({ text: ' · ', options: { color: MUTED } })
    runs.push(linkRun(l.title, l.url))
  })
  const more = s.linksTotal - shown.length
  if (more > 0) runs.push({ text: ` · + ${more} more link${more === 1 ? '' : 's'} in the appendix`, options: { color: MUTED } })
  return runs
}

function metricSlide(pres: PptxGenJS, model: ReportModel, metric: ReportMetric, attention: boolean) {
  const slide = pres.addSlide()
  header(slide, model, attention ? 'Needs attention' : metric.categoryName, metric.name)
  const kind = exportChart(metric)
  const summary = showsSummary(metric)
  // With an exec summary, the right column holds it and the facts move under the chart.
  const left = { x: M, y: 1.3, w: 5.8, h: summary ? 3.2 : 3.7 }
  const right = { x: 6.6, w: W - M - 6.6 }

  if (kind === 'table') {
    slide.addTable(statusTableRows(model, metric, 11), {
      ...left,
      h: undefined,
      fontFace: FONT,
      border: { type: 'solid', pt: 0.5, color: RULE },
      autoPage: false,
    })
  } else {
    const series = metric.series.slice(0, SERIES_COLORS.length)
    const labels = series[0]!.points.map((p) => p.label)
    const goal = goalSeries(metric)
    const data = [
      // pptxgenjs writes a null value as a blank point; `displayBlanksAs: 'gap'` leaves it unjoined.
      ...series.map((s) => ({ name: series.length === 1 ? 'Value' : s.subject, labels, values: s.points.map((p) => p.value) as number[] })),
      ...(goal ? [{ name: 'Goal', labels, values: goal as number[] }] : []),
    ]
    slide.addChart(kind === 'bar' ? pres.ChartType.bar : pres.ChartType.line, data, {
      ...left,
      altText: `${metric.name}, ${labels[0]} to ${labels[labels.length - 1]}: ${series
        .map((s) => s.points.map((p) => `${p.label} ${p.display || 'no data'}${p.status ? ` ${p.status}` : ''}`).join(', '))
        .join('; ')}`,
      chartColors: [...SERIES_COLORS.slice(0, series.length), INK],
      barDir: 'col',
      displayBlanksAs: 'gap',
      lineDataSymbol: 'circle',
      lineDataSymbolSize: 8,
      lineSize: 2,
      showLegend: data.length > 1,
      legendPos: 'b',
      legendFontSize: 10,
      catAxisLabelFontSize: 10,
      valAxisLabelFontSize: 10,
      catAxisLabelColor: MUTED,
      valAxisLabelColor: MUTED,
      valGridLine: { color: RULE, size: 0.5 },
    })
  }

  slide.addText(metricValue(metric) || 'No value', {
    x: right.x,
    y: 1.3,
    w: right.w,
    h: 0.6,
    fontFace: FONT,
    fontSize: 28,
    bold: true,
    color: INK,
  })
  slide.addText(
    metric.status
      ? [
          { text: metric.status, options: { bold: true, color: letterColor(model, metric.status) } },
          { text: ` ${metric.statusLabel}`, options: { color: INK } },
        ]
      : [{ text: 'Not reported', options: { color: MUTED } }],
    { x: right.x, y: 1.9, w: right.w, h: 0.35, fontFace: FONT, fontSize: 14 },
  )
  const facts = metricFacts(metric)
  if (summary) {
    if (facts.length > 0) {
      slide.addText(facts.join('   ·   '), { x: left.x, y: 4.55, w: left.w, h: 0.5, fontFace: FONT, fontSize: 10, color: MUTED, valign: 'top', fit: 'shrink' })
    }
    slide.addText('Exec summary', { x: right.x, y: 2.3, w: right.w, h: 0.22, fontFace: FONT, fontSize: 9, bold: true, color: INK, objectName: 'Exec summary label' })
    slide.addText(summaryRuns(metric), {
      x: right.x,
      y: 2.52,
      w: right.w,
      h: 1.6,
      fontFace: FONT,
      fontSize: 11,
      valign: 'top',
      fit: 'shrink',
      objectName: 'Exec summary',
    })
    const line = metric.summary!.attributionLine
    if (line) {
      slide.addText(
        [
          { text: 'Attribution: ', options: { bold: true } },
          { text: line, options: {} },
        ],
        { x: right.x, y: 4.15, w: right.w, h: 0.9, fontFace: FONT, fontSize: 9, color: MUTED, valign: 'top', fit: 'shrink', objectName: 'Attribution' },
      )
    }
    slide.addNotes(metricNotes(metric))
    return
  }
  if (facts.length > 0) {
    slide.addText(facts.join('\n'), { x: right.x, y: 2.3, w: right.w, h: 1.2, fontFace: FONT, fontSize: 11, color: MUTED, valign: 'top' })
  }
  if (kind !== 'table') {
    slide.addTable(statusTableRows(model, metric, 9), {
      x: right.x,
      y: 3.45,
      w: right.w,
      fontFace: FONT,
      border: { type: 'solid', pt: 0.5, color: RULE },
      rowH: 0.2,
      autoPage: false,
    })
  }
  slide.addNotes(metricNotes(metric))
}

function tableSlides(pres: PptxGenJS, model: ReportModel) {
  const chunks = tableChunks(model)
  const first = model.columns[0]?.fullLabel ?? ''
  const last = model.columns.filter((c) => !c.ytd).at(-1)?.fullLabel ?? ''
  chunks.forEach((rows, i) => {
    const slide = pres.addSlide()
    header(slide, model, `${model.scopeLabel} · ${first} – ${last}`, i === 0 ? 'Scorecard table' : 'Scorecard table (continued)')
    const head: TableRow = [
      { text: 'Metric', options: { bold: true, fill: { color: CREAM }, color: INK } },
      ...model.columns.map((c) => ({ text: c.label, options: { bold: true, fill: { color: CREAM }, color: INK, align: 'right' as const } })),
    ]
    const metricW = 2.6
    const body: TableRow[] = rows.map((r) => [
      { text: r.name, options: { color: INK, fontSize: fitSize(r.name, 10, 7, metricW - 0.15) } },
      ...r.cells.map((c) => ({ text: tableCellText(c), options: { color: INK, align: 'right' as const } })),
    ])
    slide.addTable([head, ...body], {
      x: M,
      y: 1.3,
      w: W - 2 * M,
      colW: [metricW, ...model.columns.map(() => (W - 2 * M - metricW) / model.columns.length)],
      fontFace: FONT,
      fontSize: 10,
      rowH: 0.27,
      border: { type: 'solid', pt: 0.5, color: RULE },
      autoPage: false,
    })
    slide.addNotes(`Scorecard table at ${model.scopeLabel}, ${first} to ${last} and year to date.\n${versionsNote(model)}`)
  })
}

/** One appendix table row: a summary, or the rest of its links when they outgrow a slide (`continued`). */
export interface AppendixRow {
  note: ExecSummaryNote
  links: RcaLink[]
  continued: boolean
  /** The row's estimated height. */
  inches: number
}

/** Line height, inches, of single-spaced text at `fontSize`. */
function lineInches(fontSize: number): number {
  return (fontSize * 1.2) / 72
}

/** The estimated height of an appendix row, from its tallest cell. */
function appendixRowInches(note: ExecSummaryNote, links: RcaLink[], continued: boolean): number {
  const [metricW, valueW, textW, linksW] = APPENDIX_COLS.map((w) => w - 2 * CELL_PAD_X)
  const name = continued ? `${note.name} (continued)` : note.name
  const text = continued ? '' : (note.text ?? SUMMARY_NOT_WRITTEN)
  const lines9 = Math.max(
    wrappedLines(name, APPENDIX_FONT, metricW!),
    wrappedLines(appendixValue(note), APPENDIX_FONT, valueW!),
    text ? wrappedLines(text, APPENDIX_FONT, textW!) : 1,
  )
  const linkInches = links.reduce((h, l) => h + wrappedLines(l.title, APPENDIX_LINK_FONT, linksW!) * lineInches(APPENDIX_LINK_FONT), 0)
  return Math.max(lines9 * lineInches(APPENDIX_FONT), linkInches) + 2 * CELL_PAD_Y
}

/**
 * The appendix's rows in slides, by estimated height (pptxgenjs cannot
 * measure text and pages no table itself here): each slide's rows fit its
 * room under the header row. A summary whose links alone outgrow a slide
 * goes on in `continued` rows, so every link is listed, in order.
 */
export function appendixPages(notes: ExecSummaryNote[]): AppendixRow[][] {
  const rows: AppendixRow[] = []
  for (const note of notes) {
    let links: RcaLink[] = []
    let continued = false
    const push = () => {
      rows.push({ note, links, continued, inches: appendixRowInches(note, links, continued) })
      links = []
      continued = true
    }
    for (const l of note.links) {
      if (links.length > 0 && appendixRowInches(note, [...links, l], continued) > APPENDIX_ROOM) push()
      links.push(l)
    }
    push()
  }
  const pages: AppendixRow[][] = []
  let used = Infinity
  for (const r of rows) {
    if (used + r.inches > APPENDIX_ROOM) {
      pages.push([])
      used = 0
    }
    pages[pages.length - 1]!.push(r)
    used += r.inches
  }
  return pages
}

/** `Exec summaries · Oct 2026`: every summary of the month, as many a slide as fit, every link listed. */
function appendixSlides(pres: PptxGenJS, model: ReportModel) {
  const title = `Exec summaries · ${model.monthLabel}`
  const head = (text: string): PptxGenJS.TableCell => ({ text, options: { bold: true, fill: { color: CREAM }, color: INK } })
  appendixPages(model.execSummaries).forEach((rows, i) => {
    const slide = pres.addSlide()
    header(slide, model, model.monthLabel, i === 0 ? title : `${title} (continued)`)
    const body: TableRow[] = rows.map(({ note: n, links, continued }) => [
      { text: continued ? `${n.name} (continued)` : n.name, options: { color: INK, bold: true } },
      { text: appendixValue(n), options: { color: INK } },
      continued
        ? { text: '', options: { color: INK } }
        : n.text === null
          ? { text: SUMMARY_NOT_WRITTEN, options: { color: RED, bold: true } }
          : { text: n.text, options: { color: INK } },
      links.length === 0
        ? { text: '', options: { color: INK } }
        : {
            text: links.map((l, k) => {
              const run = linkRun(l.title, l.url, APPENDIX_LINK_FONT)
              return { text: run.text ?? '', options: { ...run.options, breakLine: k < links.length - 1 } }
            }),
            options: { color: INK },
          },
    ])
    slide.addTable([[head('Metric'), head('Value'), head('Exec summary'), head('Links')], ...body], {
      x: M,
      y: APPENDIX_TOP,
      w: W - 2 * M,
      colW: APPENDIX_COLS,
      fontFace: FONT,
      fontSize: APPENDIX_FONT,
      valign: 'top',
      margin: [CELL_PAD_Y, CELL_PAD_X, CELL_PAD_Y, CELL_PAD_X],
      border: { type: 'solid', pt: 0.5, color: RULE },
      autoPage: false,
    })
    slide.addNotes(`Exec summaries for ${model.monthLabel}, worst first. Every link is listed.\n${versionsNote(model)}`)
  })
}

function notesSlides(pres: PptxGenJS, model: ReportModel) {
  const lines: { text: string; heading: boolean }[] = []
  for (const s of noteSections(model)) {
    lines.push({ text: s.heading, heading: true })
    for (const l of s.lines) lines.push({ text: l, heading: false })
  }
  // A bullet's text starts about a third of an inch in.
  const width = W - 2 * M - 0.4
  const pages: (typeof lines)[] = []
  let used = NOTES_LINES
  for (const l of lines) {
    const rows = wrappedLines(l.text, NOTES_FONT, width)
    if (used + rows > NOTES_LINES) {
      pages.push([])
      used = 0
    }
    pages[pages.length - 1]!.push(l)
    used += rows
  }
  pages.forEach((page, i) => {
    const slide = pres.addSlide()
    header(slide, model, model.monthLabel, i === 0 ? 'Notes' : 'Notes (continued)')
    slide.addText(
      page.map((l) => ({
        text: l.text,
        options: l.heading ? { bold: true, color: INK, breakLine: true } : { color: MUTED, bullet: true, breakLine: true },
      })),
      { x: M, y: 1.3, w: W - 2 * M, h: 3.8, fontFace: FONT, fontSize: NOTES_FONT, valign: 'top', fit: 'shrink' },
    )
    slide.addNotes(versionsNote(model))
  })
}

/**
 * The report as a 16:9 deck: cover, summary, one slide per needs-attention
 * metric, one per other metric, the table (split after 12 metric rows), and
 * notes. Line and bar kinds are native charts; the other kinds a table.
 * pptxgenjs escapes all text it writes, notes included.
 */
export async function buildPptx(model: ReportModel): Promise<Uint8Array> {
  const { default: PptxGen } = await import('pptxgenjs')
  const pres = new PptxGen()
  pres.layout = 'LAYOUT_16x9'
  pres.title = model.title
  pres.subject = `Monthly operating report, ${model.scopeLabel}`
  pres.company = model.companyName
  pres.author = 'OpsVision'

  coverSlide(pres, model)
  summarySlide(pres, model)
  const attention = new Set(model.needsAttention.map((m) => m.key))
  for (const m of model.needsAttention) metricSlide(pres, model, m, true)
  for (const c of model.categories) for (const m of c.metrics) if (!attention.has(m.key)) metricSlide(pres, model, m, false)
  tableSlides(pres, model)
  appendixSlides(pres, model)
  notesSlides(pres, model)

  return (await pres.write({ outputType: 'uint8array' })) as Uint8Array
}
