import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { SectionHeader } from './SectionHeader'
import type { BoardCell, BoardRow } from './logic/statusBoard'

const SCALE = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]

function row(key: string, last: Partial<BoardCell>): BoardRow {
  return {
    key,
    name: key,
    category: { id: 'engineering', name: 'Engineering' },
    cells: [{ key: '2026-M10', kind: 'status', status: '', display: '', naReason: '', change: null, caption: '', ...last }],
    current: '',
    caption: '',
    change: null,
  }
}

const header = (rows: BoardRow[]) => render(<SectionHeader categoryId="engineering" name="Engineering" rows={rows} scale={SCALE} />)

describe('SectionHeader', () => {
  it('names the section, counts its metrics and rolls them up as chips, worst first', () => {
    header([row('a', { status: 'Y' }), row('b', { status: 'R' }), row('c', { status: 'R' })])
    const heading = screen.getByRole('heading', { level: 2, name: 'Engineering' })
    expect(heading.id).toBe('section-engineering')
    expect(heading.className).toContain('text-accent-deep')
    expect(heading.className).toContain('text-base')
    expect(heading.tabIndex).toBe(-1)
    const box = heading.closest<HTMLElement>('[data-section-header]')!
    expect(within(box).getByText('3 metrics').className).toContain('text-xs')
    const chips = within(box).getByRole('list', { name: 'Engineering roll-up' })
    const items = within(chips).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('[aria-hidden="true"]')!.textContent)).toEqual(['◆R 2', '▲Y 1'])
    expect(items.map((li) => li.querySelector('.sr-only')!.textContent)).toEqual(['2 Red', '1 Yellow'])
  })

  it('says All Green when nothing is off, and still counts metrics with no status', () => {
    header([row('a', { status: 'G' }), row('b', { kind: 'missing' })])
    expect(screen.getByText('2 metrics')).toBeTruthy()
    expect(screen.getByText('All Green')).toBeTruthy()
    expect(screen.getByText('1 no data')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('while a Health filter hides some of its metrics, says how many are shown of all', () => {
    render(
      <SectionHeader
        categoryId="engineering"
        name="Engineering"
        rows={[row('a', { status: 'R' }), row('b', { status: 'G' }), row('c', { status: 'G' })]}
        shown={1}
        scale={SCALE}
      />,
    )
    expect(screen.getByText('1 of 3 metrics').className).toContain('text-xs')
    // The roll-up still counts the whole section.
    expect(screen.getByRole('list', { name: 'Engineering roll-up' }).textContent).toBe('◆R 11 Red')
  })

  it('with every metric shown, the count stays plain', () => {
    render(<SectionHeader categoryId="engineering" name="Engineering" rows={[row('a', { status: 'R' }), row('b', { status: 'G' })]} shown={2} scale={SCALE} />)
    expect(screen.getByText('2 metrics')).toBeTruthy()
  })

  it('one metric reads in the singular', () => {
    header([row('a', { status: 'G' })])
    expect(screen.getByText('1 metric')).toBeTruthy()
  })

  it('sits clear of the sticky control bar when scrolled to', () => {
    header([row('a', { status: 'R' })])
    expect(screen.getByRole('heading', { level: 2 }).style.scrollMarginTop).toBe('calc(var(--control-bar-h, 0px) + 16px)')
  })

  it('has no axe violations', async () => {
    const { container } = header([row('a', { status: 'Y' }), row('b', { status: 'R' })])
    expect((await axe(container)).violations).toEqual([])
  })
})
