import { act, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useGridNavigation } from './useGridNavigation'

type Api = ReturnType<typeof useGridNavigation>
type Opts = Parameters<typeof useGridNavigation>[0]

const ROWS = ['r1', 'r2', 'r3']

function Harness({
  colCount = 4,
  apiRef,
  drawn = ROWS,
  ...opts
}: Partial<Opts> & { apiRef?: { current: Api | null }; drawn?: string[] }) {
  const nav = useGridNavigation({ rowIds: ROWS, colCount, anchor: 'start', onOpen: () => {}, ...opts })
  useLayoutEffect(() => {
    if (apiRef) apiRef.current = nav
  })
  return (
    <div role="grid" aria-label="Harness">
      {drawn.map((rowId) => (
        <div role="row" key={rowId}>
          {Array.from({ length: colCount }, (_, col) => (
            <button key={col} type="button" {...nav.cellProps(rowId, col)}>
              {`${rowId}:${col}`}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

const focused = () => document.activeElement?.textContent
const tabbable = () => screen.getAllByRole('button').filter((b) => b.tabIndex === 0)

describe('useGridNavigation', () => {
  it('is one tab stop at the first cell; arrows move focus', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    expect(tabbable().map((b) => b.textContent)).toEqual(['r1:0'])
    await user.tab()
    expect(focused()).toBe('r1:0')
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('r1:1')
    await user.keyboard('{ArrowDown}')
    expect(focused()).toBe('r2:1')
    await user.keyboard('{ArrowLeft}')
    expect(focused()).toBe('r2:0')
    await user.keyboard('{ArrowLeft}')
    expect(focused()).toBe('r2:0')
    await user.keyboard('{ArrowUp}')
    expect(focused()).toBe('r1:0')
    await user.keyboard('{ArrowUp}')
    expect(focused()).toBe('r1:0')
    expect(tabbable()).toHaveLength(1)
  })

  it('Home goes to the first period and End to the selected one', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{End}')
    expect(focused()).toBe('r1:3')
    await user.keyboard('{Home}')
    expect(focused()).toBe('r1:0')
  })

  it('PageDown and PageUp move by the page size', async () => {
    render(<Harness pageSize={2} />)
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{PageDown}')
    expect(focused()).toBe('r3:0')
    await user.keyboard('{PageDown}')
    expect(focused()).toBe('r3:0')
    await user.keyboard('{PageUp}')
    expect(focused()).toBe('r1:0')
  })

  it('Enter and Space open the active cell', async () => {
    const onOpen = vi.fn()
    render(<Harness onOpen={onOpen} />)
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowDown}{End}{Enter}')
    const cell = screen.getByRole('button', { name: 'r2:3' })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('r2', 3, cell)
    await user.keyboard(' ')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('takes the active cell from focus by pointer or script', () => {
    render(<Harness />)
    act(() => screen.getByRole('button', { name: 'r3:2' }).focus())
    expect(tabbable().map((b) => b.textContent)).toEqual(['r3:2'])
  })

  it('focusRow focuses a row at the active column', async () => {
    const api = { current: null as Api | null }
    render(<Harness apiRef={api} />)
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    act(() => api.current!.focusRow('r3'))
    expect(focused()).toBe('r3:2')
    expect(api.current!.active).toEqual({ rowId: 'r3', col: 2 })
    act(() => api.current!.focusRow('r1', 0))
    expect(focused()).toBe('r1:0')
  })

  it('keeps the selected period when the column count changes with anchor end', async () => {
    const { rerender } = render(<Harness anchor="end" />)
    expect(tabbable().map((b) => b.textContent)).toEqual(['r1:3'])
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowDown}{ArrowLeft}')
    expect(focused()).toBe('r2:2')
    rerender(<Harness anchor="end" colCount={2} />)
    expect(tabbable().map((b) => b.textContent)).toEqual(['r2:0'])
    rerender(<Harness anchor="end" colCount={4} />)
    expect(tabbable().map((b) => b.textContent)).toEqual(['r2:2'])
  })

  it('a move queued for a cell not yet drawn lands when it is drawn', () => {
    const api = { current: null as Api | null }
    const { rerender } = render(<Harness apiRef={api} drawn={['r1', 'r2']} />)
    act(() => api.current!.focusRow('r3', 1))
    rerender(<Harness apiRef={api} />)
    expect(focused()).toBe('r3:1')
  })

  it('a queued move is dropped once focus goes to another cell', () => {
    const api = { current: null as Api | null }
    const { rerender } = render(<Harness apiRef={api} drawn={['r1', 'r2']} />)
    act(() => api.current!.focusRow('r3', 1))
    act(() => screen.getByRole('button', { name: 'r1:0' }).focus())
    rerender(<Harness apiRef={api} />)
    expect(focused()).toBe('r1:0')
  })

  it('a queued move is dropped once focus leaves the grid', () => {
    const api = { current: null as Api | null }
    const { rerender } = render(
      <>
        <button type="button">Outside</button>
        <Harness apiRef={api} drawn={['r1', 'r2']} />
      </>,
    )
    act(() => api.current!.focusRow('r3', 1))
    act(() => screen.getByRole('button', { name: 'Outside' }).focus())
    rerender(
      <>
        <button type="button">Outside</button>
        <Harness apiRef={api} />
      </>,
    )
    expect(focused()).toBe('Outside')
  })

  it('a later move replaces a queued one', () => {
    const api = { current: null as Api | null }
    const { rerender } = render(<Harness apiRef={api} drawn={['r1', 'r2']} />)
    act(() => api.current!.focusRow('r3', 1))
    act(() => api.current!.focusRow('r2', 0))
    expect(focused()).toBe('r2:0')
    rerender(<Harness apiRef={api} />)
    expect(focused()).toBe('r2:0')
  })

  it('cellPropsFor keeps its identity while the column count holds, so memoized rows can skip', () => {
    const seen = new Set<unknown>()
    function Probe({ n, cols = 2 }: { n: number; cols?: number }) {
      const nav = useGridNavigation({ rowIds: ROWS.slice(0, n), colCount: cols, anchor: 'end', onOpen: () => {} })
      seen.add(nav.cellPropsFor)
      return null
    }
    const { rerender } = render(<Probe n={3} />)
    rerender(<Probe n={2} />)
    rerender(<Probe n={3} />)
    expect(seen.size).toBe(1)
    rerender(<Probe n={3} cols={4} />)
    expect(seen.size).toBe(2)
  })

  it('cellPropsFor gives the tab stop to the cell it is told is active', () => {
    function Probe() {
      const nav = useGridNavigation({ rowIds: ROWS, colCount: 4, anchor: 'end', onOpen: () => {} })
      return (
        <button type="button" {...nav.cellPropsFor('r2', 1, 1, true)}>
          cell
        </button>
      )
    }
    render(<Probe />)
    const cell = screen.getByRole('button', { name: 'cell' })
    expect(cell.tabIndex).toBe(0)
    expect(cell.dataset.pos).toBe('1:2')
  })

  it('anchors to the selected period: after End, a narrower grid stays on its last column', () => {
    const { rerender } = render(<Harness anchor="end" />)
    rerender(<Harness anchor="end" colCount={2} />)
    expect(tabbable().map((b) => b.textContent)).toEqual(['r1:1'])
  })
})

/** A grid whose rows end in a trailing cell (`r:T`) after the selected period, except the rows in `spacers`. */
function TrailingHarness({ spacers = [], colCount = 4, ...opts }: Partial<Opts> & { spacers?: string[] }) {
  const nav = useGridNavigation({ rowIds: ROWS, colCount, anchor: 'end', trailing: true, onOpen: () => {}, ...opts })
  return (
    <>
      <input aria-label="Filter" />
      <div role="grid" aria-label="Harness">
        {ROWS.map((rowId) => (
          <div role="row" key={rowId}>
            {Array.from({ length: colCount }, (_, col) => (
              <button key={col} type="button" {...nav.cellProps(rowId, col)}>
                {`${rowId}:${col}`}
              </button>
            ))}
            {!spacers.includes(rowId) && (
              <button type="button" {...nav.cellProps(rowId, colCount)}>
                {`${rowId}:T`}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

describe('useGridNavigation with a trailing cell', () => {
  it('the first tab stop and End stay on the selected period; → reaches the trailing cell and ← returns', async () => {
    render(<TrailingHarness />)
    expect(tabbable().map((b) => b.textContent)).toEqual(['r1:3'])
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    expect(focused()).toBe('r1:3')
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('r1:T')
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('r1:T')
    await user.keyboard('{End}')
    expect(focused()).toBe('r1:3')
    await user.keyboard('{ArrowRight}{ArrowLeft}')
    expect(focused()).toBe('r1:3')
    await user.keyboard('{Home}{End}')
    expect(focused()).toBe('r1:3')
  })

  it('↓ and ↑ keep to the trailing column; a spacer row keeps → on the selected period', async () => {
    render(<TrailingHarness spacers={['r2']} />)
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(focused()).toBe('r2:3')
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('r2:3')
    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(focused()).toBe('r3:T')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(focused()).toBe('r1:3')
  })

  it('Enter on the trailing cell opens it as the column after the last period', async () => {
    const onOpen = vi.fn()
    render(<TrailingHarness onOpen={onOpen} />)
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onOpen).toHaveBeenCalledWith('r1', 4, screen.getByRole('button', { name: 'r1:T' }))
  })

  it('W calls onWhy for the cell; not with Ctrl, Cmd or Alt, and never from an input', async () => {
    const onWhy = vi.fn()
    const onOpen = vi.fn()
    render(<TrailingHarness onWhy={onWhy} onOpen={onOpen} />)
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    await user.keyboard('{ArrowLeft}w')
    expect(onWhy).toHaveBeenCalledWith('r1', 2, screen.getByRole('button', { name: 'r1:2' }))
    await user.keyboard('{ArrowRight}{ArrowRight}W')
    expect(onWhy).toHaveBeenLastCalledWith('r1', 4, screen.getByRole('button', { name: 'r1:T' }))
    expect(onWhy).toHaveBeenCalledTimes(2)
    await user.keyboard('{Control>}w{/Control}{Meta>}w{/Meta}{Alt>}w{/Alt}')
    expect(onWhy).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('textbox', { name: 'Filter' }))
    await user.keyboard('w')
    expect(onWhy).toHaveBeenCalledTimes(2)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('W typed in an input inside a cell is the input’s', async () => {
    const onWhy = vi.fn()
    function Probe() {
      const nav = useGridNavigation({ rowIds: ['r1'], colCount: 1, anchor: 'end', onOpen: () => {}, onWhy })
      return (
        <div role="grid" aria-label="Probe">
          <div role="row">
            <div role="gridcell" {...nav.cellProps('r1', 0)}>
              <input aria-label="Note" />
            </div>
          </div>
        </div>
      )
    }
    render(<Probe />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Note' }))
    await user.keyboard('w')
    expect(onWhy).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: 'Note' }) as HTMLInputElement).value).toBe('w')
  })

  it('without onWhy, W does nothing', async () => {
    render(<TrailingHarness />)
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    await user.keyboard('w')
    expect(focused()).toBe('r1:3')
  })
})
