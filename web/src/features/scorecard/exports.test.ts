import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import type { Column } from './columns'
import { chartCsv, chartSvg, csvField, downloadBlob, metricPng, svgDataUrl, xmlEscape } from './exports'

type ViewRow = components['schemas']['ViewRow']

const columns: Column[] = [
  { key: '2026-M09', label: 'Sep', fullLabel: 'Sep 2026', period: '2026-M09', ytd: false },
  { key: '2026-M10', label: 'Oct', fullLabel: 'Oct 2026', period: '2026-M10', ytd: false },
]

function row(subjectName: string, values: (number | null)[]): ViewRow {
  return {
    metricKey: 'm',
    metricName: 'M',
    categoryId: 'c',
    subjectId: 's',
    subjectName,
    subjectKind: 'unit',
    format: 'number1',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'line',
    cells: values.map((value, i) => ({
      metricKey: 'm',
      subjectId: 's',
      period: columns[i]!.period,
      ytd: false,
      value,
      display: value == null ? '' : String(value),
      status: value == null ? '' : 'G',
      naReason: '',
      components: {},
      coverage: [1, 1],
      change: null,
      changeKind: '',
      target: null,
      versionId: 'v',
    })),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CSV', () => {
  it('quotes every field and doubles quotes (RFC 4180)', () => {
    expect(csvField('Unit "A", East')).toBe('"Unit ""A"", East"')
    expect(csvField(12.5)).toBe('"12.5"')
    expect(csvField(null)).toBe('""')
  })

  it('guards text a spreadsheet would run as a formula, but not plain numbers', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField('+1+1')).toBe(`"'+1+1"`)
    expect(csvField('-2+3')).toBe(`"'-2+3"`)
    expect(csvField('@SUM(A1)')).toBe(`"'@SUM(A1)"`)
    expect(csvField(-17)).toBe('"-17"')
  })

  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = chartCsv(columns, [row('=cmd|"/c calc"', [1, 2])])
    expect(csv.startsWith('\uFEFF"subject","period","value","status"\r\n')).toBe(true)
    expect(csv).toContain(`"'=cmd|""/c calc""","2026-M09","1","G"\r\n`)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})

describe('SVG', () => {
  it('XML-escapes every piece of text', () => {
    expect(xmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;')
    const svg = chartSvg('Cost <& "plan">', columns, [row('R&D <east>', [1, 2]), row('Ops', [3, 4])])
    expect(svg).toContain('<title>Cost &lt;&amp; &quot;plan&quot;&gt;</title>')
    expect(svg).toContain('>R&amp;D &lt;east&gt;</text>')
    expect(svg).not.toContain('R&D <east>')
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')).toBeNull()
  })

  it('is loaded as a data: URL, which the CSP allows for images', () => {
    const url = svgDataUrl('<svg>#</svg>')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(url).toContain('%23')
  })
})

describe('downloadBlob', () => {
  it('revokes the object URL after a tick, not before the click', () => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBlob('a.csv', 'text/csv', 'x')
    expect(create).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:x')
  })
})

describe('metricPng', () => {
  function stubImage(outcome: 'load' | 'error', sources: string[]) {
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(value: string) {
        sources.push(value)
        setTimeout(() => (outcome === 'load' ? this.onload?.() : this.onerror?.()), 0)
      }
    }
    vi.stubGlobal('Image', FakeImage)
  }

  it('draws the SVG from a data: URL at the device pixel ratio', async () => {
    const sources: string[] = []
    stubImage('load', sources)
    vi.stubGlobal('devicePixelRatio', 2)
    const ctx = { scale: vi.fn(), drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    let size = [0, 0]
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb) {
      size = [this.width, this.height]
      cb(new Blob(['png']))
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:png')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await metricPng('<svg/>', 'm.png')
    expect(sources[0]!.startsWith('data:image/svg+xml')).toBe(true)
    expect(size).toEqual([1200, 480])
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
  })

  it('rejects when the image cannot load', async () => {
    stubImage('error', [])
    await expect(metricPng('<svg/>', 'm.png')).rejects.toThrow()
  })
})
