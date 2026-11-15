import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../../api/schema'
import { buildView } from '../../../test/viewFixtures'
import { buildMonthTrendColumns, buildTrendColumns } from '../columns'
import { defaultStatusScale, LINE_COLORS } from './chartTheme'
import { buildPoints, ChartHoverCard, MetricChart, type ChartSize } from './MetricChart'

type ViewRow = components['schemas']['ViewRow']
type StatusLevel = components['schemas']['StatusLevel']

// A test sets `index` to open the tooltip at that column, as a hover would.
const hover = vi.hoisted(() => ({ index: undefined as number | undefined }))

// jsdom measures every element as 0 wide, so ResponsiveContainer draws
// nothing; give the chart a fixed size instead.
vi.mock('recharts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, { width: 300, height: 120 }) : null,
    Tooltip: (props: React.ComponentProps<typeof mod.Tooltip>) => <mod.Tooltip {...props} defaultIndex={hover.index} />,
  }
})

const CHART_WIDTH = 300
const columns = buildTrendColumns('2026-M10', 1)

beforeEach(() => {
  // Reduced motion: no animation, so labels draw at once.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom.
  delete window.matchMedia
  hover.index = undefined
})

function rowOf(metric: string, edit?: (row: ViewRow) => void, subjectId = 'root'): ViewRow {
  const q = new URLSearchParams()
  for (const c of columns) q.append('periods', c.period)
  const row = buildView(q).rows.find((r) => r.metricKey === metric && r.subjectId === subjectId)!
  edit?.(row)
  return row
}

function draw(row: ViewRow, opts: { size?: ChartSize; chartRows?: ViewRow[]; scale?: StatusLevel[] } = {}) {
  const current = row.cells.at(-1)!
  return render(
    <MemoryRouter>
      <MetricChart
        size={opts.size}
        row={row}
        chartRows={opts.chartRows}
        columns={columns}
        currentColumnKey="2026-M10"
        currentDisplay={current.display}
        currentStatus={current.status}
        statusLabel={() => undefined}
        scale={opts.scale ?? defaultStatusScale()}
        tableTo="/table"
      />
    </MemoryRouter>,
  )
}

const withBands = (r: ViewRow) => {
  r.cells.at(-1)!.rule = {
    type: 'bands',
    bands: [
      { status: 'G', op: '>=', value: 90 },
      { status: 'Y', op: '>=', value: 80 },
      { status: 'R', op: '', value: 0 },
    ],
  }
}

const ribbonCells = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-testid="status-ribbon"] > *')]
const SIZES: ChartSize[] = ['tile', 'focus']

