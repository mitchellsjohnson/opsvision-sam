import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { SummaryDisplay } from './rcaState'
import { WhyButton, type WhyButtonProps } from './WhyButton'

const common = { subjectName: 'Uptime', valueDisplay: '99.06%', periodLabel: 'Oct 2026', nameSubject: true, attribution: true }
const written: SummaryDisplay = {
  state: 'written',
  excerpt: 'Webhooks lost 7h to a queue saturation after the 3 Oct deplo…',
  author: 'Avery Admin',
  canEdit: false,
}

function renderButton(extra: Partial<WhyButtonProps> = {}) {
  const onOpen = vi.fn()
  const view = render(<WhyButton onOpen={onOpen} {...common} {...extra} />)
  return { button: screen.queryByRole('button'), onOpen, ...view }
}

describe('WhyButton: attribution only', () => {
  it('shows Why? and no tag on a cell below the company', () => {
    const { button } = renderButton({ subjectName: 'Webhooks' })
    expect(button?.textContent).toBe('Why?')
    expect(button?.getAttribute('aria-label')).toBe('Why is Webhooks 99.06% in Oct 2026?')
    expect(button?.querySelector('[data-tag]')).toBeNull()
  })

  it('draws nothing without a summary state or attribution', () => {
    const { container } = renderButton({ attribution: false })
    expect(container.innerHTML).toBe('')
  })
})

describe('WhyButton: exec summary states on company-standing surfaces', () => {
  it('tags a missing summary Exec summary needed for admins, in status red', () => {
    const { button } = renderButton({ summary: { state: 'missing', canEdit: true } })
    expect(button?.textContent).toBe('Why?Exec summary needed')
    expect(button?.getAttribute('aria-label')).toBe('Why is Uptime 99.06% in Oct 2026? Exec summary needed')
    const tag = screen.getByText('Exec summary needed')
    expect(tag.className).toContain('text-status-r')
    expect(tag.className).toContain('border-status-r')
    expect(tag.className).toContain('text-[11px]')
  })

  it('tags it No exec summary yet for everyone else, dashed', () => {
    const { button } = renderButton({ summary: { state: 'missing', canEdit: false } })
    expect(button?.textContent).toBe('Why?No exec summary yet')
    expect(button?.getAttribute('aria-label')).toBe('Why is Uptime 99.06% in Oct 2026? No exec summary yet')
    const tag = screen.getByText('No exec summary yet')
    expect(tag.className).toContain('border-dashed')
    expect(tag.className).toContain('text-ink/70')
  })

  it('says which month needs a coarse summary instead of Exec summary needed, when the month shown is not gated', () => {
    const { button } = renderButton({ summary: { state: 'missing', canEdit: true, neededFor: 'Jun 2026' } })
    expect(button?.textContent).toBe('Why?Needed for Jun 2026')
    expect(button?.getAttribute('aria-label')).toBe('Why is Uptime 99.06% in Oct 2026? Exec summary needed for Jun 2026')
    expect(screen.queryByText('Exec summary needed')).toBeNull()
  })

  it('keeps compact cells from saying Needed for a month that is not gated', () => {
    const { button } = renderButton({ compact: true, summary: { state: 'missing', canEdit: true, neededFor: 'Jun 2026' } })
    expect(button?.textContent).toBe('Why')
  })

  it('shows a missing tag even when the cell has no attribution of its own', () => {
    const { button } = renderButton({ attribution: false, summary: { state: 'missing', canEdit: false } })
    expect(button?.textContent).toBe('Why?No exec summary yet')
  })

  it('shows Why: and the excerpt for a written summary, the excerpt as the description', () => {
    const { button } = renderButton({ summary: written })
    expect(button?.textContent).toBe(`Why:${written.excerpt}`)
    expect(button?.getAttribute('aria-label')).toBe('Why Uptime is 99.06% in Oct 2026: exec summary by Avery Admin')
    expect(button?.getAttribute('aria-description')).toBe(written.excerpt)
    const excerpt = screen.getByText(written.excerpt)
    expect(excerpt.className).toContain('truncate')
    expect(excerpt.className).toContain('text-ink/80')
  })

  it('tags a stale summary Review for admins only', () => {
    const admin = renderButton({ summary: { ...written, state: 'stale', canEdit: true } })
    expect(screen.getByText('Review').className).toContain('border-status-y')
    expect(admin.button?.getAttribute('aria-label')).toBe(
      'Why Uptime is 99.06% in Oct 2026: exec summary by Avery Admin. Exec summary may be out of date',
    )
    admin.unmount()
    renderButton({ summary: { ...written, state: 'stale', canEdit: false } })
    expect(screen.queryByText('Review')).toBeNull()
  })
})

