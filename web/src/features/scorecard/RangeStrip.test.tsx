import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { RangeStrip } from './RangeStrip'

describe('RangeStrip', () => {
  it('keeps each change on one line: three ranges a row on phones, five from 640px', () => {
    render(
      <RangeStrip
        selected="12M"
        onSelect={() => {}}
        caption="Change from the first month in each range to Oct 2026"
        changeFor={(key) => (key === '24M' ? null : { text: '8.8% worse', move: { arrow: '▲', tone: 'bad' } })}
      />,
    )
    const group = screen.getByRole('group', { name: 'Range' })
    expect(group.className).toContain('grid-cols-3')
    expect(group.className).toContain('sm:grid-cols-5')
    const tab = screen.getByRole('button', { name: '12M, change 8.8% worse' })
    const change = tab.querySelector<HTMLElement>('[data-tone]')!
    expect(change.className).toContain('whitespace-nowrap')
    expect(change.className).toContain('text-[11px]')
    expect(change.textContent).toBe('▲8.8% worse')
  })

  it('a range whose first column has no value says No data then, is inert and skipped by the arrow keys', async () => {
    const onSelect = vi.fn()
    const { container } = render(
      <RangeStrip
        selected="12M"
        onSelect={onSelect}
        caption="Change from the first month in each range to Oct 2026"
        changeFor={(key) => (key === '6M' || key === '24M' ? null : { text: '+0.2 pts', move: { arrow: '▲', tone: 'good' } })}
        noDataFor={(key) => key === '6M' || key === '24M'}
      />,
    )
    const six = screen.getByRole('button', { name: '6M, no data then' })
    expect(six.getAttribute('aria-disabled')).toBe('true')
    expect(six.textContent).toBe('6MNo data then')
    const note = six.querySelector<HTMLElement>('[data-no-data]')!
    expect(note.className).toContain('text-[11px]')
    expect(note.className).toContain('text-ink/70')
    const user = userEvent.setup()
    await user.click(six)
    expect(onSelect).not.toHaveBeenCalled()

    screen.getByRole('button', { name: '3M, change +0.2 pts' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '12M, change +0.2 pts' }))
    await user.keyboard('{ArrowRight}{ArrowRight}')
    // 24M has no data either, so the last stop is YTD and the keys wrap to 3M.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '3M, change +0.2 pts' }))
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'YTD, change +0.2 pts' }))
    expect((await axe(container)).violations).toEqual([])
  })

  it('the selected range keeps its styling and tab stop when it has no data then; only unselected ones are inert', async () => {
    const onSelect = vi.fn()
    const { container } = render(
      <RangeStrip
        selected="12M"
        onSelect={onSelect}
        caption="Change from the first month in each range to Oct 2026"
        changeFor={() => ({ text: '+0.2 pts', move: { arrow: '▲', tone: 'good' } })}
        noDataFor={(key) => key === '12M' || key === 'YTD'}
      />,
    )
    const twelve = screen.getByRole('button', { name: '12M, no data then' })
    expect(twelve.getAttribute('aria-pressed')).toBe('true')
    expect(twelve.hasAttribute('aria-disabled')).toBe(false)
    expect(twelve.tabIndex).toBe(0)
    expect(twelve.className).toContain('font-semibold')
    expect(twelve.className).toContain('shadow-[inset_0_-2px_0_var(--color-accent)]')
    expect(twelve.className).not.toContain('cursor-default')
    expect(twelve.textContent).toBe('12MNo data then')
    const ytd = screen.getByRole('button', { name: 'YTD, no data then' })
    expect(ytd.getAttribute('aria-disabled')).toBe('true')
    expect(ytd.tabIndex).toBe(-1)

    const user = userEvent.setup()
    screen.getByRole('button', { name: '6M, change +0.2 pts' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(twelve)
    await user.keyboard('{ArrowRight}')
    // YTD is inert, so the next stop is 24M.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '24M, change +0.2 pts' }))
    expect((await axe(container)).violations).toEqual([])
  })

  it('a range without the no-data mark that has no change still reads a dash', () => {
    render(<RangeStrip selected="12M" onSelect={() => {}} caption="" changeFor={() => null} />)
    expect(screen.getByRole('button', { name: '24M, change not available' }).textContent).toBe('24M—')
  })
})
