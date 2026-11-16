import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { DefinitionLine } from './DefinitionLine'

type ViewRow = components['schemas']['ViewRow']

const row = {
  metricKey: 'weighted_defect_score',
  metricName: 'Weighted defect score',
  categoryId: 'quality',
  subjectId: 'root',
  subjectName: 'All',
  subjectKind: 'unit',
  format: 'number2',
  depth: 0,
  direction: 'lower_better',
  frequency: 'monthly',
  chartKind: 'line',
  definition: 'Severity-weighted open defects per day. Judged on change against the prior period; lower is better.',
  cells: [],
} as ViewRow

const labels: Record<string, string> = { G: 'Green', Y: 'Yellow', R: 'Red' }

function draw(over: Partial<ViewRow>, rule: components['schemas']['StatusRule']) {
  render(
    <MemoryRouter>
      <DefinitionLine
        metric={undefined}
        rule={rule}
        row={{ ...row, ...over }}
        statusLabel={(k) => labels[k]}
        isAdmin={false}
        noun={{ one: 'product', many: 'products' }}
      />
    </MemoryRouter>,
  )
  return screen.getByText(/^Severity|^Share/).textContent
}

describe('DefinitionLine', () => {
  it('leaves out a threshold clause the definition already states', () => {
    const text = draw({}, {
      type: 'change',
      compare: 'prior_period',
      bands: [
        { status: 'G', op: '>', value: 0 },
        { status: 'Y', op: '>=', value: -5 },
        { status: 'R', op: '', value: 0 },
      ],
    })
    expect(text).toMatch(/lower is better\. Green: any improvement · /)
    expect(text?.match(/lower is better/gi)).toHaveLength(1)
    // The definition says how it is judged in its own words; the threshold does not say it again.
    expect(text?.match(/judged on change/gi)).toHaveLength(1)
  })

  it('keeps the judged-on-change clause when the definition does not say it', () => {
    const text = draw({ definition: 'Severity-weighted open defects per day.' }, {
      type: 'change',
      compare: 'prior_period',
      bands: [
        { status: 'G', op: '>', value: 0 },
        { status: 'R', op: '', value: 0 },
      ],
    })
    expect(text).toMatch(/^Severity-weighted open defects per day\. Lower is better · judged on change vs the prior month · /)
  })

  it('on phones, clamps to two lines with a toggle when it runs longer', async () => {
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(32)
    try {
      draw({}, { type: 'bands', bands: [{ status: 'G', op: '<=', value: 4 }, { status: 'R', op: '', value: 0 }] })
      const block = screen.getByTestId('definition-text')
      expect(block.className).toContain('max-sm:line-clamp-2')
      const toggle = screen.getByRole('button', { name: 'More' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.getAttribute('aria-controls')).toBe(block.id)
      await userEvent.setup().click(toggle)
      expect(block.className).not.toContain('line-clamp-2')
      expect(screen.getByRole('button', { name: 'Less' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      heights.mockRestore()
      client.mockRestore()
    }
  })

  it('no toggle when the definition fits', () => {
    draw({}, { type: 'bands', bands: [{ status: 'G', op: '<=', value: 4 }, { status: 'R', op: '', value: 0 }] })
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('keeps the threshold whole when the definition says nothing of it', () => {
    const text = draw(
      { definition: 'Share of epics shipped on time.', direction: 'higher_better', format: 'percent0' },
      { type: 'bands', bands: [{ status: 'G', op: '>=', value: 90 }, { status: 'R', op: '', value: 0 }] },
    )
    expect(text).toBe('Share of epics shipped on time. Green at 90% or better · Red below 90%.')
  })
})
