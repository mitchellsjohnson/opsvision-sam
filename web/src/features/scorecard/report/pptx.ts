import type PptxGenJS from 'pptxgenjs'
import { letterUsesInkOnWhite } from '../../../ui/contrast'
import {
  exportChart,
  metricFacts,
  metricNotes,
  noteSections,
  statusTable,
  tableCellText,
  tableChunks,
  type ReportMetric,
  type ReportModel,
} from './model'

type Slide = PptxGenJS.Slide
type TableRow = PptxGenJS.TableRow

const INK = '1D2433'
const ACCENT = '5B4BDB'
const MUTED = '4B5563'
const FAINT = '6B7280'
const RULE = 'E5E7EB'
const CREAM = 'FFF6E5'
const FONT = 'Arial'
const SERIES_COLORS = ['5B4BDB', '0E7490', '475569', 'A21CAF', '1D4ED8']
/** Notes lines per slide before the notes continue on another. */
const NOTES_LINES = 16
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

function header(slide: Slide, model: ReportModel, eyebrow: string, title: string) {
  slide.addText(eyebrow, { x: M, y: 0.25, w: W - 2 * M, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: ACCENT })
  slide.addText(title, { x: M, y: 0.55, w: W - 2 * M, h: 0.6, fontFace: FONT, fontSize: 26, bold: true, color: INK })
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
  const health = [
    ...model.health.map((h) => `${h.key} ${h.label} ${h.count}`),
    ...(model.notReported > 0 ? [`Not reported ${model.notReported}`] : []),
  ].join('   ·   ')
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

function metricSlide(pres: PptxGenJS, model: ReportModel, metric: ReportMetric, attention: boolean) {
  const slide = pres.addSlide()
  header(slide, model, attention ? 'Needs attention' : metric.categoryName, metric.name)
  const kind = exportChart(metric)
  const left = { x: M, y: 1.3, w: 5.8, h: 3.7 }
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
    const goal = series.length === 1 ? metric.goalValue : null
    const data = [
      // pptxgenjs writes a null value as a blank point; `displayBlanksAs: 'gap'` leaves it unjoined.
      ...series.map((s) => ({ name: series.length === 1 ? 'Value' : s.subject, labels, values: s.points.map((p) => p.value) as number[] })),
      ...(goal !== null ? [{ name: `Goal ${metric.goal}`, labels, values: labels.map(() => goal) }] : []),
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

  slide.addText(metric.display || 'No value', {
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
    const body: TableRow[] = rows.map((r) => [
      { text: r.name, options: { color: INK } },
      ...r.cells.map((c) => ({ text: tableCellText(c), options: { color: INK, align: 'right' as const } })),
    ])
    const metricW = 2.6
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

function notesSlides(pres: PptxGenJS, model: ReportModel) {
  const lines: { text: string; heading: boolean }[] = []
  for (const s of noteSections(model)) {
    lines.push({ text: s.heading, heading: true })
    for (const l of s.lines) lines.push({ text: l, heading: false })
  }
  for (let i = 0; i < lines.length; i += NOTES_LINES) {
    const slide = pres.addSlide()
    header(slide, model, model.monthLabel, i === 0 ? 'Notes' : 'Notes (continued)')
    slide.addText(
      lines.slice(i, i + NOTES_LINES).map((l) => ({
        text: l.text,
        options: l.heading ? { bold: true, color: INK, breakLine: true } : { color: MUTED, bullet: true, breakLine: true },
      })),
      { x: M, y: 1.3, w: W - 2 * M, h: 3.8, fontFace: FONT, fontSize: 12, valign: 'top' },
    )
    slide.addNotes(versionsNote(model))
  }
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
  notesSlides(pres, model)

  return (await pres.write({ outputType: 'uint8array' })) as Uint8Array
}
