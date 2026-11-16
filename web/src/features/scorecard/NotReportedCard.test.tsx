import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { renderApp } from '../../test/utils'
import { NotReportedCard } from './NotReportedCard'

const ITEMS = [
  { key: 'design_review', name: 'Design review coverage', why: 'No reports in the last 12 months', category: 'Design' },
  { key: 'roadmap', name: 'Roadmap items with customer evidence', why: 'Last reported Jul 2026 (77%)', category: 'Product' },
  { key: 'defect_rate', name: 'Defect rate', why: 'Not applicable: Not measured this month', category: 'Quality' },
]
const QUIET =
  'Reported less often and up to date: Concepts delivered expected value (Q3 FY2026; Q4 due by Jan) · Accessibility compliance (H1 FY2026; H2 due by Jan).'

function card(over: Partial<Parameters<typeof NotReportedCard>[0]> = {}) {
  return renderApp(<NotReportedCard period="2026-M10" items={ITEMS} quiet={QUIET} canEnter {...over} />)
}

describe('NotReportedCard', () => {
  it('titles the period and counts the metrics', async () => {
    card()
    const region = await screen.findByRole('region', { name: /Not reported for Oct 2026/ })
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Not reported for Oct 2026 · 3 metrics')
  })

  it('lists each metric with why it is missing, n/a reasons included, and its category', async () => {
    card()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Design review coverage',
      'Roadmap items with customer evidence',
      'Defect rate',
    ])
    expect(within(rows[2]!).getByText('Not applicable: Not measured this month')).toBeTruthy()
    expect(within(rows[1]!).getByText('Last reported Jul 2026 (77%)')).toBeTruthy()
    expect(within(rows[0]!).getByText('Design').className).toContain('max-sm:hidden')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Metric', 'Why', 'Category'])
  })

  it('names coarse metrics that are up to date in one quiet line under the table', async () => {
    card()
    const line = await screen.findByText(QUIET)
    expect(line.className).toContain('text-xs')
  })

  it('offers data entry for the period to contributors and admins only', async () => {
    const { unmount } = card()
    const link = await screen.findByRole('link', { name: 'Enter Oct 2026 data' })
    expect(link.getAttribute('href')).toBe('/entry?period=2026-M10')
    unmount()
    card({ canEnter: false })
    await screen.findByRole('region', { name: /Not reported/ })
    expect(screen.queryByRole('link', { name: /Enter/ })).toBeNull()
  })

  it('with only the quiet line: no table and no count', async () => {
    card({ items: [] })
    const region = await screen.findByRole('region', { name: /Not reported for Oct 2026/ })
    expect(within(region).queryByRole('table')).toBeNull()
    expect(within(region).getByText(QUIET)).toBeTruthy()
    expect(within(region).queryByRole('link', { name: /Enter/ })).toBeNull()
  })

  it('renders nothing when nothing is missing and no quiet line applies', () => {
    const { container } = card({ items: [], quiet: null })
    expect(container.querySelector('section')).toBeNull()
  })

  it('has no axe violations', async () => {
    const { container } = card()
    await screen.findByRole('table')
    expect((await axe(container)).violations).toEqual([])
  })
})
