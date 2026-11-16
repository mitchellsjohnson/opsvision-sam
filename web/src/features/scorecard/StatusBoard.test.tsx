import * as Tooltip from '@radix-ui/react-tooltip'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { buildTrendColumns, type Column } from './columns'
import { StatusBoard, StatusCellTip } from './StatusBoard'
import type { BoardCell, BoardRow } from './logic/statusBoard'

const SCALE = [
  { key: 'G', label: 'On track', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Watch', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Off track', color: '#B42318', rank: 3 },
]

const MONTHS = buildTrendColumns('2026-M10', 1)

function status(col: Column, s: string, display = ''): BoardCell {
  return { key: col.key, kind: 'status', status: s, display, naReason: '', change: null, caption: '' }
}

function empty(col: Column, kind: BoardCell['kind'], over: Partial<BoardCell> = {}): BoardCell {
  return { key: col.key, kind, status: '', display: '', naReason: '', change: null, caption: '', ...over }
}

function boardRow(key: string, name: string, cells: BoardCell[], over: Partial<BoardRow> = {}): BoardRow {
  const last = cells[cells.length - 1]
  return {
    key,
    name,
    category: { id: 'delivery', name: 'Delivery' },
    cells,
    current: last?.kind === 'status' ? last.display : '',
    caption: '',
    change: null,
    ...over,
  }
}

function rowsFor(columns: Column[]): BoardRow[] {
  const n = columns.length
  const epics = columns.map((c, i) =>
    i === n - 1 ? { ...status(c, 'R', '79%'), change: '-12 pts vs Sep' } : status(c, 'G', '90%'),
  )
  const feedback = columns.map((c, i): BoardCell =>
    i === 0
      ? empty(c, 'na', { naReason: 'No ideas this month' })
      : i === 1
        ? empty(c, 'missing')
        : i === 2
          ? empty(c, 'unrated', { display: '12 days' })
          : status(c, 'Y', '15 days'),
  )
  const audit = columns.map((c) => empty(c, 'missing'))
  return [
    boardRow('epics', 'Epics delivered on time', epics, {
      change: { text: '-12 pts vs Sep', move: { arrow: '▼', tone: 'bad' } },
    }),
    boardRow('feedback', 'Customer feedback SLO', feedback, { category: { id: 'product', name: 'Product' } }),
    boardRow('audit', 'Accessibility compliance', audit, { category: { id: 'design', name: 'Design' } }),
  ]
}

function renderBoard({ columns = MONTHS, label = '12-month status', rows = rowsFor(columns), onOpen = vi.fn() } = {}) {
  render(
    <Tooltip.Provider>
      <StatusBoard label={label} columns={columns} rows={rows} scale={SCALE} onOpen={onOpen} />
    </Tooltip.Provider>,
  )
  return onOpen
}

/** Makes every element report `width` and returns a function that resizes the board. */
function measuredAt(initial: number): (next: number) => void {
  const callbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        callbacks.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  let width = initial
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 0 }) as DOMRect)
  return (next) => {
    width = next
    act(() => callbacks.forEach((cb) => cb()))
  }
}

function cleanupAndRender(rows: BoardRow[]) {
  cleanup()
  renderBoard({ rows })
}