describe('MetricChart status ribbon', () => {
  it.each(['ratio', 'discrete', 'money_plan'])('%s: one lettered cell per column under the plot, in both sizes', (kind) => {
    for (const size of SIZES) {
      const { container, unmount } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)), { size })
      const ribbon = screen.getByTestId('status-ribbon')
      expect(ribbon.getAttribute('aria-hidden')).toBe('true')
      expect(screen.getByTestId('metric-chart').compareDocumentPosition(ribbon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const cells = ribbonCells(container)
      expect(cells).toHaveLength(columns.length)
      expect(cells.map((c) => c.dataset.status)).toEqual([...Array<string>(11).fill('G'), 'Y'])
      // Tiles letter each cell; focus adds the shape.
      expect(cells.at(-1)!.textContent).toBe(size === 'focus' ? '▲Y' : 'Y')
      expect(cells[0]!.textContent).toBe(size === 'focus' ? '●G' : 'G')
      expect(ribbon.className).toContain(size === 'focus' ? 'h-[22px]' : 'h-[14px]')
      unmount()
    }
  })

  it('says n/a for a period not applicable and — for one with no data', () => {
    const { container } = draw(rowOf('defect_rate', (r) => (r.chartKind = 'discrete')))
    const cells = ribbonCells(container)
    expect(cells.map((c) => c.textContent).slice(-4)).toEqual(['G', 'R', '—', 'n/a'])
    expect(cells.map((c) => c.dataset.status).slice(-4)).toEqual(['G', 'R', 'missing', 'na'])
  })

  it('letters each cell in white or ink, whichever reads better on its fill', () => {
    const light: StatusLevel[] = [{ key: 'G', label: 'Green', color: '#F5D90A', rank: 1 }, ...defaultStatusScale().slice(1)]
    const { container } = draw(rowOf('on_time_pct'), { scale: light })
    const cells = ribbonCells(container)
    expect(cells[0]!.style.backgroundColor).toBe('rgb(245, 217, 10)')
    expect(cells[0]!.style.color).toBe('var(--color-ink)')
    expect(cells[11]!.style.backgroundColor).toBe('rgb(138, 90, 0)')
    expect(cells[11]!.style.color).toBe('rgb(255, 255, 255)')
  })

  it.each(SIZES)('%s: cells line up with the plotted line points', (size) => {
    hover.index = 0
    const { container } = draw(rowOf('on_time_pct'), { size })
    const ribbon = screen.getByTestId('status-ribbon')
    const left = parseFloat(ribbon.style.marginLeft)
    const right = parseFloat(ribbon.style.marginRight)
    const band = (CHART_WIDTH - left - right) / columns.length
    const center = (i: number) => left + (i + 0.5) * band
    expect(Number(container.querySelector('[data-current-dot]')!.getAttribute('cx'))).toBeCloseTo(center(11))
    expect(Number(container.querySelector('[data-role="active-dot"]')!.getAttribute('cx'))).toBeCloseTo(center(0))
    expect(Number(container.querySelector('[data-role="hairline"]')!.getAttribute('x1'))).toBeCloseTo(center(0))
    // Focus leaves room on the right for the value axis.
    if (size === 'focus') expect(right).toBeGreaterThan(left + 20)
  })

  it.each(['discrete', 'money_plan'])('%s: cells line up with the bars', (kind) => {
    hover.index = 3
    draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)), { size: 'focus' })
    const ribbon = screen.getByTestId('status-ribbon')
    const left = parseFloat(ribbon.style.marginLeft)
    const right = parseFloat(ribbon.style.marginRight)
    const band = (CHART_WIDTH - left - right) / columns.length
    const hairline = screen.getByTestId('metric-chart').querySelector('[data-role="hairline"]')!
    expect(Number(hairline.getAttribute('x1'))).toBeCloseTo(left + 3.5 * band)
  })
})

describe('MetricChart 24 months', () => {
  const months24 = buildMonthTrendColumns('2026-M10', 24, 1)

  function draw24(kind: string) {
    const q = new URLSearchParams()
    for (const c of months24) q.append('periods', c.period)
    const row = buildView(q).rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
    row.chartKind = kind
    return render(
      <MemoryRouter>
        <MetricChart
          size="focus"
          row={row}
          columns={months24}
          currentColumnKey="2026-M10"
          currentDisplay="84.3%"
          currentStatus="Y"
          statusLabel={() => undefined}
          scale={scale}
          tableTo="/table"
        />
      </MemoryRouter>,
    )
  }

  it('a line keeps each repeated month label its own column', () => {
    hover.index = 0
    const { container } = draw24('ratio')
    const ribbon = screen.getByTestId('status-ribbon')
    expect(ribbon.children).toHaveLength(24)
    const left = parseFloat(ribbon.style.marginLeft)
    const band = (CHART_WIDTH - left - parseFloat(ribbon.style.marginRight)) / 24
    expect(Number(container.querySelector('[data-current-dot]')!.getAttribute('cx'))).toBeCloseTo(left + 23.5 * band)
    expect(Number(container.querySelector('[data-role="active-dot"]')!.getAttribute('cx'))).toBeCloseTo(left + 0.5 * band)
    const labels = [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.every((l) => /^[A-Z][a-z]{2}$/.test(l ?? ''))).toBe(true)
  })

  it.each(['discrete', 'money_plan'])('%s: 24 bars, one per column', (kind) => {
    const { container } = draw24(kind)
    expect(container.querySelectorAll('.recharts-bar-rectangle path')).toHaveLength(24)
  })
})

