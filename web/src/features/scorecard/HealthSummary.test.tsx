import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { HealthSummary, NOT_REPORTED } from './HealthSummary'

type StatusLevel = components['schemas']['StatusLevel']

/** A tenant with four levels and its own words for them. */
const FOUR: StatusLevel[] = [
  { key: 'A', label: 'Great', color: '#137A3A', rank: 1 },
  { key: 'B', label: 'Good', color: '#0E7490', rank: 2 },
  { key: 'C', label: 'Watch', color: '#8A5A00', rank: 3 },
  { key: 'D', label: 'Off track', color: '#B42318', rank: 4 },
]

const COUNTS = new Map([
  ['D', 5],
  ['C', 3],
  ['B', 0],
  ['A', 3],
  [NOT_REPORTED, 4],
])
const PRIOR = new Map([
  ['D', 3],
  ['C', 3],
  ['B', 1],
  ['A', 4],
  [NOT_REPORTED, 4],
])

function Harness({ title = 'Health this month', priorLabel = 'Sep', prior = PRIOR }: { title?: string; priorLabel?: string; prior?: Map<string, number> | null }) {
  const [selected, setSelected] = useState('')
  return (
    <HealthSummary
      title={title}
      period="Oct 2026"
      total={15}
      counts={COUNTS}
      prior={prior}
      priorLabel={priorLabel}
      selected={selected}
      onSelect={setSelected}
      scale={FOUR}
    />
  )
}

describe('HealthSummary', () => {
  it('one toggle per level of the scale, worst first, plus Not reported, named in the tenant’s labels', () => {
    render(<Harness />)
    const region = screen.getByRole('region', { name: 'Health this month' })
    expect(within(region).getByRole('heading', { level: 2, name: 'Health this month' })).toBeTruthy()
    expect(within(region).getByText('15 metrics · Oct 2026')).toBeTruthy()
    const group = within(region).getByRole('group', { name: 'Show metrics by status' })
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Off track: 5 metrics, up 2 since Sep',
      'Watch: 3 metrics, no change since Sep',
      'Good: 0 metrics, down 1 since Sep',
      'Great: 3 metrics, down 1 since Sep',
      'Not reported: 4 metrics, no change since Sep',
    ])
    expect(region.textContent).not.toMatch(/On track|Red|Green/)
  })

  it('a proportion bar over all metrics, worst first, with its counts in words', () => {
    render(<Harness />)
    const bar = screen.getByRole('img', { name: '5 Off track, 3 Watch, 3 Great, 4 Not reported of 15 metrics' })
    const segments = [...bar.children] as HTMLElement[]
    expect(segments.map((s) => s.getAttribute('data-status'))).toEqual(['D', 'C', 'A', NOT_REPORTED])
    expect(segments.map((s) => s.style.flexGrow)).toEqual(['5', '3', '3', '4'])
  })

  it('says what changed since the prior period, the worst phrase called out when it grew', () => {
    render(<Harness />)
    const since = screen.getByTestId('health-since')
    expect(since.textContent).toBe('Since Sep: 2 more Off track, 1 fewer Good, 1 fewer Great')
    expect(within(since).getByText('2 more Off track').className).toContain('text-status-r')
  })

  it('pressing a toggle keeps focus, is pressed, and announces the result; pressing it again clears', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const live = screen.getByTestId('health-live')
    expect(live.textContent).toBe('')
    const off = screen.getByRole('button', { name: /^Off track:/ })
    expect(off.getAttribute('aria-pressed')).toBe('false')
    await user.click(off)
    expect(off.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(off)
    expect(live.textContent).toBe('Showing 5 Off track metrics')
    await user.click(off)
    expect(off.getAttribute('aria-pressed')).toBe('false')
    expect(live.textContent).toBe('Showing all metrics')
    const none = screen.getByRole('button', { name: /^Not reported:/ })
    await user.keyboard('{Tab}{Tab}{Tab}{Tab}{Enter}')
    expect(document.activeElement).toBe(none)
    expect(none.getAttribute('aria-pressed')).toBe('true')
    expect(live.textContent).toBe('Showing 4 not reported metrics')
  })

  it('names the grain in the title and the prior period in the comparison', () => {
    render(<Harness title="Health this quarter" priorLabel="Q2" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Health this quarter' })).toBeTruthy()
    expect(screen.getByTestId('health-since').textContent).toMatch(/^Since Q2: /)
    expect(screen.getByRole('button', { name: 'Off track: 5 metrics, up 2 since Q2' })).toBeTruthy()
  })

  it('with no prior period, no comparison', () => {
    render(<Harness prior={null} />)
    expect(screen.queryByTestId('health-since')).toBeNull()
    expect(screen.getByRole('button', { name: 'Off track: 5 metrics' })).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { container } = render(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: /^Watch:/ }))
    expect((await axe(container)).violations).toEqual([])
  })
})