const SELECTED_EPICS = 'Epics delivered on time, Oct 2026: Off track, 79%, down 12 pts vs Sep'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StatusBoard', () => {
  it('is a labelled grid with month column headers and metric row headers', () => {
    renderBoard()
    const grid = screen.getByRole('grid', { name: '12-month status' })
    const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(expect.arrayContaining(['Nov', 'Dec', 'Jan', 'Sep', 'Oct', 'FY2025', 'FY2026']))
    for (const h of within(grid).getAllByRole('columnheader')) {
      if (/^[A-Z][a-z]{2}$/.test(h.textContent ?? '')) expect(h.getAttribute('scope')).toBe('col')
    }
    const rowHeader = within(grid).getByRole('rowheader', { name: 'Epics delivered on time' })
    expect(rowHeader.getAttribute('scope')).toBe('row')
    expect(rowHeader.getAttribute('title')).toBe('Epics delivered on time')
  })

  it('cells show only the letter; the name says metric, period, status and value, and the selected one the change', () => {
    renderBoard()
    expect(screen.getByRole('button', { name: SELECTED_EPICS }).textContent).toBe('R')
    expect(screen.getByRole('button', { name: 'Epics delivered on time, Sep 2026: On track, 90%' }).textContent).toBe('G')
  })

  it('fills cells exception-first: green soft, yellow outlined, red solid', () => {
    renderBoard()
    const green = screen.getByRole('button', { name: /^Epics delivered on time, Sep 2026/ })
    const yellow = screen.getByRole('button', { name: /^Customer feedback SLO, Oct 2026/ })
    const red = screen.getByRole('button', { name: /^Epics delivered on time, Oct 2026/ })
    expect([green, yellow, red].map((b) => b.dataset.tier)).toEqual(['soft', 'outline', 'solid'])
    expect(yellow.style.borderColor).toBe('rgb(138, 90, 0)')
    expect(red.style.color).toBe('rgb(255, 255, 255)')
  })

  it('every cell has a visible focus ring', () => {
    renderBoard()
    const cell = screen.getByRole('button', { name: SELECTED_EPICS })
    expect(cell.className).toContain('focus-visible:outline-ink')
    expect(cell.className).toContain('focus-visible:outline-offset-1')
  })

  it('draws no data as a dot, n/a hatched, and a value with no status as unrated', () => {
    renderBoard()
    const na = screen.getByRole('button', { name: 'Customer feedback SLO, Nov 2025: Not applicable, No ideas this month' })
    const none = screen.getByRole('button', { name: 'Customer feedback SLO, Dec 2025: No data' })
    const unrated = screen.getByRole('button', { name: 'Customer feedback SLO, Jan 2026: 12 days, not rated' })
    expect(na.dataset.kind).toBe('na')
    expect(na.style.backgroundImage).toContain('repeating-linear-gradient')
    expect(na.querySelector('[data-dot]')).toBeNull()
    expect(none.dataset.kind).toBe('missing')
    expect(none.querySelector('[data-dot]')).not.toBeNull()
    expect(none.style.backgroundImage).toBe('')
    expect(unrated.dataset.kind).toBe('unrated')
    expect([na, none, unrated].map((b) => b.textContent)).toEqual(['', '', ''])
  })

  it('mutes the name of a metric with no data in any shown column', () => {
    renderBoard()
    expect(screen.getByRole('rowheader', { name: 'Accessibility compliance' }).className).toContain('text-ink/70')
    expect(screen.getByRole('rowheader', { name: 'Epics delivered on time' }).className).not.toContain('text-ink/70')
  })

  it('has a legend with the tenant scale labels, no data and n/a', () => {
    renderBoard()
    const legend = screen.getByRole('list', { name: 'Status key' })
    const items = within(legend).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['●GOn track', '▲YWatch', '◆ROff track', 'No data', 'n/a', 'Not rated'])
  })

  it('emphasizes the selected period column', () => {
    renderBoard()
    const grid = screen.getByRole('grid')
    const oct = within(grid).getByRole('columnheader', { name: 'Oct' })
    expect(oct.hasAttribute('data-selected')).toBe(true)
    expect(within(grid).getByRole('columnheader', { name: 'Sep' }).hasAttribute('data-selected')).toBe(false)
    expect(oct.className).toContain('text-accent-deep')
  })

  it('bands the current column through every row once measured', () => {
    measuredAt(1150)
    renderBoard()
    const band = screen.getByTestId('current-band')
    expect(band.style.width).toBe('40px')
    expect(band.style.right).toBe(`${1150 - 320 - 12 * 40}px`)
    expect(band.className).toContain('bg-accent/10')
  })

  it('marks the fiscal year boundary', () => {
    renderBoard()
    const grid = screen.getByRole('grid')
    expect(within(grid).getByRole('columnheader', { name: 'Jan' }).hasAttribute('data-fy-start')).toBe(true)
    expect(within(grid).getByRole('columnheader', { name: 'Feb' }).hasAttribute('data-fy-start')).toBe(false)
    expect(within(grid).getByRole('columnheader', { name: 'FY2026' }).className).toContain('text-ink/70')
  })

  it('highlights the hovered column header without re-rendering the board', async () => {
    renderBoard()
    const user = userEvent.setup()
    await user.hover(screen.getByRole('button', { name: /^Epics delivered on time, Sep 2026/ }))
    const grid = screen.getByRole('grid')
    expect(within(grid).getByRole('columnheader', { name: 'Sep' }).hasAttribute('data-hover')).toBe(true)
    await user.hover(screen.getByRole('button', { name: /^Epics delivered on time, Aug 2026/ }))
    expect(within(grid).getByRole('columnheader', { name: 'Sep' }).hasAttribute('data-hover')).toBe(false)
    expect(within(grid).getByRole('columnheader', { name: 'Aug' }).hasAttribute('data-hover')).toBe(true)
  })

  it('shows the current value right-aligned with its change', () => {
    renderBoard()
    const row = screen.getByTestId('ribbon-epics')
    expect(within(row).getByText('79%').className).toContain('tabular-nums')
    expect(within(row).getByText(/-12 pts vs Sep/).textContent).toBe('▼ -12 pts vs Sep')
  })

  it('rolls each category up as quiet text naming only exceptions', () => {
    renderBoard()
    const delivery = screen.getByRole('rowheader', { name: /^Delivery/ })
    expect(delivery.getAttribute('scope')).toBe('rowgroup')
    expect(delivery.textContent).toBe('Delivery◆ 1 Off track')
    expect(screen.getByRole('rowheader', { name: /^Product/ }).textContent).toBe('Product▲ 1 Watch')
    expect(screen.getByRole('rowheader', { name: /^Design/ }).textContent).toBe('Design')
  })

  it('counts rows with no status for the selected period instead of calling the category all green', () => {
    const rows = rowsFor(MONTHS)
    const green = { ...rows[0]!, cells: MONTHS.map((c) => status(c, 'G', '90%')), current: '90%', change: null }
    const blank = boardRow('ev', 'Expected value', MONTHS.map((c) => empty(c, 'missing')))
    renderBoard({ rows: [green, blank, rows[1]!] })
    expect(screen.getByRole('rowheader', { name: /^Delivery/ }).textContent).toBe('DeliveryAll On track · 1 no data')
    cleanupAndRender([rows[0]!, blank, rows[1]!])
    expect(screen.getByRole('rowheader', { name: /^Delivery/ }).textContent).toBe('Delivery◆ 1 Off track · 1 no data')
  })

  it('says All On track for a category with nothing off', () => {
    const rows = rowsFor(MONTHS)
    rows[0] = { ...rows[0]!, cells: MONTHS.map((c) => status(c, 'G', '90%')), current: '90%', change: null }
    renderBoard({ rows })
    expect(screen.getByRole('rowheader', { name: /^Delivery/ }).textContent).toBe('DeliveryAll On track')
  })

  it('opens the metric on click and on Enter', async () => {
    const onOpen = renderBoard()
    const user = userEvent.setup()
    const cell = screen.getByRole('button', { name: SELECTED_EPICS })
    await user.click(cell)
    expect(onOpen).toHaveBeenCalledWith('epics', cell)
    onOpen.mockClear()
    cell.focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('epics', cell)
  })

  it('does not pop the tooltip when focus comes back after opening the metric', async () => {
    renderBoard()
    const user = userEvent.setup()
    const cell = screen.getByRole('button', { name: SELECTED_EPICS })
    cell.focus()
    await user.keyboard('{Enter}')
    act(() => {
      cell.blur()
      cell.focus()
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      cell.blur()
      cell.focus()
    })
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy())
  })

  it('is one tab stop; arrow keys move between cells', async () => {
    renderBoard()
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(SELECTED_EPICS)
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Epics delivered on time, Sep 2026/)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Customer feedback SLO, Sep 2026/)
    await user.keyboard('{Home}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Customer feedback SLO, Nov 2025/)
    await user.keyboard('{End}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Customer feedback SLO, Oct 2026/)
    const tabbable = screen.getAllByRole('button').filter((b) => b.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
  })

  it('labels quarter columns and their fiscal years', () => {
    renderBoard({ columns: buildTrendColumns('2026-Q4', 1), label: '8-quarter status' })
    const grid = screen.getByRole('grid', { name: '8-quarter status' })
    const labels = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
      .filter((t) => /^(Q\d|FY\d+)$/.test(t ?? ''))
    expect(labels).toEqual(['FY2025', 'FY2026', 'Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'])
    expect(screen.getByRole('button', { name: /Epics delivered on time, Q4 FY2026: Off track/ })).toBeTruthy()
  })

  it('on a phone stacks each metric: the name full width above, a hidden row header beside the cells', () => {
    const resize = measuredAt(1150)
    renderBoard()
    expect(screen.getAllByRole('button', { name: /^Epics delivered on time/ })).toHaveLength(12)
    resize(262)
    const cells = screen.getAllByRole('button', { name: /^Epics delivered on time/ })
    expect(cells).toHaveLength(6)
    expect(cells[0]!.getAttribute('aria-label')).toMatch(/May 2026/)
    expect(screen.getByText('Last 6 of 12 months')).toBeTruthy()
    // A zero-width column, not an absolutely positioned cell: browsers still give those a grid slot.
    const header = screen.getByRole('rowheader', { name: 'Epics delivered on time' })
    expect(header.className).toContain('w-0')
    expect(header.querySelector('.sr-only')?.textContent).toBe('Epics delivered on time')
    const grid = screen.getByRole('grid')
    expect(grid.querySelector('col')?.style.width).toBe('0px')
    expect(within(grid).getAllByRole('columnheader').some((h) => h.textContent === 'Metric')).toBe(false)
    const nameRow = screen.getByTestId('name-row-epics')
    expect(nameRow.getAttribute('aria-hidden')).toBe('true')
    const visibleName = within(nameRow).getByText('Epics delivered on time')
    expect(visibleName.className).not.toMatch(/truncate|line-clamp/)
    expect(within(nameRow).getByText('79%')).toBeTruthy()
    // The unrated cell (Jan) is outside the latest 6, so the legend drops its entry.
    const legend = within(screen.getByRole('list', { name: 'Status key' })).getAllByRole('listitem').map((li) => li.textContent)
    expect(legend).not.toContain('Not rated')
  })

  it('the stacked layout has no axe violations', async () => {
    measuredAt(262)
    renderBoard()
    expect(screen.getByTestId('name-row-epics')).toBeTruthy()
    expect((await axe(document.body)).violations).toEqual([])
  })
})

