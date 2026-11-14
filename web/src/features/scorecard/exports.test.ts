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
  const months: Column[] = ['07', '08', '09', '10'].map((m, i) => ({
    key: `2026-M${m}`,
    label: ['Jul', 'Aug', 'Sep', 'Oct'][i]!,
    fullLabel: `${['Jul', 'Aug', 'Sep', 'Oct'][i]!} 2026`,
    period: `2026-M${m}`,
    ytd: false,
  }))
  const bands = [
    { status: 'G', op: '>=', value: 90 },
    { status: 'Y', op: '>=', value: 80 },
    { status: 'R', op: '', value: 0 },
  ]
  const scale = [
    { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
    { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
    { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
  ]

  function onTime(subjectName = 'Unit A'): ViewRow {
    const values = [78, 84, 88.5, 92.5]
    const status = (v: number) => (v >= 90 ? 'G' : v >= 80 ? 'Y' : 'R')
    const base = row(subjectName, [0])
    return {
      ...base,
      format: 'percent1',
      cells: values.map((value, i) => ({
        ...base.cells[0]!,
        period: months[i]!.period,
        value,
        display: `${value.toFixed(1)}%`,
        status: status(value),
        target: 90,
        rule: { type: 'bands' as const, bands },
      })),
    }
  }

  function render(overrides: Partial<Parameters<typeof chartSvg>[0]> = {}) {
    const svg = chartSvg({
      title: 'On-time delivery',
      scope: 'Unit A',
      restatedUnder: '',
      format: 'percent1',
      columns: months,
      rows: [onTime()],
      scale,
      exportedAt: new Date(2026, 10, 13),
      ...overrides,
    })
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    const texts = (role: string) => [...doc.querySelectorAll(`[data-role="${role}"]`)].map((e) => e.textContent)
    const num = (el: Element | null, attr: string) => Number(el?.getAttribute(attr))
    return { svg, doc, texts, num }
  }

  it('is a 16:9 canvas on white in a system sans-serif font', () => {
    const { doc } = render()
    const root = doc.documentElement
    expect(root.getAttribute('viewBox')).toBe('0 0 1600 900')
    expect(root.getAttribute('font-family')).toBe('-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif')
    expect(doc.querySelector('[data-role="background"]')?.getAttribute('fill')).toBe('#FFFFFF')
  })

  it('has a title and a subtitle with scope, period range and version, in a header above the plot', () => {
    const { doc, texts, num } = render()
    expect(texts('title')).toEqual(['On-time delivery'])
    expect(texts('subtitle')).toEqual(['Unit A · Jul 2026 – Oct 2026 · as reported'])
    expect(render({ restatedUnder: 'FY27 proposal' }).texts('subtitle')[0]).toMatch(/· restated under FY27 proposal$/)
    const header = doc.querySelector('[data-role="header"]')
    const plot = doc.querySelector('[data-role="plot"]')
    const headerBottom = num(header, 'y') + num(header, 'height')
    expect(headerBottom).toBeLessThanOrEqual(num(plot, 'y'))
    for (const role of ['title', 'subtitle']) {
      expect(num(doc.querySelector(`[data-role="${role}"]`), 'y')).toBeLessThan(headerBottom)
    }
    // Nothing in the plot rises into the header.
    for (const el of doc.querySelectorAll('[data-role="value-label"], [data-role="point-letter"], [data-role="goal-label"]')) {
      expect(num(el, 'y')).toBeGreaterThan(headerBottom)
    }
  })

  it('formats y-axis ticks with the metric format and labels the months', () => {
    const { texts, doc } = render()
    const ticks = texts('y-tick')
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    for (const t of ticks) expect(t).toMatch(/^\d+\.\d%$/)
    expect(doc.querySelectorAll('[data-role="gridline"]')).toHaveLength(ticks.length)
    expect(texts('x-label')).toEqual(['Jul', 'Aug', 'Sep', 'Oct'])
    expect(render({ format: 'money_k', rows: [{ ...onTime(), format: 'money_k' }] }).texts('y-tick')[0]).toMatch(/^\$[\d,]+k$/)
  })

  it('draws the status bands from the band rule, each lettered on the right edge', () => {
    const { doc, num } = render()
    const rects = [...doc.querySelectorAll('rect[data-band]')]
    expect(rects.map((r) => r.getAttribute('data-band'))).toEqual(['R', 'Y', 'G'])
    for (const r of rects) expect(Number(r.getAttribute('fill-opacity'))).toBeLessThan(0.2)
    const letters = [...doc.querySelectorAll('[data-role="band-letter"]')]
    expect(letters.map((l) => l.textContent)).toEqual(['R', 'Y', 'G'])
    const plot = doc.querySelector('[data-role="plot"]')
    const plotRight = num(plot, 'x') + num(plot, 'width')
    for (const l of letters) expect(num(l, 'x')).toBeGreaterThan(plotRight)
  })

  it('labels every point with its status letter and value, emphasizes the current one, and draws the goal', () => {
    const { doc, texts } = render()
    expect(texts('point-letter')).toEqual(['R', 'Y', 'Y', 'G'])
    expect(texts('value-label')).toEqual(['78.0%', '84.0%', '88.5%', '92.5%'])
    const current = doc.querySelectorAll('[data-current="true"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.querySelector('[data-role="value-label"]')?.textContent).toBe('92.5%')
    const goal = doc.querySelector('[data-role="goal"]')
    expect(goal?.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(texts('goal-label')).toEqual(['Goal 90.0%'])
  })

  it('has a legend for the value, the goal and the bands, and a dated footer', () => {
    const { texts } = render()
    expect(texts('legend-item')).toEqual(['Value', 'Goal 90.0%', 'G Green', 'Y Yellow', 'R Red'])
    expect(texts('footer')).toEqual(['OpsVision · exported 2026-11-13'])
    expect(render({ rows: [onTime()].map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, target: null })) })) }).texts('legend-item')).not.toContain(
      'Goal 90.0%',
    )
  })

  it('names each line in the legend when there is more than one', () => {
    const { texts } = render({ rows: [onTime('Unit A'), { ...onTime('Unit B'), subjectId: 'b' }] })
    expect(texts('legend-item').slice(0, 2)).toEqual(['Unit A', 'Unit B'])
  })

  it('XML-escapes every piece of text', () => {
    expect(xmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;')
    const { svg, texts } = render({
      title: 'Cost <& "plan">',
      scope: 'R&D <east>',
      restatedUnder: `"Q3" <draft>`,
      rows: [onTime('R&D <east>'), { ...onTime('Ops'), subjectId: 'ops' }],
      scale: scale.map((s) => (s.key === 'G' ? { ...s, label: 'On <track>' } : s)),
    })
    expect(svg).toContain('<title>Cost &lt;&amp; &quot;plan&quot;&gt;</title>')
    expect(svg).toContain('>R&amp;D &lt;east&gt;</text>')
    expect(svg).not.toContain('R&D <east>')
    expect(svg).not.toContain('<track>')
    expect(texts('subtitle')[0]).toBe('R&D <east> · Jul 2026 – Oct 2026 · restated under "Q3" <draft>')
  })

  it('leaves gaps where a month has no value', () => {
    const r = onTime()
    r.cells[1] = { ...r.cells[1]!, value: null, display: '', status: '' }
    const { doc, texts } = render({ rows: [r] })
    expect(texts('value-label')).toEqual(['78.0%', '88.5%', '92.5%'])
    const lines = [...doc.querySelectorAll('[data-role="series"] polyline')]
    // Jul stands alone (a marker, no line); Sep–Oct is one segment.
    expect(lines).toHaveLength(1)
    expect(lines[0]!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(2)
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

  it('draws the SVG from a data: URL at 2x, 3200 by 1800, whatever the screen', async () => {
    const sources: string[] = []
    stubImage('load', sources)
    vi.stubGlobal('devicePixelRatio', 1)
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
    expect(size).toEqual([3200, 1800])
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
  })

  it('rejects when the image cannot load', async () => {
    stubImage('error', [])
    await expect(metricPng('<svg/>', 'm.png')).rejects.toThrow()
  })
})
