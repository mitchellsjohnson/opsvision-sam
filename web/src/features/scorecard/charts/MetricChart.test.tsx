import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../../api/schema'
import { buildView } from '../../../test/viewFixtures'
import { buildTrendColumns } from '../columns'
import { defaultStatusScale, LINE_COLORS } from './chartTheme'
import { buildPoints, ChartHoverCard, MetricChart, type ChartSize } from './MetricChart'

type ViewRow = components['schemas']['ViewRow']

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

function draw(row: ViewRow, opts: { size?: ChartSize; chartRows?: ViewRow[] } = {}) {
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
        scale={defaultStatusScale()}
        tableTo="/table"
      />
    </MemoryRouter>,
  )
}

const letters = (root: ParentNode) => [...root.querySelectorAll('.recharts-label-list text')].map((t) => t.textContent)

describe('MetricChart status cues', () => {
  it('money-plan bars carry status letters', () => {
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = 'money_plan')))
    const shown = letters(container)
    expect(shown).toHaveLength(12)
    expect(shown.at(-1)).toBe('Y')
    expect(shown.slice(0, -1).every((l) => l === 'G')).toBe(true)
  })

  it('discrete bars carry status letters and leave no-data periods unlettered', () => {
    const { container } = draw(rowOf('defect_rate', (r) => (r.chartKind = 'discrete')))
    const shown = letters(container).filter(Boolean)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).toContain('R')
    expect(shown.every((l) => l === 'G' || l === 'R')).toBe(true)
  })

  it('ratio line points are lettered and bands are labelled', () => {
    const { container } = draw(
      rowOf('on_time_pct', (r) => {
        r.cells.at(-1)!.rule = {
          type: 'bands',
          bands: [
            { status: 'G', op: '>=', value: 90 },
            { status: 'Y', op: '>=', value: 80 },
            { status: 'R', op: '', value: 0 },
          ],
        }
      }),
    )
    const dots = [...container.querySelectorAll('[data-status-dot]')].map((d) => d.getAttribute('data-status-dot'))
    expect(dots).toHaveLength(12)
    expect(dots.at(-1)).toBe('Y')
    // The letter sits inside the filled point; the current point has a halo.
    const inPoint = [...container.querySelectorAll('[data-status-dot] .point-letter')].map((t) => t.textContent)
    expect(inPoint).toEqual(dots)
    expect(container.querySelectorAll('[data-current="true"] .point-halo')).toHaveLength(1)
    const bandLabels = [...container.querySelectorAll('.band-label')].map((t) => t.textContent)
    expect(bandLabels).toEqual(['Y', 'G'])
    expect(container.querySelectorAll('.band-pill rect')).toHaveLength(2)
  })
})

const scale = defaultStatusScale()
const at = (i: number) => [{ payload: { i } }]

