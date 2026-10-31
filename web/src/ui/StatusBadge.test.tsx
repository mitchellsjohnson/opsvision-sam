import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './StatusBadge'

describe('StatusBadge', () => {
  it.each([
    ['G', 'Green'],
    ['Y', 'Yellow'],
    ['R', 'Red'],
    ['NA', 'Not applicable'],
  ])('renders %s with the accessible label %s', (status, label) => {
    render(<StatusBadge status={status} />)
    const badge = screen.getByRole('img', { name: `Status: ${label}` })
    expect(badge.textContent).toBe(status)
  })

  it('uses a tenant-supplied label', () => {
    render(<StatusBadge status="G" label="On track" />)
    expect(screen.getByRole('img', { name: 'Status: On track' }).textContent).toBe('G')
  })

  it.each([undefined, null, ''])('renders a dash and "No status" for %j', (status) => {
    render(<StatusBadge status={status} />)
    const badge = screen.getByRole('img', { name: 'No status' })
    expect(badge.textContent).toBe('—')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <div>
        <StatusBadge status="G" />
        <StatusBadge status="Y" />
        <StatusBadge status="R" />
        <StatusBadge status="NA" />
        <StatusBadge status="" />
      </div>,
    )
    expect((await axe(container)).violations).toEqual([])
  })
})
