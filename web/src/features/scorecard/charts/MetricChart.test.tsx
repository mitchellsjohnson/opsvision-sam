import { render } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../../api/schema'
import { buildView } from '../../../test/viewFixtures'
import { buildTrendColumns } from '../columns'
import { defaultStatusScale } from './chartTheme'
import { MetricChart } from './MetricChart'

type ViewRow = components['schemas']['ViewRow']

// jsdom measures every element as 0 wide, so ResponsiveContainer draws
// nothing; give the chart a fixed size instead.
vi.mock('recharts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, { width: 300, height: 120 }) : null,
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
})

function rowOf(metric: string, edit?: (row: ViewRow) => void): ViewRow {
  const q = new URLSearchParams()
  for (const c of columns) q.append('periods', c.period)
  const row = buildView(q).rows.find((r) => r.metricKey === metric && r.subjectId === 'root')!
  edit?.(row)
  return row
}

function draw(row: ViewRow) {
  const current = row.cells.at(-1)!
  return render(
    <MemoryRouter>
      <MetricChart
        row={row}
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
    const bandLabels = [...container.querySelectorAll('.band-label')].map((t) => t.textContent)
    expect(bandLabels).toEqual(['Y', 'G'])
  })
})