describe('MetricChart line', () => {
  it('a tile with 12 points draws one dot, on the current point', () => {
    const { container } = draw(rowOf('on_time_pct'))
    expect(container.querySelectorAll('[data-current-dot]')).toHaveLength(1)
    expect(container.querySelectorAll('.recharts-line-dots circle')).toHaveLength(1)
    expect(container.querySelector('[data-status-dot], .point-letter, [data-role="value-label"]')).toBeNull()
  })

  it('a single series is a thin accent line over a soft accent gradient', () => {
    const tile = draw(rowOf('on_time_pct'))
    const curve = tile.container.querySelector('.recharts-line-curve')!
    expect(curve.getAttribute('stroke')).toBe('var(--color-accent)')
    expect(curve.getAttribute('stroke-width')).toBe('2')
    const fill = tile.container.querySelector('.recharts-area-area')?.getAttribute('fill') ?? ''
    expect(fill).toMatch(/^url\(#.+\)$/)
    const stops = [...tile.container.querySelectorAll(`linearGradient[id="${fill.slice(5, -1)}"] stop`)]
    expect(stops.map((s) => s.getAttribute('stop-color'))).toEqual(['var(--color-accent)', 'var(--color-accent)'])
    expect(stops.map((s) => s.getAttribute('stop-opacity'))).toEqual(['0.18', '0'])
    tile.unmount()

    const focus = draw(rowOf('on_time_pct'), { size: 'focus' })
    expect(focus.container.querySelector('.recharts-line-curve')!.getAttribute('stroke-width')).toBe('2.25')
  })

  it('has no axis or tick lines; the grid and value axis appear only in focus, the axis on the right', () => {
    const tile = draw(rowOf('on_time_pct'))
    expect(tile.container.querySelector('.recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line')).toBeNull()
    expect(tile.container.querySelector('.recharts-cartesian-grid')).toBeNull()
    expect(tile.container.querySelector('.recharts-yAxis')).toBeNull()
    tile.unmount()

    const { container } = draw(rowOf('on_time_pct'), { size: 'focus' })
    expect(container.querySelector('.recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line')).toBeNull()
    expect(container.querySelector('.recharts-cartesian-grid-vertical')).toBeNull()
    const grid = [...container.querySelectorAll('.recharts-cartesian-grid-horizontal line')]
    expect(grid.length).toBeGreaterThan(0)
    for (const line of grid) expect(Number(line.getAttribute('stroke-opacity'))).toBeLessThanOrEqual(0.05)
    const ticks = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')]
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) {
      expect(Number(t.getAttribute('x'))).toBeGreaterThan(CHART_WIDTH / 2)
      expect(t.getAttribute('font-size')).toBe('12')
      expect(t.getAttribute('fill-opacity')).toBe('0.55')
    }
  })

  it('focus value-axis ticks fall on even steps', () => {
    const { container } = draw(rowOf('on_time_pct'), { size: 'focus' })
    const values = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) =>
      parseFloat(t.textContent ?? ''),
    )
    const steps = new Set(values.slice(1).map((v, i) => Math.abs(v - values[i]!)))
    expect(steps.size).toBe(1)
  })

  it('focus pins the current value in an accent pill on the axis and labels the dotted goal line; tiles draw only the line', () => {
    const focus = draw(rowOf('on_time_pct'), { size: 'focus' })
    const pill = focus.container.querySelector('[data-role="current-pill"]')!
    expect(pill.textContent).toBe('84.3%')
    expect(pill.querySelector('rect')!.getAttribute('fill')).toBe('var(--color-accent)')
    expect(pill.querySelector('text')!.getAttribute('fill')).toBe('#FFFFFF')
    expect(focus.container.querySelector('[data-role="goal-pill"]')!.textContent).toBe('Goal 90.0%')
    const goal = focus.container.querySelector('.goal-line .recharts-reference-line-line')!
    expect(goal.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(goal.getAttribute('stroke-opacity')).toBe('0.4')
    focus.unmount()

    const tile = draw(rowOf('on_time_pct'))
    expect(tile.container.querySelector('[data-role="current-pill"], [data-role="goal-pill"]')).toBeNull()
    expect(tile.container.querySelector('.goal-line .recharts-reference-line-line')).toBeTruthy()
  })

  it('bands are faint and borderless, lettered at the right edge in focus only', () => {
    const tile = draw(rowOf('on_time_pct', withBands))
    const rects = [...tile.container.querySelectorAll('[data-role="band"]')]
    expect(rects).toHaveLength(2)
    for (const r of rects) {
      expect(Number(r.getAttribute('fill-opacity'))).toBeLessThanOrEqual(0.06)
      expect(Number(r.getAttribute('fill-opacity'))).toBeGreaterThan(0)
      expect(r.getAttribute('stroke')).toBe('none')
    }
    expect(tile.container.querySelectorAll('.band-label')).toHaveLength(0)
    tile.unmount()

    const focus = draw(rowOf('on_time_pct', withBands), { size: 'focus' })
    expect([...focus.container.querySelectorAll('.band-label')].map((t) => t.textContent)).toEqual(['Y', 'G'])
  })

  it('multi-series lines take distinct palette colors, a legend, and a current dot each', () => {
    const a = rowOf('on_time_pct', undefined, 'unit-a')
    const b = rowOf('on_time_pct', undefined, 'unit-b')
    const { container } = draw(rowOf('on_time_pct'), { chartRows: [a, b] })
    const strokes = [...container.querySelectorAll('.recharts-line-curve')].map((p) => p.getAttribute('stroke'))
    expect(strokes).toEqual([LINE_COLORS[0], LINE_COLORS[1]])
    expect(container.querySelector('.recharts-area')).toBeNull()
    const legend = screen.getByTestId('chart-legend')
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Unit A', 'Unit B'])
    expect(container.querySelectorAll('[data-current-dot]')).toHaveLength(2)
  })

  it('each chart has its own area gradient', () => {
    const row = rowOf('on_time_pct')
    const { container } = render(
      <MemoryRouter>
        {[0, 1].map((k) => (
          <MetricChart
            key={k}
            row={row}
            columns={columns}
            currentColumnKey="2026-M10"
            currentDisplay="84.3%"
            currentStatus="Y"
            statusLabel={() => undefined}
            scale={scale}
            tableTo="/table"
          />
        ))}
      </MemoryRouter>,
    )
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    const fills = [...container.querySelectorAll('.recharts-area-area')].map((p) => p.getAttribute('fill'))
    expect(fills).toEqual(ids.map((id) => `url(#${id})`))
  })
})

