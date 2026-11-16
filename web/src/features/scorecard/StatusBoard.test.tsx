import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function boardRow(key: string, name: string, cells: BoardCell[], over: Partial<BoardRow> = {}): BoardRow {
  const last = cells[cells.length - 1]
  return {
    key,
    name,
    category: { id: 'delivery', name: 'Delivery' },
    cells,
    current: last?.display ?? '',
    caption: '',
    change: null,
    ...over,
  }
}

function rowsFor(columns: Column[]): BoardRow[] {
  const epics = columns.map((c, i) => status(c, i === columns.length - 1 ? 'R' : 'G', i === columns.length - 1 ? '79%' : '90%'))
  const feedback = columns.map((c, i): BoardCell =>
    i === 0
      ? { key: c.key, kind: 'na', status: '', display: '', naReason: 'No ideas this month', change: null, caption: '' }
      : i === 1
        ? { key: c.key, kind: 'missing', status: '', display: '', naReason: '', change: null, caption: '' }
        : status(c, 'Y', '15 days'),
  )
  return [
    boardRow('epics', 'Epics delivered on time', epics, {
      change: { text: '-12 pts vs Sep', move: { arrow: '▼', tone: 'bad' } },
    }),
    boardRow('feedback', 'Customer feedback SLO', feedback, { category: { id: 'product', name: 'Product' } }),
  ]
}

function renderBoard(columns = MONTHS, label = '12-month status', onOpen = vi.fn()) {
  render(
    <Tooltip.Provider>
      <StatusBoard label={label} columns={columns} rows={rowsFor(columns)} scale={SCALE} onOpen={onOpen} />
    </Tooltip.Provider>,
  )
  return onOpen
}

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

  it('names every cell with metric, period, status and value; the letter and shape are shown', () => {
    renderBoard()
    const cell = screen.getByRole('button', { name: 'Epics delivered on time, Oct 2026: Off track, 79%' })
    expect(cell.textContent).toBe('◆R')
    expect(screen.getByRole('button', { name: 'Epics delivered on time, Sep 2026: On track, 90%' }).textContent).toBe('●G')
  })

  it('draws not applicable and no data differently from each other and from statuses', () => {
    renderBoard()
    const na = screen.getByRole('button', { name: 'Customer feedback SLO, Nov 2025: Not applicable, No ideas this month' })
    const none = screen.getByRole('button', { name: 'Customer feedback SLO, Dec 2025: No data' })
    expect(na.getAttribute('data-kind')).toBe('na')
    expect(none.getAttribute('data-kind')).toBe('missing')
    expect(na.className).not.toBe(none.className)
    expect(na.textContent).toBe('')
    expect(none.textContent).toBe('')
  })

  it('has a legend with the tenant scale labels, no data and n/a', () => {
    renderBoard()
    const legend = screen.getByRole('list', { name: 'Status key' })
    const items = within(legend).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['●GOn track', '▲YWatch', '◆ROff track', 'No data', 'n/a'])
  })

  it('emphasizes the selected period column', () => {
    renderBoard()
    const grid = screen.getByRole('grid')
    const oct = within(grid).getByRole('columnheader', { name: 'Oct' })
    const sep = within(grid).getByRole('columnheader', { name: 'Sep' })
    expect(oct.hasAttribute('data-selected')).toBe(true)
    expect(sep.hasAttribute('data-selected')).toBe(false)
    expect(oct.className).toContain('text-accent-deep')
  })

  it('marks the fiscal year boundary', () => {
    renderBoard()
    const grid = screen.getByRole('grid')
    expect(within(grid).getByRole('columnheader', { name: 'Jan' }).hasAttribute('data-fy-start')).toBe(true)
    expect(within(grid).getByRole('columnheader', { name: 'Feb' }).hasAttribute('data-fy-start')).toBe(false)
  })

  it('shows the current value right-aligned with its change, and groups rows by category with a roll-up', () => {
    renderBoard()
    const row = screen.getByTestId('ribbon-epics')
    expect(within(row).getByText('79%').className).toContain('tabular-nums')
    expect(within(row).getByText(/-12 pts vs Sep/).textContent).toBe('▼ -12 pts vs Sep')
    const delivery = screen.getByRole('rowheader', { name: /^Delivery/ })
    expect(delivery.getAttribute('scope')).toBe('rowgroup')
    expect(delivery.textContent).toContain('1 Off track')
  })

  it('opens the metric on click and on Enter', async () => {
    const onOpen = renderBoard()
    const user = userEvent.setup()
    const cell = screen.getByRole('button', { name: /Epics delivered on time, Oct 2026/ })
    await user.click(cell)
    expect(onOpen).toHaveBeenCalledWith('epics', cell)
    onOpen.mockClear()
    cell.focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('epics', cell)
  })

  it('is one tab stop; arrow keys move between cells', async () => {
    renderBoard()
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Epics delivered on time, Oct 2026: Off track, 79%')
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
    renderBoard(buildTrendColumns('2026-Q4', 1), '8-quarter status')
    const grid = screen.getByRole('grid', { name: '8-quarter status' })
    const labels = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
      .filter((t) => /^(Q\d|FY\d+)$/.test(t ?? ''))
    expect(labels).toEqual(['FY2025', 'FY2026', 'Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'])
    expect(screen.getByRole('button', { name: /Epics delivered on time, Q4 FY2026: Off track/ })).toBeTruthy()
  })

  it('on a narrow board shows the latest columns and says so', () => {
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
    let width = 1150
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 0 }) as DOMRect)
    renderBoard()
    expect(screen.getAllByRole('button', { name: /^Epics delivered on time/ })).toHaveLength(12)
    width = 262
    act(() => callbacks.forEach((cb) => cb()))
    const cells = screen.getAllByRole('button', { name: /^Epics delivered on time/ })
    expect(cells).toHaveLength(6)
    expect(cells[0]!.getAttribute('aria-label')).toMatch(/May 2026/)
    expect(screen.getByText('Last 6 of 12 months')).toBeTruthy()
  })
})

