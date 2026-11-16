import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { tenant } from '../../../test/fixtures'
import { reportDocument, reportView, reportViewWithUptime } from '../../../test/reportFixtures'
import { buildReportModel, type ReportModel } from './model'
import { buildPdf } from './pdf'
import { buildPptx } from './pptx'

function fixtureModel(edit?: (doc: ReturnType<typeof reportDocument>) => void): ReportModel {
  const doc = reportDocument({ view: reportView() })
  edit?.(doc)
  return buildReportModel({
    doc,
    scorecardName: 'Main scorecard',
    companyName: 'Example Co',
    scope: '',
    scopeName: '',
    scopeSubjects: [],
    period: '2026-M10',
    fiscalYearStartMonth: 1,
    scale: tenant.statusScale,
    layout: null,
    statusLine: 'Month to date, as of Nov 2, 2026',
  })
}

/** The entries of a zip whose files are stored uncompressed, by name. */
function storedZipEntries(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const out = new Map<string, string>()
  let at = 0
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true)
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extraLength = view.getUint16(at + 28, true)
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength))
    const start = at + 30 + nameLength + extraLength
    if (method !== 0) throw new Error(`${name} is compressed`)
    out.set(name, decoder.decode(bytes.subarray(start, start + size)))
    at = start + size
  }
  return out
}

/** Every string a PDF draws (`<hex> Tj`), from its deflated content streams, in order. */
async function pdfStrings(bytes: Uint8Array): Promise<string[]> {
  const raw = new TextDecoder('latin1').decode(bytes)
  const out: string[] = []
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    let end = raw.indexOf('endstream', start)
    while (end > start && (raw[end - 1] === '\n' || raw[end - 1] === '\r')) end--
    let content: string
    try {
      const inflated = new Response(bytes.slice(start, end)).body!.pipeThrough(new DecompressionStream('deflate'))
      content = new TextDecoder('latin1').decode(await new Response(inflated).arrayBuffer())
    } catch {
      continue
    }
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
      out.push(String.fromCharCode(...(t[1]!.match(/../g) ?? []).map((h) => parseInt(h, 16))))
    }
  }
  return out
}

function slides(entries: Map<string, string>, prefix: string): string[] {
  return [...entries.keys()]
    .filter((k) => k.startsWith(prefix) && k.endsWith('.xml'))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    .map((k) => entries.get(k)!)
}