describe('StatusCellTip', () => {
  const sep = MONTHS[MONTHS.length - 2]!

  it('shows the value, period, status with its shape, streak and change', () => {
    render(<StatusCellTip column={sep} cell={{ ...status(sep, 'R', '72%'), change: '-10 pts vs Aug' }} streak={3} scale={SCALE} />)
    const tip = screen.getByTestId('board-tip')
    expect(tip.firstElementChild?.textContent).toBe('72%')
    expect(tip.textContent).toContain('Sep 2026')
    const line = within(tip).getByTestId('tip-status')
    expect(line.textContent).toBe('◆ Off track · 3 months')
    expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe('◆')
    expect(tip.textContent).toContain('-10 pts vs Aug')
  })

  it('says not applicable with its reason, and no data', () => {
    const { rerender } = render(
      <StatusCellTip column={sep} cell={empty(sep, 'na', { naReason: 'No ideas this month' })} streak={0} scale={SCALE} />,
    )
    expect(screen.getByTestId('board-tip').textContent).toBe('n/aSep 2026No ideas this month')
    rerender(<StatusCellTip column={sep} cell={empty(sep, 'missing')} streak={0} scale={SCALE} />)
    expect(screen.getByTestId('board-tip').textContent).toBe('No dataSep 2026')
    rerender(<StatusCellTip column={sep} cell={empty(sep, 'unrated', { display: '12 days' })} streak={0} scale={SCALE} />)
    expect(screen.getByTestId('board-tip').textContent).toBe('12 daysSep 2026Not rated')
  })

  it('leads with the caption when the status comes from children', () => {
    render(<StatusCellTip column={sep} cell={{ ...status(sep, 'R'), caption: 'worst of 3 services' }} streak={1} scale={SCALE} />)
    const tip = screen.getByTestId('board-tip')
    expect(tip.firstElementChild?.textContent).toBe('Worst of 3 services')
    expect(within(tip).getByTestId('tip-status').textContent).toBe('◆ Off track')
  })
})
