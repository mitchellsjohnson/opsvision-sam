import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { NavDrawer } from './NavDrawer'

function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={button} type="button" aria-expanded={open} onClick={() => setOpen(true)}>
        Open navigation
      </button>
      <NavDrawer open={open} onOpenChange={setOpen} returnFocus={button}>
        <nav aria-label="Main">
          <ul>
            <li>
              <a href="#one">First link</a>
            </li>
            <li>
              <a href="#two">Second link</a>
            </li>
            <li>
              <button type="button">A button</button>
            </li>
          </ul>
        </nav>
      </NavDrawer>
    </>
  )
}

describe('NavDrawer', () => {
  it('renders nothing while closed', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('link', { name: 'First link' })).toBeNull()
  })

  it('opens as a full-height left drawer with its content and focuses the first link', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    for (const cls of ['fixed', 'inset-y-0', 'left-0', 'w-[min(320px,85vw)]']) {
      expect(dialog.classList.contains(cls), cls).toBe(true)
    }
    expect(within(dialog).getByRole('navigation', { name: 'Main' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('link', { name: 'First link' })))
  })

  it('closes on Esc and returns focus to the opener', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const opener = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(opener)
    await screen.findByRole('dialog', { name: 'Navigation' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('closes from its close button and returns focus to the opener', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const opener = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    const close = within(dialog).getByRole('button', { name: 'Close navigation' })
    expect(close.classList.contains('size-8')).toBe(true)
    await user.click(close)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('closes when a link in it is activated, and returns focus to the opener', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const opener = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    await user.click(within(dialog).getByRole('link', { name: 'Second link' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('stays open when something other than a link is pressed', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    await user.click(within(dialog).getByRole('button', { name: 'A button' }))
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy()
  })

  it('has no accessibility violations while open', async () => {
    const { baseElement } = render(<Harness initiallyOpen />)
    await screen.findByRole('dialog', { name: 'Navigation' })
    expect((await axe(baseElement)).violations).toEqual([])
  })
})