describe('buildPptx', () => {
  it('writes a 16:9 deck whose needs-attention slide is titled with the metric', async () => {
    const bytes = await buildPptx(fixtureModel())
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK')
    const entries = storedZipEntries(bytes)
    expect(entries.get('ppt/presentation.xml')).toMatch(/<p:sldSz cx="9144000" cy="5143500"/)
    const deck = slides(entries, 'ppt/slides/slide')
    const metricSlide = deck.find((x) => x.includes('<a:t>On-time delivery</a:t>'))
    expect(metricSlide).toBeDefined()
    expect(metricSlide).toContain('Needs attention')
    // Cover, summary, one needs-attention metric, one other metric, one table, notes.
    expect(deck).toHaveLength(6)
  })

  it('words health on the summary slide as the Overview does, in the tenant’s labels', async () => {
    const deck = slides(storedZipEntries(await buildPptx(fixtureModel())), 'ppt/slides/slide')
    const summary = deck.find((x) => x.includes('<a:t>Executive summary</a:t>'))!
    expect(summary).toContain('<a:t>1 Yellow   ·   1 Not reported</a:t>')
    expect(summary).not.toMatch(/On track|Watch|Off track/)
  })

  it('draws line metrics as native charts and status kinds as a table of period, value, and letter', async () => {
    const entries = storedZipEntries(
      await buildPptx(
        fixtureModel((doc) => {
          for (const row of doc.view.rows.filter((r) => r.metricKey === 'defect_rate')) row.chartKind = 'uptime'
        }),
      ),
    )
    const deck = slides(entries, 'ppt/slides/slide')
    const onTime = deck.find((x) => x.includes('<a:t>On-time delivery</a:t>'))!
    const defect = deck.find((x) => x.includes('<a:t>Defect rate</a:t>') && !x.includes('Scorecard table'))!
    expect(onTime).toContain('<c:chart ')
    expect(defect).not.toContain('<c:chart ')
    expect(defect).toContain('<a:t>Period</a:t>')
    expect(defect).toMatch(/<a:t>Aug 2026<\/a:t>[\s\S]*<a:t>4\.0<\/a:t>[\s\S]*<a:t>R<\/a:t>/)
  })

  it('puts the definition, or the name, and always the version id in the speaker notes, escaped once', async () => {
    const entries = storedZipEntries(
      await buildPptx(
        fixtureModel((doc) => {
          for (const row of doc.view.rows.filter((r) => r.metricKey === 'on_time_pct')) {
            row.definition = 'Closed on time & <before> due'
          }
        }),
      ),
    )
    const notes = slides(entries, 'ppt/notesSlides/notesSlide')
    const onTime = notes.find((x) => x.includes('Closed on time'))!
    expect(onTime).toContain('Closed on time &amp; &lt;before&gt; due')
    expect(onTime).not.toContain('&amp;amp;')
    expect(onTime).toContain('Methodology version: ver-1')
    expect(notes.find((x) => x.includes('Defect rate'))).toContain('Methodology version: ver-1')
  })

  it('draws a mostly n/a line metric as the period, value, and status table, not a chart', async () => {
    const entries = storedZipEntries(
      await buildPptx(
        fixtureModel((doc) => {
          for (const row of doc.view.rows.filter((r) => r.metricKey === 'defect_rate')) {
            row.chartKind = 'line'
            for (const c of row.cells) {
              if (!c.ytd && ['2026-M05', '2026-M06', '2026-M07'].includes(c.period)) {
                Object.assign(c, { value: null, display: '', status: '', naReason: 'No releases' })
              }
            }
          }
        }),
      ),
    )
    const defect = slides(entries, 'ppt/slides/slide').find((x) => x.includes('<a:t>Defect rate</a:t>') && !x.includes('Scorecard table'))!
    expect(defect).not.toContain('<c:chart ')
    expect(defect).toMatch(/<a:t>May 2026<\/a:t>[\s\S]*?<a:t>n\/a<\/a:t>/)
    expect(defect).toMatch(/<a:t>Aug 2026<\/a:t>[\s\S]*<a:t>4\.0<\/a:t>[\s\S]*<a:t>R<\/a:t>/)
  })

  it('adds a goal series only where months carry targets, never a flat line from the current target', async () => {
    const charts = (bytes: Uint8Array) => slides(storedZipEntries(bytes), 'ppt/charts/chart')
    const flat = charts(await buildPptx(fixtureModel()))
    expect(flat.length).toBeGreaterThan(0)
    expect(flat.join('')).not.toMatch(/<c:v>Goal/)
    const perMonth = charts(
      await buildPptx(
        fixtureModel((doc) => {
          const root = doc.view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
          for (const c of root.cells) if (!c.ytd) c.target = 90
        }),
      ),
    )
    expect(perMonth.join('')).toContain('<c:v>Goal</c:v>')
    const bars = charts(
      await buildPptx(
        fixtureModel((doc) => {
          for (const row of doc.view.rows.filter((r) => r.metricKey === 'on_time_pct')) {
            row.chartKind = 'money_plan'
            for (const c of row.cells) if (!c.ytd) c.target = 90
          }
        }),
      ),
    )
    expect(bars.join('')).toContain('<c:barChart>')
    expect(bars.join('')).not.toMatch(/<c:v>Goal/)
  })

  it('shrinks long metric names in slide titles and table cells', async () => {
    const long = 'Percentage of customer-reported production incidents resolved within the agreed service window'
    const deck = slides(
      storedZipEntries(
        await buildPptx(
          fixtureModel((doc) => {
            for (const row of doc.view.rows.filter((r) => r.metricKey === 'defect_rate')) row.metricName = long
          }),
        ),
      ),
      'ppt/slides/slide',
    )
    /** The font size of the run whose text is exactly `text`. */
    const runSize = (xml: string) =>
      Number(new RegExp(`<a:rPr[^>]*\\ssz="(\\d+)"[^>]*>(?:(?!</a:rPr>)[\\s\\S])*</a:rPr><a:t>${long}</a:t>`).exec(xml)![1])
    const metric = deck.find((x) => x.includes(`<a:t>${long}</a:t>`) && !x.includes('Scorecard table'))!
    expect(metric).toContain('<a:normAutofit/>')
    expect(runSize(metric)).toBeLessThan(2600)
    const table = deck.find((x) => x.includes('<a:t>Scorecard table</a:t>'))!
    expect(runSize(table)).toBeLessThan(1000)
  })

  it('paginates the notes by wrapped lines, not just by note count', async () => {
    const model = fixtureModel()
    model.notes.overrides = Array.from(
      { length: 6 },
      (_, i) => `Metric ${i + 1}, All units, Oct 2026: ${'restated after a reconciliation with the finance close that moved several entries '.repeat(3)}`,
    )
    const deck = slides(storedZipEntries(await buildPptx(model)), 'ppt/slides/slide')
    expect(deck.filter((x) => /<a:t>Notes( \(continued\))?<\/a:t>/.test(x)).length).toBeGreaterThanOrEqual(2)
  })

  it('answers an item metric with no company value with the worst service’s value and name, not "No value"', async () => {
    const deck = slides(
      storedZipEntries(
        await buildPptx(
          fixtureModel((doc) => {
            doc.view = reportViewWithUptime()
          }),
        ),
      ),
      'ppt/slides/slide',
    )
    const uptime = deck.filter((x) => x.includes('<a:t>Service uptime</a:t>') && !x.includes('Scorecard table'))
    // Red, so its one slide is in Needs attention.
    expect(uptime).toHaveLength(1)
    expect(uptime[0]).toContain('Needs attention')
    expect(uptime[0]).toContain('<a:t>99.20%</a:t>')
    expect(uptime[0]).toContain('Web service · worst of 2 services · 1 not reported')
    expect(uptime[0]).not.toContain('<a:t>No value</a:t>')
  })

  it('splits the table after 12 metric rows', async () => {
    const entries = storedZipEntries(
      await buildPptx(
        fixtureModel((doc) => {
          const template = doc.view.rows.find((r) => r.metricKey === 'defect_rate')!
          for (let i = 1; i <= 12; i++) {
            doc.view.rows.push({ ...template, metricKey: `extra_${i}`, metricName: `Extra metric ${i}` })
          }
        }),
      ),
    )
    const tables = slides(entries, 'ppt/slides/slide').filter((x) => x.includes('<a:t>Scorecard table'))
    expect(tables).toHaveLength(2)
    expect(tables[1]).toContain('Extra metric 12')
  })
})

describe('buildPdf', () => {
  it('writes a US Letter landscape PDF titled with the scorecard and month', async () => {
    const bytes = await buildPdf(fixtureModel())
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getTitle()).toBe('Main scorecard · Oct 2026')
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4)
    const { width, height } = pdf.getPage(0).getSize()
    expect([width, height]).toEqual([792, 612])
  })

  it('answers an item metric with no company value with the worst service’s value and name, not "No value"', async () => {
    const strings = await pdfStrings(
      await buildPdf(
        fixtureModel((doc) => {
          doc.view = reportViewWithUptime()
        }),
      ),
    )
    // The 28pt value on its one page, in Needs attention; the status table's cells read `99.20% R`.
    expect(strings.filter((s) => s === '99.20%')).toHaveLength(1)
    expect(strings).toContain('Web service · worst of 2 services · 1 not reported')
    // Only Defect rate, not measured in Oct, has no value.
    expect(strings.filter((s) => s === 'No value')).toHaveLength(1)
  })

  it('keeps going when text has characters the standard font cannot draw', async () => {
    const model = fixtureModel()
    model.summary = 'Targets ▲ met → next 目標'
    const pdf = await PDFDocument.load(await buildPdf(model))
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4)
  })
})
