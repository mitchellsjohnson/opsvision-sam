import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
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
    expect(text).toMatch(/lower is better\. Judged on change vs the prior month · Green/)
    expect(text?.match(/lower is better/gi)).toHaveLength(1)
  })

  it('keeps the threshold whole when the definition says nothing of it', () => {
    const text = draw(
      { definition: 'Share of epics shipped on time.', direction: 'higher_better', format: 'percent0' },
      { type: 'bands', bands: [{ status: 'G', op: '>=', value: 90 }, { status: 'R', op: '', value: 0 }] },
    )
    expect(text).toBe('Share of epics shipped on time. Green at 90% or better · Red below 90%.')
  })
})
