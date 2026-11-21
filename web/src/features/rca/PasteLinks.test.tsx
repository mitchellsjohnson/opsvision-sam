import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { RcaLink } from '../../api/queries'
import { PasteLinks } from './PasteLinks'

function renderPaste(existing: RcaLink[] = []) {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  render(<PasteLinks existing={existing} onAdd={onAdd} onClose={onClose} />)
  const box = screen.getByRole('textbox', { name: 'Paste links' })
  return { user: userEvent.setup(), box, onAdd, onClose }
}

describe('PasteLinks (Review Focus 4)', () => {
  it('adds the https lines and lists the rest; blank lines are ignored, the duplicate is reported', async () => {
    const { user, box, onAdd } = renderPaste()
    expect(screen.getByText('One https link per line.')).toBeTruthy()
    await user.click(box)
    await user.paste(
      [
        'https://tracker.example/browse/INC-2041',
        'https://oncall.example/incidents/88412',
        'http://x',
        'javascript:alert(1)',
        '',
        'https://tracker.example/browse/INC-2041',
      ].join('\n'),
    )
    expect(onAdd).toHaveBeenCalledOnce()
    expect(onAdd).toHaveBeenCalledWith([
      { title: 'INC-2041', url: 'https://tracker.example/browse/INC-2041' },
      { title: '88412', url: 'https://oncall.example/incidents/88412' },
    ])
    expect(screen.getByText('2 links added.')).toBeTruthy()
    expect(
      screen.getByText(
        '3 lines are not https links: http://x, javascript:alert(1), https://tracker.example/browse/INC-2041 (already listed)',
      ),
    ).toBeTruthy()
    // What was not added stays in the box to fix.
    expect((box as HTMLTextAreaElement).value).toBe('http://x\njavascript:alert(1)\nhttps://tracker.example/browse/INC-2041')
  })

  it('reports links already in the list', async () => {
    const { user, box, onAdd } = renderPaste([{ title: 'INC-2041', url: 'https://tracker.example/browse/INC-2041' }])
    await user.click(box)
    await user.paste('https://tracker.example/browse/INC-2041')
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.getByText('1 line is not an https link: https://tracker.example/browse/INC-2041 (already listed)')).toBeTruthy()
  })

  it('adds up to 25 links and says so', async () => {
    const existing = Array.from({ length: 23 }, (_, i) => ({ title: `L${i}`, url: `https://docs.example/${i}` }))
    const { user, box, onAdd } = renderPaste(existing)
    await user.click(box)
    await user.paste('https://a.example/1\nhttps://a.example/2\nhttps://a.example/3\nhttps://a.example/4')
    expect(onAdd.mock.calls[0]![0]).toHaveLength(2)
    expect(screen.getByText('Up to 25 links')).toBeTruthy()
  })

  it('adds typed lines with Add links, and closes with Done', async () => {
    const { user, box, onAdd, onClose } = renderPaste()
    await user.type(box, 'https://docs.example/runbooks/relay')
    await user.click(screen.getByRole('button', { name: 'Add links' }))
    expect(onAdd).toHaveBeenCalledWith([{ title: 'relay', url: 'https://docs.example/runbooks/relay' }])
    expect((box as HTMLTextAreaElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has no axe violations', async () => {
    const { container } = render(<PasteLinks existing={[]} onAdd={() => {}} onClose={() => {}} />)
    expect((await axe(container)).violations).toEqual([])
  })
})