describe('ChartHoverCard', () => {
  it('shows the full period label, the value with its status pill, the change and the goal', () => {
    const row = rowOf('on_time_pct')
    const series = [{ name: row.subjectName, color: LINE_COLORS[0]!, points: buildPoints(row, columns, 1) }]
    render(<ChartHoverCard active payload={at(11)} columns={columns} series={series} scale={scale} />)
    const card = screen.getByTestId('chart-hover')
    expect(within(card).getByText(columns[11]!.fullLabel)).toBeTruthy()
    expect(within(card).getByText('84.3%')).toBeTruthy()
    expect(within(card).getByTestId('hover-status').textContent).toBe('▲ Y Yellow')
    expect(within(card).getByText('+2.1 pts vs Sep')).toBeTruthy()
    expect(within(card).getByText('Goal 90.0%')).toBeTruthy()
    // One series needs no name.
    expect(within(card).queryByText('All units')).toBeNull()
  })

  it('says why a period has no value, and marks an override', () => {
    const row = rowOf('defect_rate')
    const series = [{ name: row.subjectName, color: LINE_COLORS[0]!, points: buildPoints(row, columns, 1) }]
    const { rerender } = render(<ChartHoverCard active payload={at(11)} columns={columns} series={series} scale={scale} />)
    expect(screen.getByText('n/a: Not measured this month')).toBeTruthy()
    rerender(<ChartHoverCard active payload={at(10)} columns={columns} series={series} scale={scale} />)
    expect(screen.getByText('No data')).toBeTruthy()
    rerender(<ChartHoverCard active payload={at(9)} columns={columns} series={series} scale={scale} />)
    expect(screen.getByText('† Overridden by admin@example.test on 2026-10-05: Audit finding')).toBeTruthy()
    expect(screen.getByText('17% worse vs Jul')).toBeTruthy()
    expect(screen.getByTestId('hover-status').textContent).toBe('◆ R Red')
  })

  it("names the change's basis from the cell's rule, as the cell drawer does", () => {
    const row = rowOf('defect_rate', (r) => {
      r.cells[9]!.rule = { type: 'change', compare: 'baseline' }
    })
    const series = [{ name: row.subjectName, color: LINE_COLORS[0]!, points: buildPoints(row, columns, 1) }]
    render(<ChartHoverCard active payload={at(9)} columns={columns} series={series} scale={scale} />)
    expect(screen.getByText('17% worse vs baseline')).toBeTruthy()
  })

  it('names each series with its color when there are several', () => {
    const a = rowOf('on_time_pct', undefined, 'unit-a')
    const b = rowOf('on_time_pct', undefined, 'unit-b')
    const series = [
      { name: a.subjectName, color: LINE_COLORS[0]!, points: buildPoints(a, columns, 1) },
      { name: b.subjectName, color: LINE_COLORS[1]!, points: buildPoints(b, columns, 1) },
    ]
    render(<ChartHoverCard active payload={at(11)} columns={columns} series={series} scale={scale} />)
    const card = screen.getByTestId('chart-hover')
    expect(within(card).getByText('Unit A')).toBeTruthy()
    expect(within(card).getByText('Unit B')).toBeTruthy()
    expect(within(card).getByText('70.0%')).toBeTruthy()
    expect(within(card).getByText('95.0%')).toBeTruthy()
    const swatches = [...card.querySelectorAll<HTMLElement>('[data-swatch]')].map((s) => s.style.backgroundColor)
    expect(swatches).toHaveLength(2)
    expect(new Set(swatches).size).toBe(2)
  })

  it('draws nothing when no point is hovered', () => {
    const row = rowOf('on_time_pct')
    const series = [{ name: row.subjectName, color: LINE_COLORS[0]!, points: buildPoints(row, columns, 1) }]
    const { container } = render(<ChartHoverCard active={false} payload={at(11)} columns={columns} series={series} scale={scale} />)
    expect(container.textContent).toBe('')
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
})

describe('MetricChart look', () => {
  it('a single line has a gradient area under it; focus labels values and tiles do not', () => {
    const tile = draw(rowOf('on_time_pct'))
    const fill = tile.container.querySelector('.recharts-area-area')?.getAttribute('fill') ?? ''
    expect(fill).toMatch(/^url\(#.+\)$/)
    expect(tile.container.querySelector(`linearGradient[id="${fill.slice(5, -1)}"]`)).toBeTruthy()
    expect(tile.container.querySelectorAll('[data-role="value-label"]')).toHaveLength(0)
    tile.unmount()

    const focus = draw(rowOf('on_time_pct'), { size: 'focus' })
    const labels = [...focus.container.querySelectorAll('[data-role="value-label"]')].map((t) => t.textContent)
    expect(labels).toHaveLength(12)
    expect(labels.at(-1)).toBe('84.3%')
  })

  it('multi-series lines take distinct palette colors and a legend names each series', () => {
    const a = rowOf('on_time_pct', undefined, 'unit-a')
    const b = rowOf('on_time_pct', undefined, 'unit-b')
    const { container } = draw(rowOf('on_time_pct'), { chartRows: [a, b] })
    const strokes = [...container.querySelectorAll('.recharts-line-curve')].map((p) => p.getAttribute('stroke'))
    expect(strokes).toEqual([LINE_COLORS[0], LINE_COLORS[1]])
    expect(container.querySelector('.recharts-area')).toBeNull()
    const legend = screen.getByTestId('chart-legend')
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Unit A', 'Unit B'])
    expect(container.querySelectorAll('[data-status-dot] .point-letter').length).toBeGreaterThan(0)
  })

  it.each(['ratio', 'discrete', 'money_plan'])('%s: hovering a column opens the card for that period', (kind) => {
    hover.index = 11
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = kind)))
    const card = within(container.querySelector<HTMLElement>('[data-testid="metric-chart"]')!).getByTestId('chart-hover')
    expect(within(card).getByText(columns[11]!.fullLabel)).toBeTruthy()
    expect(within(card).getByText('84.3%')).toBeTruthy()
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

  it('bars have rounded tops', () => {
    const { container } = draw(rowOf('on_time_pct', (r) => (r.chartKind = 'money_plan')))
    const bar = container.querySelector('.recharts-bar-rectangle path')
    expect(bar?.getAttribute('d')).toMatch(/A/)
  })
})
