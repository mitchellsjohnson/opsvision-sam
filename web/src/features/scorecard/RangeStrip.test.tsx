import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