describe('WhyButton: the summary prefix on attention cards', () => {
  it('reads Summary: with the excerpt', () => {
    const { button } = renderButton({ prefix: 'summary', summary: written })
    expect(button?.textContent).toBe(`Summary:${written.excerpt}`)
  })

  it('reads the missing tag alone, for admins and for others', () => {
    const a = renderButton({ prefix: 'summary', summary: { state: 'missing', canEdit: true } })
    expect(a.button?.textContent).toBe('Exec summary needed')
    a.unmount()
    const b = renderButton({ prefix: 'summary', summary: { state: 'missing', canEdit: false } })
    expect(b.button?.textContent).toBe('No exec summary yet')
  })

  it('keeps Review on a stale summary for admins', () => {
    const { button } = renderButton({ prefix: 'summary', summary: { ...written, state: 'stale', canEdit: true } })
    expect(button?.textContent).toBe(`Summary:${written.excerpt}Review`)
  })

  it('falls back to Why? where there is no summary state', () => {
    const { button } = renderButton({ prefix: 'summary' })
    expect(button?.textContent).toBe('Why?')
  })
})

describe('WhyButton: compact and hints', () => {
  it('keeps compact buttons to one word', () => {
    const a = renderButton({ compact: true, summary: written })
    expect(a.button?.textContent).toBe('Summary')
    a.unmount()
    const b = renderButton({ compact: true, summary: { ...written, state: 'stale', canEdit: true } })
    expect(b.button?.textContent).toBe('Review')
    b.unmount()
    const c = renderButton({ compact: true, summary: { state: 'missing', canEdit: true } })
    expect(c.button?.textContent).toBe('Needed')
    expect(c.button?.getAttribute('aria-label')).toBe('Why is Uptime 99.06% in Oct 2026? Exec summary needed')
    c.unmount()
    const d = renderButton({ compact: true })
    expect(d.button?.textContent).toBe('Why')
  })

  it('keeps hints in aria-description, not in the name', () => {
    const first = renderButton({ hint: 'Press Enter for why', nameSubject: false })
    expect(first.button?.getAttribute('aria-label')).toBe('Why is 99.06% in Oct 2026?')
    expect(first.button?.getAttribute('aria-description')).toBe('Press Enter for why')
    first.unmount()
    const second = renderButton({ summary: written, hint: 'Press Enter for why' })
    expect(second.button?.getAttribute('aria-description')).toBe(`${written.excerpt} Press Enter for why`)
  })

  it('is a 24px dialog trigger that opens with its own element', async () => {
    const { button, onOpen } = renderButton()
    expect(button?.className).toContain('min-h-6')
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(button!)
    expect(onOpen).toHaveBeenCalledWith(button)
  })

  it('has no axe violations in any state', async () => {
    const states: (SummaryDisplay | undefined)[] = [
      undefined,
      { state: 'missing', canEdit: true },
      { state: 'missing', canEdit: false },
      written,
      { ...written, state: 'stale', canEdit: true },
    ]
    const { container } = render(
      <div>
        {states.map((s, i) => (
          <WhyButton key={i} summary={s} onOpen={() => {}} {...common} />
        ))}
      </div>,
    )
    expect((await axe(container)).violations).toEqual([])
  })
})
