import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { WhyDisplay } from './rcaState'
import { WhyButton } from './WhyButton'

const common = { subjectName: 'Webhooks', valueDisplay: '99.06%', periodLabel: 'Oct 2026', nameSubject: true }
const written: WhyDisplay = {
  state: 'written',
  excerpt: 'Config deploy saturated the delivery queue (INC-2041); a retr…',
  author: 'Avery Admin',
  canEdit: false,
}

function renderButton(display: WhyDisplay, extra: Partial<Parameters<typeof WhyButton>[0]> = {}) {
  const onOpen = vi.fn()
  render(<WhyButton display={display} onOpen={onOpen} {...common} {...extra} />)
  return { button: screen.getByRole('button'), onOpen }
}

describe('WhyButton', () => {
  it('shows Why? and the RCA needed tag to an editor of a needed cell', () => {
    const { button } = renderButton({ state: 'needed', canEdit: true })
    expect(screen.getByRole('button', { name: 'Why is Webhooks 99.06% in Oct 2026? RCA needed' })).toBe(button)
    expect(button.textContent).toBe('Why?RCA needed')
    expect(screen.getByText('RCA needed').className).toContain('border-dashed')
  })

  it('shows only Why? to someone who cannot write a needed cell', () => {
    const { button } = renderButton({ state: 'needed', canEdit: false })
    expect(button.textContent).toBe('Why?')
    expect(button.getAttribute('aria-label')).toBe('Why is Webhooks 99.06% in Oct 2026?')
  })

  it('shows Why: and the excerpt for a written note, the excerpt as the description', () => {
    const { button } = renderButton(written)
    expect(button.textContent).toBe(`Why:${written.excerpt}`)
    expect(button.getAttribute('aria-label')).toBe('Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin')
    expect(button.getAttribute('aria-description')).toBe(written.excerpt)
    expect(screen.getByText(written.excerpt).className).toContain('truncate')
  })

  it('tags a stale note Review for editors only', () => {
    const { button } = renderButton({ ...written, state: 'stale', canEdit: true })
    expect(screen.getByText('Review')).toBeTruthy()
    expect(button.getAttribute('aria-label')).toBe(
      'Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin. RCA may be out of date',
    )
  })

  it('shows no Review tag to readers of a stale note', () => {
    renderButton({ ...written, state: 'stale', canEdit: false })
    expect(screen.queryByText('Review')).toBeNull()
  })

  it('counts needed and stale cells below a roll-up', () => {
    const { button } = renderButton(
      { state: 'rollup', neededBelow: 1, staleBelow: 1, showCounts: true },
      { subjectName: 'Acme Demo', valueDisplay: '—' },
    )
    expect(button.textContent).toBe('Why?1 needed · 1 to review')
    expect(button.getAttribute('aria-label')).toBe('Why is Acme Demo — in Oct 2026? 1 RCA needed below it, 1 to review')
  })

  it('shows a plain Why? at a roll-up to people who cannot act', () => {
    const { button } = renderButton({ state: 'rollup', neededBelow: 1, staleBelow: 0, showCounts: false })
    expect(button.textContent).toBe('Why?')
  })

  it('reads RCA rather than Why with the rca prefix', () => {
    const a = render(<WhyButton display={written} onOpen={() => {}} {...common} prefix="rca" />)
    expect(screen.getByRole('button').textContent).toBe(`RCA:${written.excerpt}`)
    a.unmount()
    const b = render(<WhyButton display={{ state: 'needed', canEdit: true }} onOpen={() => {}} {...common} prefix="rca" />)
    expect(screen.getByRole('button').textContent).toBe('RCA needed')
    b.unmount()
    render(<WhyButton display={{ ...written, state: 'stale', canEdit: true }} onOpen={() => {}} {...common} prefix="rca" />)
    expect(screen.getByRole('button').textContent).toBe('RCA · Review')
  })

  it('keeps hints in aria-description, not in the name', () => {
    const first = render(<WhyButton display={{ state: 'available' }} onOpen={() => {}} {...common} hint="Press Enter for why" nameSubject={false} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toBe('Why is 99.06% in Oct 2026?')
    expect(button.getAttribute('aria-description')).toBe('Press Enter for why')
    first.unmount()
    const { button: second } = renderButton(written, { hint: 'Press Enter for why' })
    expect(second.getAttribute('aria-description')).toBe(`${written.excerpt} Press Enter for why`)
  })

  it('is a 24px dialog trigger that opens with its own element', async () => {
    const { button, onOpen } = renderButton({ state: 'available' })
    expect(button.className).toContain('min-h-6')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(button)
  })

  it('keeps compact buttons to one word', () => {
    const a = render(<WhyButton display={written} onOpen={() => {}} {...common} compact />)
    expect(screen.getByRole('button').textContent).toBe('RCA')
    a.unmount()
    const b = render(<WhyButton display={{ ...written, state: 'stale', canEdit: true }} onOpen={() => {}} {...common} compact />)
    expect(screen.getByRole('button').textContent).toBe('Review')
    b.unmount()
    render(<WhyButton display={{ state: 'needed', canEdit: true }} onOpen={() => {}} {...common} compact />)
    expect(screen.getByRole('button').textContent).toBe('Why')
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Why is Webhooks 99.06% in Oct 2026? RCA needed')
  })

  it('has no axe violations in any state', async () => {
    const states: WhyDisplay[] = [
      { state: 'available' },
      { state: 'needed', canEdit: true },
      written,
      { ...written, state: 'stale', canEdit: true },
      { state: 'rollup', neededBelow: 2, staleBelow: 1, showCounts: true },
    ]
    const { container } = render(
      <div>
        {states.map((d) => (
          <WhyButton key={d.state} display={d} onOpen={() => {}} {...common} />
        ))}
      </div>,
    )
    expect((await axe(container)).violations).toEqual([])
  })
})
