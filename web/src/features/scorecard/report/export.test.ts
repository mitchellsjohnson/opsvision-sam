import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { tenant } from '../../../test/fixtures'
import { reportDocument, reportView } from '../../../test/reportFixtures'
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

  it('keeps going when text has characters the standard font cannot draw', async () => {
    const model = fixtureModel()
    model.summary = 'Targets ▲ met → next 目標'
    const pdf = await PDFDocument.load(await buildPdf(model))
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4)
  })
})