describe('MetricChart bars', () => {
  it.each(['discrete', 'money_plan'])('%s: one accent color with rounded tops, and no letters on the bars', (kind) => {
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    const bars = [...container.querySelectorAll('.recharts-bar-rectangle path')]
    expect(bars).toHaveLength(12)
    for (const bar of bars) {
      expect(bar.getAttribute('fill')).toBe('var(--color-accent)')
      expect(bar.getAttribute('fill-opacity')).toBe('0.85')
      expect(bar.getAttribute('d')).toMatch(/A/)
    }
    expect(container.querySelector('.recharts-label-list')).toBeNull()
  })

  it.each(['discrete', 'money_plan'])('%s: the value axis is on the right in focus and hidden in tiles', (kind) => {
    const tile = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    expect(tile.container.querySelector('.recharts-yAxis')).toBeNull()
    expect(tile.container.querySelector('.recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line')).toBeNull()
    tile.unmount()
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)), { size: 'focus' })
    const ticks = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')]
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) expect(Number(t.getAttribute('x'))).toBeGreaterThan(CHART_WIDTH / 2)
  })

  it('money plan: the 100% line is dotted like the goal, labelled in focus only', () => {
    const focus = draw(rowOf('on_time_pct', (r) => (r.chartKind = 'money_plan')), { size: 'focus' })
    expect(focus.container.querySelector('[data-role="goal-pill"]')!.textContent).toBe('100%')
    const line = focus.container.querySelector('.goal-line .recharts-reference-line-line')!
    expect(line.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(line.getAttribute('stroke-opacity')).toBe('0.4')
    focus.unmount()
    const tile = draw(rowOf('on_time_pct', (r) => (r.chartKind = 'money_plan')))
    expect(tile.container.querySelector('[data-role="goal-pill"]')).toBeNull()
    expect(tile.container.querySelector('.goal-line .recharts-reference-line-line')).toBeTruthy()
  })
})

const scale = defaultStatusScale()
const at = (i: number) => [{ payload: { i } }]
const seriesOf = (row: ViewRow) => [{ name: row.subjectName, color: LINE_COLORS[0]!, points: buildPoints(row, columns, 1) }]

