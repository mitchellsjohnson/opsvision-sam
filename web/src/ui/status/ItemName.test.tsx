import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ItemName } from './ItemName'

const NAME = 'Customer Portal - Private Cloud Tenant Suite'

function truncated(on: boolean) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(on ? 200 : 100)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
}

afterEach(() => vi.restoreAllMocks())

describe('ItemName', () => {
  it('the full name is the text; the head shortens, the tail keeps its separator on one line', () => {
    const { container } = render(<ItemName name={NAME} group="Platform" />)
    const root = container.querySelector('[data-name]')!
    expect(root.textContent).toBe(NAME)
    const [head, tail] = [...root.children] as HTMLElement[]
    expect(head!.textContent).toBe('Customer Portal')
    expect(head!.className).toContain('truncate')
    expect(tail!.textContent).toBe(' - Private Cloud Tenant Suite')
    expect(tail!.className).toContain('whitespace-pre')
    expect(tail!.className).toContain('text-ellipsis')
    expect(tail!.className).not.toContain('truncate')
    expect(root.getAttribute('title')).toBeNull()
    // A tail too long for its space is cut at its start, keeping the ending siblings differ in.
    expect(tail!.className).toContain('[direction:rtl]')
    expect(tail!.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    expect(tail!.className).toContain('max-w-[calc(100%-4ch)]')
  })

  it('the gap before the tail is drawn at the end of the head, so a cut head’s ellipsis takes it: no double gap', () => {
    const { container } = render(<ItemName name={NAME} />)
    const root = container.querySelector('[data-name]')!
    const [head] = [...root.children] as HTMLElement[]
    // `[data-name-head]::after` (index.css) draws a no-break space inside the truncating head.
    expect(head!.hasAttribute('data-name-head')).toBe(true)
    expect(head!.className).toContain('truncate')
    // The tail's own leading space stays in the text, not drawn.
    const gap = root.querySelector('[data-gap]')!
    expect(gap.textContent).toBe(' ')
    expect(gap.className).toContain('hidden')
    expect(root.textContent).toBe(NAME)
  })

  it('a name with no head draws no gap', () => {
    const { container } = render(<ItemName name="Edge Cache" />)
    expect(container.querySelector('[data-name-head]')).toBeNull()
    expect(container.querySelector('[data-gap]')).toBeNull()
  })

  it('a name with no head is all tail, truncated at its end', () => {
    const { container } = render(<ItemName name="Edge Cache" />)
    const root = container.querySelector('[data-name]')!
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.className).toContain('truncate')
  })

  it('pointer hover on a truncated name shows the full name and group', async () => {
    truncated(true)
    render(<ItemName name={NAME} group="Platform" />)
    await userEvent.setup().hover(screen.getByText('Customer Portal'))
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe(`${NAME} · Platform`)
  })

  it('no tooltip when the name fits', async () => {
    truncated(false)
    render(<ItemName name={NAME} group="Platform" />)
    const user = userEvent.setup()
    await user.hover(screen.getByText('Customer Portal'))
    await new Promise((r) => setTimeout(r, 500))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('has no axe violations', async () => {
    const { container } = render(<ItemName name={NAME} group="Platform" />)
    expect((await axe(container)).violations).toEqual([])
  })
})