describe('StatusCellTip', () => {
  const sep = MONTHS[MONTHS.length - 2]!

  it('shows the value, period, status, streak and change', () => {
    render(
      <StatusCellTip
        column={sep}
        cell={{ ...status(sep, 'R', '72%'), change: '-10 pts vs Sep' }}
        streak={3}
        scale={SCALE}
      />,
    )
    const tip = screen.getByTestId('board-tip')
    expect(tip.textContent).toContain('72%')
    expect(tip.textContent).toContain('Sep 2026')
    expect(within(tip).getByTestId('tip-status').textContent).toBe('◆ R Off track · 3 months')
    expect(tip.textContent).toContain('-10 pts vs Sep')
  })

  it('says not applicable with its reason, and no data', () => {
    const { rerender } = render(
      <StatusCellTip column={sep} cell={{ ...status(sep, ''), kind: 'na', naReason: 'No ideas this month' }} streak={0} scale={SCALE} />,
    )
    expect(screen.getByTestId('board-tip').textContent).toBe('n/aSep 2026No ideas this month')
    rerender(<StatusCellTip column={sep} cell={{ ...status(sep, ''), kind: 'missing' }} streak={0} scale={SCALE} />)
    expect(screen.getByTestId('board-tip').textContent).toBe('No dataSep 2026')
  })

  it('leads with the caption when the status comes from children', () => {
    render(<StatusCellTip column={sep} cell={{ ...status(sep, 'R'), caption: 'worst of 3 services' }} streak={1} scale={SCALE} />)
    const tip = screen.getByTestId('board-tip')
    expect(tip.firstElementChild?.textContent).toBe('Worst of 3 services')
    expect(within(tip).getByTestId('tip-status').textContent).toBe('◆ R Off track')
  })
})