describe('ChartHoverCard', () => {
  it('is a compact dark label: bold value, then the full period, the status and the change', () => {
    render(<ChartHoverCard active payload={at(11)} columns={columns} series={seriesOf(rowOf('on_time_pct'))} scale={scale} />)
    const card = screen.getByTestId('chart-hover')
    expect(card.className).toContain('bg-ink')
    expect(card.className).toContain('text-white')
    expect(card.className).not.toContain('bg-white')
    const lines = [...card.querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual(['84.3%', columns[11]!.fullLabel, '▲ Y Yellow', '+2.1 pts vs Sep'])
    expect(card.querySelector('p')!.className).toContain('font-semibold')
    expect(within(card).getByTestId('hover-status').textContent).toBe('▲ Y Yellow')
    // One series needs no name, and the goal has its own label on the chart.
    expect(within(card).queryByText('All units')).toBeNull()
    expect(within(card).queryByText(/Goal/)).toBeNull()
  })

  it('says why a period has no value, and marks an override', () => {
    const series = seriesOf(rowOf('defect_rate'))
    const { rerender } = render(<ChartHoverCard active payload={at(11)} columns={columns} series={series} scale={scale} />)
    let lines = [...screen.getByTestId('chart-hover').querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual(['n/a', columns[11]!.fullLabel, 'Not measured this month'])
    rerender(<ChartHoverCard active payload={at(10)} columns={columns} series={series} scale={scale} />)
    lines = [...screen.getByTestId('chart-hover').querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual(['No data', columns[10]!.fullLabel])
    rerender(<ChartHoverCard active payload={at(9)} columns={columns} series={series} scale={scale} />)
    expect(screen.getByText('† Overridden by admin@example.test on 2026-10-05: Audit finding')).toBeTruthy()
    expect(screen.getByText('17% worse vs Jul')).toBeTruthy()
    expect(screen.getByTestId('hover-status').textContent).toBe('◆ R Red')
  })

  it("names the change's basis from the cell's rule, as the cell drawer does", () => {
    const row = rowOf('defect_rate', (r) => {
      r.cells[9]!.rule = { type: 'change', compare: 'baseline' }
    })
    render(<ChartHoverCard active payload={at(9)} columns={columns} series={seriesOf(row)} scale={scale} />)
    expect(screen.getByText('17% worse vs baseline')).toBeTruthy()
  })

  it('gives each series one line with its color swatch when there are several', () => {
    const a = rowOf('on_time_pct', undefined, 'unit-a')
    const b = rowOf('on_time_pct', undefined, 'unit-b')
    const series = [
      { name: a.subjectName, color: LINE_COLORS[0]!, points: buildPoints(a, columns, 1) },
      { name: b.subjectName, color: LINE_COLORS[1]!, points: buildPoints(b, columns, 1) },
    ]
    render(<ChartHoverCard active payload={at(11)} columns={columns} series={series} scale={scale} />)
    const card = screen.getByTestId('chart-hover')
    expect(within(card).getByText(columns[11]!.fullLabel)).toBeTruthy()
    const items = [...card.querySelectorAll('li')]
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Unit A')
    expect(items[0]!.textContent).toContain('70.0%')
    expect(items[0]!.textContent).toContain('◆ R')
    expect(items[1]!.textContent).toContain('Unit B')
    expect(items[1]!.textContent).toContain('95.0%')
    const swatches = [...card.querySelectorAll<HTMLElement>('[data-swatch]')].map((s) => s.style.backgroundColor)
    expect(swatches).toHaveLength(2)
    expect(new Set(swatches).size).toBe(2)
  })

  it('draws nothing when no point is hovered', () => {
    const { container } = render(
      <ChartHoverCard active={false} payload={at(11)} columns={columns} series={seriesOf(rowOf('on_time_pct'))} scale={scale} />,
    )
    expect(container.textContent).toBe('')
  })
})

describe('MetricChart hover', () => {
  it.each(['ratio', 'discrete', 'money_plan'])('%s: hovering a column draws a hairline and opens the label for that period', (kind) => {
    hover.index = 11
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    const plot = container.querySelector<HTMLElement>('[data-testid="metric-chart"]')!
    const card = within(plot).getByTestId('chart-hover')
    expect(within(card).getByText(columns[11]!.fullLabel)).toBeTruthy()
    expect(within(card).getByText('84.3%')).toBeTruthy()
    const hairline = plot.querySelector('[data-role="hairline"]')!
    expect(hairline.getAttribute('stroke-opacity')).toBe('0.35')
    expect(hairline.getAttribute('stroke-width')).toBe('1')
    expect(hairline.getAttribute('x1')).toBe(hairline.getAttribute('x2'))
  })

  it('the hovered line point is a small accent dot with a white ring', () => {
    hover.index = 4
    const { container } = draw(rowOf('on_time_pct'))
    const dot = container.querySelector('[data-role="active-dot"]')!
    expect(dot.getAttribute('fill')).toBe('var(--color-accent)')
    expect(dot.getAttribute('stroke')).toBe('#FFFFFF')
    expect(dot.getAttribute('stroke-width')).toBe('2')
  })
})

describe('MetricChart header', () => {
  const header = () => screen.getByTestId('header-change')

  it('focus shows a large value with the change beside it', () => {
    draw(rowOf('on_time_pct'), { size: 'focus' })
    expect(screen.getByText('84.3%', { selector: '[data-testid="header-value"]' }).className).toContain('text-[28px]')
    expect(header().textContent).toBe('▲ +2.1 pts vs Sep')
  })

  it('tiles keep their value size', () => {
    draw(rowOf('on_time_pct'))
    expect(screen.getByTestId('header-value').className).toContain('text-xl')
  })

  it('a rise is good when higher is better', () => {
    draw(rowOf('on_time_pct'))
    expect(header().dataset.tone).toBe('good')
    expect(header().className).toContain('text-status-g')
  })

  it('a rise is bad when lower is better', () => {
    draw(rowOf('on_time_pct', (r) => (r.direction = 'lower_better')))
    expect(header().textContent).toBe('▲ +2.1 pts vs Sep')
    expect(header().dataset.tone).toBe('bad')
    expect(header().className).toContain('text-status-r')
  })

  it('an improvement percentage moves the value against a lower-is-better metric', () => {
    draw(
      rowOf('on_time_pct', (r) => {
        r.direction = 'lower_better'
        Object.assign(r.cells.at(-1)!, { change: -17, changeKind: 'improvement_pct' })
      }),
    )
    expect(header().textContent).toBe('▲ 17% worse vs Sep')
    expect(header().dataset.tone).toBe('bad')
  })

  it('no change is neutral ink with no arrow', () => {
    draw(rowOf('on_time_pct', (r) => (r.cells.at(-1)!.change = 0)))
    expect(header().textContent).toBe('No change vs Sep')
    expect(header().dataset.tone).toBe('neutral')
    expect(header().className).toContain('text-ink/70')
  })

  it('names the basis from the change rule', () => {
    draw(
      rowOf('on_time_pct', (r) => {
        Object.assign(r.cells.at(-1)!, { change: 5, changeKind: 'improvement_pct', rule: { type: 'change', compare: 'baseline' } })
      }),
    )
    expect(header().textContent).toBe('▲ 5% better vs baseline')
    expect(header().dataset.tone).toBe('good')
  })

  it('focus leaves the current value to the header and axis pill, and the table link to the dialog', () => {
    const tile = draw(rowOf('on_time_pct'))
    expect(screen.getByTestId('current-point-label')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View as table' })).toBeTruthy()
    tile.unmount()
    draw(rowOf('on_time_pct'), { size: 'focus' })
    expect(screen.queryByTestId('current-point-label')).toBeNull()
    expect(screen.queryByRole('link', { name: 'View as table' })).toBeNull()
  })

  it('shows no change when the period has none', () => {
    draw(rowOf('on_time_pct', (r) => Object.assign(r.cells.at(-1)!, { change: null, changeKind: '' })))
    expect(screen.queryByTestId('header-change')).toBeNull()
  })
})

describe('MetricChart point controls', () => {
  it.each(['ratio', 'discrete', 'money_plan'])('%s: point buttons stay for keyboard users, hidden until one has focus', (kind) => {
    draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    const button = screen.getByRole('button', { name: 'Oct: 84.3%' })
    const wrapper = button.closest<HTMLElement>('[data-testid="point-controls"]')!
    expect(wrapper.className).toContain('sr-only')
    expect(wrapper.className).toContain('focus-within:not-sr-only')
    expect(within(wrapper).getByRole('status')).toBeTruthy()
    expect(within(wrapper).getAllByRole('button')).toHaveLength(12)
  })

  it.each(['ratio', 'discrete', 'money_plan'])('%s: the plot is hidden from assistive technology and not a tab stop', (kind) => {
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    expect(screen.getByTestId('metric-chart').getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('[data-testid="metric-chart"] [tabindex]:not([tabindex="-1"])')).toBeNull()
  })
})
