import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SHORTCUTS_KEY, useDialogShortcuts, type DialogShortcutHandlers } from './useDialogShortcuts'

type Handlers = DialogShortcutHandlers

function handlers() {
  return {
    prev: vi.fn<() => void>(),
    next: vi.fn<() => void>(),
    range: vi.fn<(n: 1 | 2 | 3 | 4 | 5) => void>(),
    table: vi.fn<() => void>(),
    copyLink: vi.fn<() => void>(),
    present: vi.fn<() => void>(),
  }
}

function Harness({ h, rangeKeys }: { h: Handlers; rangeKeys?: 3 | 5 }) {
  const ref = useRef<HTMLDivElement>(null)
  const { enabled, setEnabled } = useDialogShortcuts(ref, h, rangeKeys ? { rangeKeys } : undefined)
  return (
    <div ref={ref} role="dialog" aria-label="Harness">
      <button type="button">Plain</button>
      <input aria-label="Filter" />
      <div role="grid" aria-label="Grid">
        <div role="row">
          <button type="button" role="gridcell">Cell</button>
        </div>
      </div>
      <div role="menu" aria-label="Menu">
        <button type="button" role="menuitem">Item</button>
      </div>
      <div role="radiogroup" aria-label="Sort">
        <button type="button" role="radio" aria-checked="true">Worst</button>
      </div>
      <button type="button" data-point-button="">Oct: 84.3%</button>
      <div data-range-strip="">
        <button type="button">12M</button>
      </div>
      <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled(!enabled)}>
        Shortcuts: {enabled ? 'On' : 'Off'}
      </button>
    </div>
  )
}

function none(h: Partial<ReturnType<typeof handlers>>) {
  for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled()
}

describe('useDialogShortcuts', () => {
  it('arrow keys move between metrics; T, L and P run their actions', async () => {
    const h = handlers()
    render(<Harness h={h} />)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(h.next).toHaveBeenCalledTimes(1)
    await user.keyboard('{ArrowLeft}')
    expect(h.prev).toHaveBeenCalledTimes(1)
    await user.keyboard('tlp')
    expect(h.table).toHaveBeenCalledTimes(1)
    expect(h.copyLink).toHaveBeenCalledTimes(1)
    expect(h.present).toHaveBeenCalledTimes(1)
    await user.keyboard('4')
    expect(h.range).toHaveBeenCalledWith(4)
  })

  it('does nothing while Cmd, Ctrl or Alt is held', async () => {
    const h = handlers()
    render(<Harness h={h} />)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('{Meta>}{ArrowRight}{/Meta}')
    await user.keyboard('{Control>}l{/Control}')
    await user.keyboard('{Alt>}t{/Alt}')
    await user.keyboard('{Meta>}p{/Meta}')
    none(h)
  })

  it.each([
    ['an input', () => screen.getByRole('textbox', { name: 'Filter' })],
    ['a grid', () => screen.getByRole('gridcell', { name: 'Cell' })],
    ['a menu', () => screen.getByRole('menuitem', { name: 'Item' })],
    ['a radio group', () => screen.getByRole('radio', { name: 'Worst' })],
    ['a chart point button', () => screen.getByRole('button', { name: 'Oct: 84.3%' })],
    ['the range strip', () => screen.getByRole('button', { name: '12M' })],
  ])('is ignored inside %s', async (_where, target) => {
    const h = handlers()
    render(<Harness h={h} />)
    const user = userEvent.setup()
    const el = target()
    el.focus()
    // An input takes the letters as text; elsewhere they would be shortcuts.
    await user.keyboard('t')
    await user.keyboard('{ArrowRight}')
    await user.keyboard('2')
    none(h)
  })

  it('ignores auto-repeat from a held key', () => {
    const h = handlers()
    render(<Harness h={h} />)
    const plain = screen.getByRole('button', { name: 'Plain' })
    plain.focus()
    fireEvent.keyDown(plain, { key: 'ArrowRight' })
    fireEvent.keyDown(plain, { key: 'ArrowRight', repeat: true })
    fireEvent.keyDown(plain, { key: 'ArrowRight', repeat: true })
    fireEvent.keyDown(plain, { key: 'ArrowLeft', repeat: true })
    fireEvent.keyDown(plain, { key: 't', repeat: true })
    fireEvent.keyDown(plain, { key: '2', repeat: true })
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.prev).not.toHaveBeenCalled()
    expect(h.table).not.toHaveBeenCalled()
    expect(h.range).not.toHaveBeenCalled()
  })

  it('ignores a key another handler has already taken', async () => {
    const h = handlers()
    render(<Harness h={h} />)
    const plain = screen.getByRole('button', { name: 'Plain' })
    plain.addEventListener('keydown', (e) => e.preventDefault())
    plain.focus()
    await userEvent.setup().keyboard('t')
    none(h)
  })

  it('with three range keys, 5 does nothing and 3 selects the third range', async () => {
    const h = handlers()
    render(<Harness h={h} rangeKeys={3} />)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('5')
    await user.keyboard('4')
    expect(h.range).not.toHaveBeenCalled()
    await user.keyboard('3')
    expect(h.range).toHaveBeenCalledWith(3)
  })

  it('without a range handler, number keys do nothing', async () => {
    const { prev, next, table, copyLink, present } = handlers()
    const rest = { prev, next, table, copyLink, present }
    render(<Harness h={rest} />)
    screen.getByRole('button', { name: 'Plain' }).focus()
    await userEvent.setup().keyboard('2')
    none(rest)
  })

  it('turning shortcuts off is remembered on the device', async () => {
    const h = handlers()
    const { unmount } = render(<Harness h={h} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Shortcuts: On' }))
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBe('off')
    expect(SHORTCUTS_KEY).toBe('opsvision.shortcuts')
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('p')
    await user.keyboard('{ArrowRight}')
    none(h)
    unmount()

    render(<Harness h={h} />)
    const toggle = screen.getByRole('switch', { name: 'Shortcuts: Off' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('p')
    none(h)
    // Turning them back on clears the stored choice.
    await user.click(toggle)
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBeNull()
    screen.getByRole('button', { name: 'Plain' }).focus()
    await user.keyboard('p')
    expect(h.present).toHaveBeenCalledTimes(1)
  })

  it('ignores keys from outside its element', async () => {
    const h = handlers()
    render(
      <>
        <button type="button">Outside</button>
        <Harness h={h} />
      </>,
    )
    screen.getByRole('button', { name: 'Outside' }).focus()
    await userEvent.setup().keyboard('{ArrowRight}t')
    none(h)
  })
})
