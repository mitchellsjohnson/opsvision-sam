import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../../api/schema'
import { addQuarterly, buildView } from '../../../test/viewFixtures'
import { buildMonthTrendColumns, buildTrendColumns, coarseColumns, windowColumns, type Column } from '../columns'
import { defaultStatusScale, LINE_COLORS } from './chartTheme'
import { buildPoints, ChartHoverCard, FOCUS_CHART_HEIGHT, MetricChart, type ChartSize } from './MetricChart'
import { moneyPlanDomain } from './moneyPlan'
import type { VersionMarker } from './versionMarkers'

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

interface DrawOptions {
  size?: ChartSize
  chartRows?: ViewRow[]
  scale?: StatusLevel[]
  columns?: Column[]
  header?: boolean
  markers?: VersionMarker[]
}

function draw(row: ViewRow, opts: DrawOptions = {}) {
  const cols = opts.columns ?? columns
  const currentKey = cols.at(-1)!.key
  const current = row.cells.find((c) => c.period === currentKey && !c.ytd) ?? row.cells.at(-1)
  return render(
    <MemoryRouter>
      <MetricChart
        size={opts.size}
        row={row}
        chartRows={opts.chartRows}
        columns={cols}
        currentColumnKey={currentKey}
        currentDisplay={current?.display ?? ''}
        currentStatus={current?.status ?? ''}
        statusLabel={() => undefined}
        scale={opts.scale ?? defaultStatusScale()}
        tableTo="/table"
        header={opts.header}
        markers={opts.markers}
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
      // Tile cells are 18px with 11px letters (§3.3).
      expect(ribbon.className).toContain(size === 'focus' ? 'h-[22px]' : 'h-[18px]')
      unmount()
    }
  })

  it('says n/a for a period not applicable and draws no data as the status board dot', () => {
    const { container } = draw(rowOf('defect_rate', (r) => (r.chartKind = 'discrete')))
    const cells = ribbonCells(container)
    expect(cells.map((c) => c.textContent).slice(-4)).toEqual(['G', 'R', '', 'n/a'])
    expect(cells.map((c) => c.dataset.status).slice(-4)).toEqual(['G', 'R', 'missing', 'na'])
    expect(cells.at(-2)!.querySelector('[data-dot]')).not.toBeNull()
    expect(cells.at(-1)!.querySelector('[data-dot]')).toBeNull()
  })

  it('fills cells exception-first: green a soft tint, yellow an outlined tint, as on the status board', () => {
    const { container } = draw(rowOf('on_time_pct'))
    const cells = ribbonCells(container)
    expect(cells[0]!.dataset.tier).toBe('soft')
    expect(cells[0]!.style.backgroundColor).toBe('var(--color-status-g-bg)')
    expect(cells[0]!.style.color).toBe('rgb(19, 122, 58)')
    expect(cells[11]!.dataset.tier).toBe('outline')
    expect(cells[11]!.style.backgroundColor).toBe('var(--color-status-y-bg)')
    expect(cells[11]!.style.boxShadow).toBe('inset 0 0 0 1px #8A5A00')
  })

  it('fills red solid, lettered white', () => {
    const { container } = draw(rowOf('defect_rate', (r) => (r.chartKind = 'discrete')))
    const red = ribbonCells(container).find((c) => c.dataset.status === 'R')!
    expect(red.dataset.tier).toBe('solid')
    expect(red.style.backgroundColor).toBe('rgb(180, 35, 24)')
    expect(red.style.color).toBe('rgb(255, 255, 255)')
  })

  it('fills a tenant color solid, in white or ink, when its letter would not read on a tint', () => {
    const light: StatusLevel[] = [{ key: 'G', label: 'Green', color: '#F5D90A', rank: 1 }, ...defaultStatusScale().slice(1)]
    const { container } = draw(rowOf('on_time_pct'), { scale: light })
    const cells = ribbonCells(container)
    expect(cells[0]!.dataset.tier).toBe('solid')
    expect(cells[0]!.style.backgroundColor).toBe('rgb(245, 217, 10)')
    expect(cells[0]!.style.color).toBe('var(--color-ink)')
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

  it.each(['discrete', 'money_plan'])('%s: cells line up with the plotted columns', (kind) => {
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

  it('money plan: 24 bars, each in its own column over its ribbon cell', () => {
    hover.index = 23
    const { container } = draw24('money_plan')
    const bars = [...container.querySelectorAll('rect[data-bar]')]
    expect(bars).toHaveLength(24)
    const lefts = bars.map((b) => Number(b.getAttribute('x')))
    expect(new Set(lefts).size).toBe(24)
    const ribbon = screen.getByTestId('status-ribbon')
    const left = parseFloat(ribbon.style.marginLeft)
    const band = (CHART_WIDTH - left - parseFloat(ribbon.style.marginRight)) / 24
    expect(Number(container.querySelector('[data-role="hairline"]')!.getAttribute('x1'))).toBeCloseTo(left + 23.5 * band)
    const labels = [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    expect(labels.every((l) => /^[A-Z][a-z]{2}$/.test(l ?? ''))).toBe(true)
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
      // Tick text at ink/70, the lightest text the spec allows (§3.2).
      expect(t.getAttribute('fill-opacity')).toBe('0.7')
    }
    for (const t of container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')) {
      expect(t.getAttribute('fill-opacity')).toBe(t.textContent === 'Oct' ? '1' : '0.7')
    }
  })

  it('focus value-axis ticks fall on even steps', () => {
    const { container } = draw(rowOf('on_time_pct'), { size: 'focus' })
    const values = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) =>
      parseFloat(t.textContent ?? ''),
    )
    // A tick hidden under the current-value pill leaves a double step, never an uneven one.
    const steps = values.slice(1).map((v, i) => Math.abs(v - values[i]!))
    const step = Math.min(...steps)
    for (const s of steps) expect(s / step).toBeCloseTo(Math.round(s / step))
    // The outer ticks are whole steps too: the axis is not cut at the data's edge.
    for (const v of values) expect(v / step).toBeCloseTo(Math.round(v / step))
  })

  it('the current period’s axis label is bold and full ink; the others ink/70', () => {
    const { container } = draw(rowOf('on_time_pct'))
    const ticks = [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')]
    expect(ticks.map((t) => t.textContent)).toEqual(columns.map((c) => c.label))
    expect(ticks.at(-1)!.getAttribute('font-weight')).toBe('600')
    expect(ticks.at(-1)!.getAttribute('fill-opacity')).toBe('1')
    expect(ticks[0]!.getAttribute('font-weight')).toBe('400')
  })

  it('no value-axis tick label sits within 14px of the current-value pill', () => {
    for (const value of [84.3, 85, 90, 80]) {
      const { container, unmount } = draw(
        rowOf('on_time_pct', (r) => Object.assign(r.cells.at(-1)!, { value, display: `${value.toFixed(1)}%` })),
        { size: 'focus' },
      )
      const rect = container.querySelector('[data-role="current-pill"] rect')!
      const top = Number(rect.getAttribute('y'))
      const bottom = top + Number(rect.getAttribute('height'))
      const ticks = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')]
      expect(ticks.length).toBeGreaterThan(1)
      // Measured from the pill's edge to the tick label's centre line.
      for (const t of ticks) {
        const y = Number(t.getAttribute('y'))
        expect(y <= top - 14 || y >= bottom + 14).toBe(true)
      }
      unmount()
    }
  })

  it('a percent axis never runs past 100%', () => {
    const uptime = rowOf('on_time_pct', (r) => {
      r.format = 'percent2'
      r.cells.forEach((c, i) => Object.assign(c, { value: i === 11 ? 99.06 : 99.98, display: i === 11 ? '99.06%' : '99.98%' }))
      r.cells.at(-1)!.target = 99.9
      r.cells.at(-1)!.rule = {
        type: 'bands',
        bands: [
          { status: 'G', op: '>=', value: 99.9 },
          { status: 'Y', op: '>', value: 99.8 },
          { status: 'R', op: '', value: 0 },
        ],
      }
    })
    for (const size of SIZES) {
      const { container, unmount } = draw(uptime, { size })
      const chart = screen.getByTestId('metric-chart')
      expect(Number(chart.dataset.domainMax)).toBeLessThanOrEqual(100)
      const tops = (chart.dataset.bands ?? '').split(' ').map((b) => Number(b.split('-').at(-1)))
      expect(Math.max(...tops)).toBeLessThanOrEqual(100)
      const ticks = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) =>
        parseFloat(t.textContent ?? ''),
      )
      for (const t of ticks) expect(t).toBeLessThanOrEqual(100)
      unmount()
    }
  })

  it('value-axis ticks carry only the decimals their step needs', () => {
    const uptime = rowOf('on_time_pct', (r) => {
      r.format = 'percent2'
      r.cells.forEach((c, i) => Object.assign(c, { value: i % 2 ? 98.6 : 99.9, display: i % 2 ? '98.60%' : '99.90%', target: null }))
    })
    const { container } = draw(uptime, { size: 'focus' })
    const labels = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    expect(labels.length).toBeGreaterThan(1)
    // A 0.5 step reads 99.5%, not 99.50%; the pill keeps the metric's own precision.
    for (const l of labels) expect(l).toMatch(/^\d+\.\d%$/)
    expect(container.querySelector('[data-role="current-pill"]')!.textContent).toBe('98.60%')
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

  it('the goal pill sits on its line, and moves off the current-value pill when the two are close', () => {
    const center = (g: Element) => Number(g.querySelector('rect')!.getAttribute('y')) + Number(g.querySelector('rect')!.getAttribute('height')) / 2
    const far = draw(rowOf('on_time_pct'), { size: 'focus' })
    const goalY = Number(far.container.querySelector('.goal-line .recharts-reference-line-line')!.getAttribute('y1'))
    expect(center(far.container.querySelector('[data-role="goal-pill"]')!)).toBeCloseTo(goalY)
    far.unmount()

    const near = draw(
      rowOf('on_time_pct', (r) => Object.assign(r.cells.at(-1)!, { value: 90.5, display: '90.5%' })),
      { size: 'focus' },
    )
    const goal = center(near.container.querySelector('[data-role="goal-pill"]')!)
    const current = center(near.container.querySelector('[data-role="current-pill"]')!)
    expect(Math.abs(goal - current)).toBeGreaterThanOrEqual(16)
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

  it('multi-series lines take distinct palette colors and a current dot each, labelled at their ends rather than by a legend', () => {
    const a = rowOf('on_time_pct', undefined, 'unit-a')
    const b = rowOf('on_time_pct', undefined, 'unit-b')
    const { container } = draw(rowOf('on_time_pct'), { chartRows: [a, b] })
    const strokes = [...container.querySelectorAll('.recharts-line-curve')].map((p) => p.getAttribute('stroke'))
    expect(strokes).toEqual([LINE_COLORS[0], LINE_COLORS[1]])
    expect(container.querySelector('.recharts-area')).toBeNull()
    expect(screen.queryByTestId('chart-legend')).toBeNull()
    expect([...container.querySelectorAll('[data-role="end-name"]')].map((t) => t.textContent).sort()).toEqual(['Unit A', 'Unit B'])
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

const xTicks = (root: ParentNode) =>
  [...root.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)

describe('MetricChart coarse points', () => {
  const quarters = coarseColumns('2026-M10', 'quarter', 4, 1)

  function quarterlyRow(edit?: (row: ViewRow) => void): ViewRow {
    const q = new URLSearchParams()
    for (const c of quarters) q.append('periods', c.period)
    const row = addQuarterly(buildView(q)).rows.find((r) => r.metricKey === 'concepts_value')!
    edit?.(row)
    return row
  }

  it.each(SIZES)('%s: a discrete quarterly metric is a line with a visible point and value per quarter, not bars', (size) => {
    const { container } = draw(quarterlyRow(), { columns: quarters, size })
    const chart = screen.getByTestId('metric-chart')
    const dots = [...chart.querySelectorAll('circle[data-point]')]
    expect(dots).toHaveLength(4)
    expect(dots.map((d) => d.getAttribute('r'))).toEqual(['3', '3', '3', '4'])
    expect(chart.querySelectorAll('[data-current-dot]')).toHaveLength(1)
    expect([...chart.querySelectorAll('[data-role="value-label"]')].map((t) => t.textContent)).toEqual(['70%', '75%', '85%', '90%'])
    for (const label of chart.querySelectorAll('[data-role="value-label"]')) {
      expect(label.getAttribute('font-size')).toBe('11')
      expect(label.getAttribute('font-weight')).toBe('600')
    }
    expect(xTicks(container)).toEqual(['Q4 FY25', 'Q1 FY26', 'Q2 FY26', 'Q3 FY26'])
    expect(chart.querySelector('rect[data-bar], .recharts-bar-rectangle')).toBeNull()
    expect(chart.querySelector('.recharts-line-curve')).toBeTruthy()
    expect(ribbonCells(container)).toHaveLength(4)
  })

  it('a quarterly ratio metric in a month view gets points too', () => {
    draw(quarterlyRow((r) => (r.chartKind = 'ratio')), { columns: quarters })
    expect(screen.getByTestId('metric-chart').querySelectorAll('circle[data-point]')).toHaveLength(4)
  })

  it('a monthly ratio line keeps its single current dot', () => {
    const { container } = draw(rowOf('on_time_pct'))
    expect(container.querySelectorAll('circle[data-point]')).toHaveLength(0)
  })

  it('a discrete monthly metric gets a point per month', () => {
    draw(rowOf('on_time_pct', (r) => (r.chartKind = 'discrete')))
    expect(screen.getByTestId('metric-chart').querySelectorAll('circle[data-point]')).toHaveLength(12)
  })

  it('the hover label names the months a quarter covers', () => {
    hover.index = 3
    draw(quarterlyRow(), { columns: quarters })
    expect(within(screen.getByTestId('chart-hover')).getByText('Jul–Sep 2026')).toBeTruthy()
  })

  it('point buttons name the full period when quarters repeat, as eight do', () => {
    const tile = draw(quarterlyRow(), { columns: quarters })
    expect(screen.getByRole('button', { name: 'Q3: 90%' })).toBeTruthy()
    tile.unmount()
    const eight = coarseColumns('2026-M10', 'quarter', 8, 1)
    const q = new URLSearchParams()
    for (const c of eight) q.append('periods', c.period)
    const row = addQuarterly(buildView(q)).rows.find((r) => r.metricKey === 'concepts_value')!
    draw(row, { columns: eight, size: 'focus' })
    expect(screen.getByRole('button', { name: 'Q3 FY2026: 90%' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Q3 FY2025: no data' })).toBeTruthy()
  })

  it('half and year columns are labelled with a short fiscal year', () => {
    const halves = windowColumns('2026-M10', 'half', 2, 1)
    const { container, unmount } = draw(quarterlyRow((r) => (r.frequency = 'biannual')), { columns: halves })
    expect(xTicks(container)).toEqual(['H2 FY25', 'H1 FY26'])
    unmount()
    const years = windowColumns('2026-M10', 'year', 3, 1)
    const y = draw(quarterlyRow((r) => (r.frequency = 'annual')), { columns: years })
    expect(xTicks(y.container)).toEqual(['FY23', 'FY24', 'FY25'])
  })
})

describe('MetricChart money plan', () => {
  const sepOct = columns.slice(-2)

  /** Spend vs plan with Sep at `sep`% and Oct at `oct`%, Green under 110%, Yellow to 120%. */
  function planRow(sep = 96, oct = 104): ViewRow {
    return rowOf('on_time_pct', (r) => {
      r.metricName = 'Spend vs plan'
      r.chartKind = 'money_plan'
      r.format = 'percent0'
      r.direction = 'lower_better'
      const status = (v: number) => (v <= 110 ? 'G' : v <= 120 ? 'Y' : 'R')
      r.cells = r.cells.map((c) => {
        const v = c.period === '2026-M09' ? sep : c.period === '2026-M10' ? oct : null
        return {
          ...c,
          value: v,
          display: v === null ? '' : `${v}%`,
          status: v === null ? '' : status(v),
          change: null,
          target: null,
          rule: {
            type: 'bands',
            bands: [
              { status: 'G', op: '<=', value: 110 },
              { status: 'Y', op: '<=', value: 120 },
              { status: 'R', op: '', value: 0 },
            ],
          },
        }
      })
    })
  }

  const planY = (root: ParentNode) => Number(root.querySelector('.plan-line .recharts-reference-line-line')!.getAttribute('y1'))
  const barAt = (root: ParentNode, key: string) => root.querySelector<SVGRectElement>(`rect[data-bar][data-key="${key}"]`)!

  it.each(SIZES)('%s: bars diverge from the 100%% line: under plan below it, over plan above it', (size) => {
    const { container } = draw(planRow(), { columns: sepOct, size })
    const y100 = planY(container)
    const under = barAt(container, '2026-M09')
    const over = barAt(container, '2026-M10')
    const top = (b: Element) => Number(b.getAttribute('y'))
    const bottom = (b: Element) => top(b) + Number(b.getAttribute('height'))
    expect(top(under)).toBeCloseTo(y100)
    expect(bottom(under)).toBeGreaterThan(y100)
    expect(bottom(over)).toBeCloseTo(y100)
    expect(top(over)).toBeLessThan(y100)
    expect([...container.querySelectorAll('[data-role="deviation"]')].map((t) => t.textContent)).toEqual(['-4%', '+4%'])
  })

  it('labels every other bar, counted back from the current one, when the labels would overlap', () => {
    const row = planRow()
    row.cells = row.cells.map((c, i) => ({ ...c, value: 104 + (i % 3), display: `${104 + (i % 3)}%`, status: 'G' }))
    const { container } = draw(row)
    const labelled = [...container.querySelectorAll('rect[data-bar]')]
      .filter((b) => b.parentElement!.querySelector('[data-role="deviation"]'))
      .map((b) => b.getAttribute('data-key'))
    expect(labelled).toEqual(columns.filter((_, i) => (11 - i) % 2 === 0).map((c) => c.key))
  })

  it('the 100% line is solid ink at 55%', () => {
    const { container } = draw(planRow(), { columns: sepOct })
    const line = container.querySelector('.plan-line .recharts-reference-line-line')!
    expect(line.getAttribute('stroke')).toBe('var(--color-ink)')
    expect(line.getAttribute('stroke-opacity')).toBe('0.55')
    expect(line.getAttribute('stroke-dasharray')).toBeNull()
  })

  it('fills each bar by its status tier: Green soft with a Green edge, Yellow outlined, Red solid', () => {
    const { container } = draw(planRow(115, 125), { columns: sepOct })
    expect(barAt(container, '2026-M09').getAttribute('fill')).toBe('#FFF3D6')
    expect(barAt(container, '2026-M09').getAttribute('stroke')).toBe('#8A5A00')
    expect(barAt(container, '2026-M10').getAttribute('fill')).toBe('#B42318')
  })

  it('a tile labels the line Plan at its right end; focus pins a Plan pill on the axis', () => {
    const tile = draw(planRow(), { columns: sepOct })
    const label = tile.container.querySelector('[data-role="plan-label"]')!
    expect(label.textContent).toBe('Plan')
    expect(Number(label.getAttribute('y'))).toBeGreaterThan(planY(tile.container))
    expect(tile.container.querySelector('[data-role="plan-pill"]')).toBeNull()
    expect(tile.container.querySelector('.recharts-yAxis')).toBeNull()
    tile.unmount()
    const focus = draw(planRow(), { columns: sepOct, size: 'focus' })
    expect(focus.container.querySelector('[data-role="plan-pill"]')!.textContent).toBe('Plan')
    expect(focus.container.querySelector('[data-role="plan-label"]')).toBeNull()
  })

  it('focus ticks sit only at band edges', () => {
    const { container } = draw(planRow(), { columns: sepOct, size: 'focus' })
    const ticks = [...container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    expect(ticks).toEqual(['110%'])
  })

  it('bands are zones at 7% around the line', () => {
    const { container } = draw(planRow(), { columns: sepOct })
    const bands = [...container.querySelectorAll('[data-role="band"]')]
    expect(bands.length).toBeGreaterThan(0)
    for (const b of bands) expect(b.getAttribute('fill-opacity')).toBe('0.07')
  })

  it('summarizes how often spend ran over plan, then the current period', () => {
    draw(planRow(), { columns: sepOct })
    expect(screen.getByText('Spend vs plan: over plan in 1 of 2 months; Oct 104% of plan, Green')).toBeTruthy()
  })

  it('keeps the point buttons', () => {
    draw(planRow(), { columns: sepOct })
    expect(screen.getByRole('button', { name: 'Oct: 104%' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sep: 96%' })).toBeTruthy()
  })

  it('moneyPlanDomain centres on 100%, padded by the largest deviation plus 3, at least ±15', () => {
    expect(moneyPlanDomain([96, 111])).toEqual([85, 115])
    expect(moneyPlanDomain([80, 130])).toEqual([67, 133])
    expect(moneyPlanDomain([])).toEqual([85, 115])
  })
})

describe('MetricChart sparse', () => {
  const REASON = 'No major incident needed a postmortem this month'
  const VALUED = [1, 4, 7, 10]

  function sparseRow(): ViewRow {
    return rowOf('on_time_pct', (r) => {
      r.cells = r.cells.map((c, i) =>
        VALUED.includes(i)
          ? { ...c, value: 80, display: '80%', status: 'Y' }
          : { ...c, value: null, display: '', status: '', naReason: REASON, change: null },
      )
    })
  }

  it.each(SIZES)('%s: a board ribbon with the value above each valued month and month labels below', (size) => {
    const { container } = draw(sparseRow(), { size })
    const ribbon = screen.getByTestId('sparse-ribbon')
    expect(ribbon.getAttribute('aria-hidden')).toBe('true')
    const cells = [...ribbon.querySelectorAll<HTMLElement>('[data-kind]')]
    expect(cells).toHaveLength(12)
    expect(cells.map((c) => c.dataset.kind)).toEqual(columns.map((_, i) => (VALUED.includes(i) ? 'status' : 'na')))
    expect(cells[0]!.className).toContain(size === 'focus' ? 'h-6' : 'h-[18px]')
    const values = [...ribbon.querySelectorAll('[data-role="value-label"]')]
    expect(values.map((v) => v.textContent)).toEqual(['80%', '80%', '80%', '80%'])
    expect([...ribbon.querySelectorAll('[data-role="month-label"]')].map((m) => m.textContent)).toEqual(columns.map((c) => c.label))
    // No bordered chips: nothing in the chart is a chip, and no button reads only n/a.
    expect(container.querySelector('span.rounded.border')).toBeNull()
    for (const button of screen.getAllByRole('button')) expect(within(button).queryAllByText(/n\/a$/)).toHaveLength(0)
  })

  it('says how many months reported and what n/a means', () => {
    draw(sparseRow())
    expect(screen.getByText('4 months reported in the last 12; the rest are n/a')).toBeTruthy()
    expect(screen.getByText(`n/a: ${REASON}`)).toBeTruthy()
  })

  it('counts n/a months when their reasons differ', () => {
    const row = sparseRow()
    row.cells[0] = { ...row.cells[0]!, naReason: 'Team paused' }
    draw(row)
    expect(screen.getByText('4 months reported in the last 12; 8 months n/a')).toBeTruthy()
    expect(screen.getByText(`n/a: ${REASON}`)).toBeTruthy()
  })

  it('focus adds a table of the valued months', () => {
    draw(sparseRow(), { size: 'focus' })
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Month', 'Value', 'Status', 'Change'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(VALUED.map((i) => columns[i]!.fullLabel))
    expect(within(rows[0]!).getByText('80%')).toBeTruthy()
    expect(within(rows[0]!).getByText('Yellow')).toBeTruthy()
  })

  it('the tile has no table', () => {
    draw(sparseRow())
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('keeps a point button per month, with the reason for n/a months', () => {
    draw(sparseRow())
    expect(screen.getByRole('button', { name: `Nov: n/a: ${REASON}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dec: 80%' })).toBeTruthy()
  })
})

/** A segment of a metric with no company total: `value` and `status` in every month, the last month's rule banded. */
function segment(id: string, name: string, value: number, status: string, history: string = status): ViewRow {
  return rowOf('on_time_pct', (r) => {
    r.subjectId = id
    r.subjectName = name
    r.depth = 1
    r.cells.forEach((c, i) => {
      const last = i === r.cells.length - 1
      Object.assign(c, { subjectId: id, value: last ? value : value + 1, display: `${last ? value : value + 1}%`, status: last ? status : history })
    })
    withBands(r)
  })
}

describe('MetricChart multi-series', () => {
  const four = () => [
    segment('platform', 'Platform', 92, 'G'),
    segment('payments', 'Payments', 82, 'Y'),
    segment('data', 'Data', 74, 'R', 'Y'),
    segment('mobile', 'Mobile', 75, 'Y', 'R'),
  ]
  const empty = (r: ViewRow) => (r.cells = [])

  it.each(SIZES)('%s: up to three series overlay in one plot, each labelled at its end by name, value and chip; no legend', (size) => {
    const rows = four().slice(0, 3)
    const { container } = draw(rowOf('on_time_pct', empty), { chartRows: rows, size })
    expect(container.querySelectorAll('[data-testid="metric-chart"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="metric-chart"] svg.recharts-surface')).toHaveLength(1)
    expect(screen.queryByTestId('chart-legend')).toBeNull()
    expect(screen.queryAllByTestId('series-panel')).toHaveLength(0)
    const labels = [...container.querySelectorAll('[data-role="end-label"]')]
    expect(labels).toHaveLength(3)
    const parts = labels.map((l) => [
      l.querySelector('[data-role="end-name"]')!.textContent,
      l.querySelector('[data-role="end-value"]')!.textContent,
      l.querySelector('[data-role="end-chip"]')!.textContent,
    ])
    expect(parts).toEqual(
      expect.arrayContaining([
        ['Platform', '92%', '●G'],
        ['Payments', '82%', '▲Y'],
        ['Data', '74%', '◆R'],
      ]),
    )
    // The name is in its line's color.
    const platform = labels.find((l) => l.textContent?.startsWith('Platform'))!
    expect(platform.querySelector('[data-role="end-name"]')!.getAttribute('fill')).toBe(LINE_COLORS[0])
  })

  it('overlaid lines sit on the bands when every series has the same rule, and on none when they differ', () => {
    const { container, unmount } = draw(rowOf('on_time_pct', empty), { chartRows: four().slice(0, 3) })
    expect(container.querySelectorAll('[data-role="band"]').length).toBeGreaterThan(0)
    unmount()
    const own = segment('own', 'Own', 80, 'Y')
    own.cells.at(-1)!.rule = { type: 'bands', bands: [{ status: 'G', op: '>=', value: 70 }, { status: 'R', op: '', value: 0 }] }
    const mixed = draw(rowOf('on_time_pct', empty), { chartRows: [...four().slice(0, 2), own] })
    expect(mixed.container.querySelector('[data-role="band"]')).toBeNull()
  })

  it('end labels keep 16px apart when the lines end close together', () => {
    const rows = [segment('a', 'Alpha', 80, 'Y'), segment('b', 'Beta', 80.2, 'Y'), segment('c', 'Gamma', 80.4, 'Y')]
    const { container } = draw(rowOf('on_time_pct', empty), { chartRows: rows })
    const ys = [...container.querySelectorAll('[data-role="end-name"]')].map((t) => Number(t.getAttribute('y'))).sort((a, b) => a - b)
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(16)
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(16)
  })

  it('in a narrow tile the labels move under the plot, still by name, value and chip, so the plot keeps its width', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 220 } as DOMRect)
    try {
      const { container } = draw(rowOf('on_time_pct', empty), { chartRows: four() })
      expect(container.querySelector('[data-role="end-label"]')).toBeNull()
      const key = screen.getByTestId('series-key')
      expect(key.getAttribute('aria-hidden')).toBe('true')
      const items = [...key.querySelectorAll('li')].map((li) => li.textContent)
      // Ordered as the lines end, top to bottom.
      expect(items).toEqual(['Platform92%●G', 'Payments82%▲Y', 'Mobile75%▲Y', 'Data74%◆R'])
    } finally {
      rect.mockRestore()
    }
  })

  it('in a narrow tile the labels move under the plot, still by name, value and chip, so the plot keeps its width', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 220 } as DOMRect)
    try {
      const { container } = draw(rowOf('on_time_pct', empty), { chartRows: four() })
      expect(container.querySelector('[data-role="end-label"]')).toBeNull()
      const key = screen.getByTestId('series-key')
      expect(key.getAttribute('aria-hidden')).toBe('true')
      const items = [...key.querySelectorAll('li')].map((li) => li.textContent)
      // Ordered as the lines end, top to bottom.
      expect(items).toEqual(['Platform92%●G', 'Payments82%▲Y', 'Mobile75%▲Y', 'Data74%◆R'])
    } finally {
      rect.mockRestore()
    }
  })

  it('a tile overlays four series too', () => {
    const { container } = draw(rowOf('on_time_pct', empty), { chartRows: four() })
    expect(container.querySelectorAll('[data-role="end-label"]')).toHaveLength(4)
    expect(screen.queryAllByTestId('series-panel')).toHaveLength(0)
  })

  it('focus with four or more series draws small multiples: a panel per segment, worst first, one shared y-axis, each with its ribbon', () => {
    const { container } = draw(rowOf('on_time_pct', empty), { chartRows: four(), size: 'focus' })
    const panels = screen.getAllByTestId('series-panel')
    expect(panels.map((p) => p.querySelector('[data-role="panel-name"]')!.textContent)).toEqual(['Data', 'Mobile', 'Payments', 'Platform'])
    expect(within(panels[0]!).getByText('74%')).toBeTruthy()
    expect(within(panels[1]!).getByText('Yellow since Oct 2026 · 1 month')).toBeTruthy()
    const ticksOf = (p: HTMLElement) => [...p.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    const first = ticksOf(panels[0]!)
    expect(first.length).toBeGreaterThan(1)
    for (const p of panels) expect(ticksOf(p)).toEqual(first)
    for (const p of panels) {
      expect(p.querySelector('[data-testid="metric-chart"]')!.className).toContain('h-[110px]')
      expect(p.querySelectorAll('[data-testid="status-ribbon"] > *')).toHaveLength(12)
      expect(p.querySelector('[data-role="band"]')).toBeTruthy()
    }
    expect(container.querySelector('[data-role="end-label"]')).toBeNull()
    expect(screen.getByTestId('multiples-caption').textContent).toMatch(/^Shared y-axis \d+–\d+% · worst first$/)
  })

  it('every series keeps its point buttons, named by series', () => {
    draw(rowOf('on_time_pct', empty), { chartRows: four(), size: 'focus' })
    expect(screen.getByRole('button', { name: 'Data Oct: 74%' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Platform Oct: 92%' })).toBeTruthy()
  })
})

describe('MetricChart on a phone', () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query !== '(min-width: 640px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })

  it('focus: a shorter plot, a 48px right axis, every other month labelled back from the current one, and an 18px letter-only ribbon', () => {
    const { container } = draw(rowOf('on_time_pct'), { size: 'focus' })
    const chart = screen.getByTestId('metric-chart')
    expect(chart.className).toContain('h-[max(280px,45vh)]')
    expect(chart.className).not.toContain(FOCUS_CHART_HEIGHT)
    const labels = [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')].map((t) => t.textContent)
    expect(labels.filter(Boolean)).toEqual(['Dec', 'Feb', 'Apr', 'Jun', 'Aug', 'Oct'])
    expect(chart.dataset.axisWidth).toBe('48')
    const ribbon = screen.getByTestId('status-ribbon')
    expect(ribbon.className).toContain('h-[18px]')
    expect(ribbon.className).toContain('text-[11px]')
    expect(ribbonCells(container).at(-1)!.textContent).toBe('Y')
  })

  it('tiles keep their geometry', () => {
    const { container } = draw(rowOf('on_time_pct'))
    expect(screen.getByTestId('metric-chart').style.height).toBe('120px')
    expect(xTicks(container).filter(Boolean)).toHaveLength(12)
  })
})

describe('MetricChart methodology markers', () => {
  const markers: VersionMarker[] = [{ index: 8, label: 'From records', title: 'Methodology changed: 2026 v2 from Jul 2026' }]

  it.each(SIZES)('%s: a dashed ink/55 line at the boundary with a 10px ink/70 label', (size) => {
    const { container } = draw(rowOf('on_time_pct'), { size, markers })
    const marker = container.querySelector('[data-role="version-marker"]')!
    const line = marker.querySelector('line')!
    expect(line.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(line.getAttribute('stroke-opacity')).toBe('0.55')
    const label = marker.querySelector('text')!
    expect(label.textContent).toBe('From records')
    expect(label.getAttribute('font-size')).toBe('10')
    expect(label.getAttribute('fill-opacity')).toBe('0.7')
    expect(marker.querySelector('title')!.textContent).toBe('Methodology changed: 2026 v2 from Jul 2026')
  })

  it('the summary and the hover label say the methodology changed', () => {
    hover.index = 8
    draw(rowOf('on_time_pct'), { markers })
    expect(screen.getByText(/Methodology changed: 2026 v2 from Jul 2026/, { selector: '.sr-only' })).toBeTruthy()
    expect(within(screen.getByTestId('chart-hover')).getByText('Methodology changed: 2026 v2 from Jul 2026')).toBeTruthy()
  })

  it('multi-series charts mark the change too', () => {
    const rows = [segment('a', 'Alpha', 80, 'Y'), segment('b', 'Beta', 90, 'G')]
    const { container } = draw(rowOf('on_time_pct', (r) => (r.cells = [])), { chartRows: rows, markers })
    expect(container.querySelectorAll('[data-role="version-marker"]')).toHaveLength(1)
  })

  it('a label that would run into the next marker drops its text, keeping the line and its title', () => {
    // 300px wide: one column is about 24px, too little for `2026 v1.0` before Mar.
    const close: VersionMarker[] = [
      { index: 2, label: '2026 v1.0', title: 'Methodology changed: 2026 v1.0 from Jan 2026' },
      { index: 3, label: 'From records', title: 'Methodology changed: 2026 v2 from Feb 2026' },
    ]
    const { container } = draw(rowOf('on_time_pct'), { markers: close })
    const marks = [...container.querySelectorAll('[data-role="version-marker"]')]
    expect(marks).toHaveLength(2)
    expect(marks[0]!.querySelector('text')).toBeNull()
    expect(marks[0]!.querySelector('line')).toBeTruthy()
    expect(marks[0]!.querySelector('title')!.textContent).toBe('Methodology changed: 2026 v1.0 from Jan 2026')
    expect(marks[1]!.querySelector('text')!.textContent).toBe('From records')
  })

  it('no markers, no lines', () => {
    const { container } = draw(rowOf('on_time_pct'))
    expect(container.querySelector('[data-role="version-marker"]')).toBeNull()
  })
})

describe('MetricChart uptime with unit rows', () => {
  it('charts the scope as a line; the old per-unit marker rows are gone', () => {
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = 'uptime')))
    expect(container.querySelector('[data-testid^="uptime-strip-"]')).toBeNull()
    expect(screen.getByTestId('metric-chart').querySelector('.recharts-line-curve')).toBeTruthy()
    expect(ribbonCells(container)).toHaveLength(12)
  })
})

describe('MetricChart header prop', () => {
  it('header={false} drops the value row and keeps the chart', () => {
    draw(rowOf('on_time_pct'), { size: 'focus', header: false })
    expect(screen.queryByTestId('header-value')).toBeNull()
    expect(screen.queryByTestId('header-change')).toBeNull()
    expect(screen.getByTestId('metric-chart')).toBeTruthy()
  })

  it('shows the value row by default', () => {
    draw(rowOf('on_time_pct'), { size: 'focus' })
    expect(screen.getByTestId('header-value')).toBeTruthy()
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
