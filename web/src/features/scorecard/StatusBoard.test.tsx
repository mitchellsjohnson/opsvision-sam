import * as Tooltip from '@radix-ui/react-tooltip'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { DEPLOYMENT_NOUN, DEPLOYMENT_SCALE, deploymentRows } from '../../test/deploymentFixtures'
import { buildTrendColumns, type Column } from './columns'
import { StatusBoard, StatusCellTip } from './StatusBoard'
import { buildBoardRow, type BoardCell, type BoardRow } from './logic/statusBoard'

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

  it('scrolls into view below the sticky control bar', () => {
    renderBoard()
    const board = screen.getByRole('grid', { name: '12-month status' }).closest('section')!
    expect(board.className).toContain('scroll-mt-[var(--control-bar-h,0px)]')
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

  it('adds Not due to the legend when a shown cell is a coarse metric’s month that reports later', () => {
    const quarterly = MONTHS.map((c, i) => (i % 3 === 2 ? status(c, 'G', '90%') : empty(c, 'notDue', { caption: 'Q3 FY2026 reports after Sep' })))
    renderBoard({ rows: [...rowsFor(MONTHS), boardRow('concepts', 'Concepts delivered expected value', quarterly)] })
    const items = within(screen.getByRole('list', { name: 'Status key' })).getAllByRole('listitem').map((li) => li.textContent)
    expect(items.at(-1)).toBe('Not due')
    cleanup()
    renderBoard()
    expect(within(screen.getByRole('list', { name: 'Status key' })).queryByText('Not due')).toBeNull()
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

  it('with no company value, Current shows the worst item’s value with its name and the scope', () => {
    const uptime = boardRow(
      'uptime',
      'Uptime',
      MONTHS.map((c) => ({ ...status(c, 'R'), caption: 'worst of 21 services · 3 not reported' })),
      { worst: { name: 'Webhooks', display: '99.06%' }, caption: 'worst of 21 services · 3 not reported' },
    )
    renderBoard({ rows: [uptime] })
    const row = screen.getByTestId('ribbon-uptime')
    expect(within(row).getByText('99.06%').className).toContain('tabular-nums')
    expect(within(row).getByText('Webhooks')).toBeTruthy()
    expect(within(row).getByText('worst of 21 services · 3 not reported')).toBeTruthy()
  })

  it('on a phone, the stacked row gives the worst item its own line under the metric name', () => {
    measuredAt(262)
    const uptime = boardRow(
      'uptime',
      'Uptime',
      MONTHS.map((c) => ({ ...status(c, 'R'), caption: 'worst of 21 services' })),
      { worst: { name: 'Webhooks', display: '99.06%' }, caption: 'worst of 21 services' },
    )
    renderBoard({ rows: [uptime] })
    const nameRow = screen.getByTestId('name-row-uptime')
    expect(within(nameRow).getByTestId('stacked-value').textContent).toBe('99.06%')
    const worst = within(nameRow).getByTestId('stacked-worst')
    expect(worst.textContent).toBe('Webhooks · worst of 21 services')
    expect(worst.querySelector('[data-name]')!.textContent).toBe('Webhooks')
  })

  it('at 360 the worst deployment keeps its ending and the count on its own line', () => {
    measuredAt(310)
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={MONTHS} rows={[deploymentsRow()]} scale={DEPLOYMENT_SCALE} onOpen={vi.fn()} />
      </Tooltip.Provider>,
    )
    const nameRow = screen.getByTestId('name-row-deployment_uptime')
    expect(within(nameRow).getByTestId('stacked-value').textContent).toBe('99.63%')
    const worst = within(nameRow).getByTestId('stacked-worst')
    const name = worst.querySelector<HTMLElement>('[data-name]')!
    expect(name.textContent).toBe('Notification Relay - Multi-Region Active')
    expect(name.lastElementChild!.textContent).toBe(' - Multi-Region Active')
    const count = name.nextElementSibling as HTMLElement
    expect(count.textContent).toBe(' · 1 of 21 Red')
    expect(count.className).toContain('shrink-0')
  })

  it('a metric that stopped reporting reads Last Jul 77% in Current, not No data', () => {
    const stopped = boardRow(
      'nps',
      'Net promoter score',
      MONTHS.map((c, i) => (i <= 8 ? status(c, 'R', '77%') : empty(c, 'missing'))),
    )
    renderBoard({ rows: [stopped] })
    const current = screen.getByTestId('ribbon-nps').querySelector('td:last-child')!
    expect(current.textContent).toBe('Last Jul 77%')
    cleanup()
    measuredAt(262)
    renderBoard({ rows: [stopped] })
    expect(within(screen.getByTestId('name-row-nps')).getByTestId('stacked-value').textContent).toBe('Last Jul 77%')
  })

  it('shortens a fiscal year header too narrow for its full name, keeping the full name for screen readers', () => {
    measuredAt(1150)
    // 2025-Q4 … 2027-Q3: FY2025 has one quarter.
    renderBoard({ columns: buildTrendColumns('2027-Q3', 1), label: '8-quarter status' })
    const grid = screen.getByRole('grid', { name: '8-quarter status' })
    const header = within(grid).getByRole('columnheader', { name: 'FY2025' })
    expect(header.getAttribute('colspan')).toBe('1')
    expect(header.querySelector('[aria-hidden="true"]')!.textContent).toBe('FY25')
    expect(header.getAttribute('title')).toBe('FY2025')
    expect(within(grid).getByRole('columnheader', { name: 'FY2026' }).textContent).toBe('FY2026')
  })

  it('keeps the year and month headers in view under the control bar while the board scrolls', () => {
    renderBoard()
    const thead = screen.getByRole('grid').querySelector('thead')!
    expect(thead.className).toContain('sticky')
    expect(thead.className).toContain('bg-white')
    // Under the top bar too, wherever it stays in view (the shell publishes its height; 0px while it scrolls away).
    expect(thead.style.top).toBe('calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))')
  })

  function deploymentsRow() {
    const items = deploymentRows(MONTHS)
    return buildBoardRow({
      key: 'deployment_uptime',
      category: { id: 'eng', name: 'Engineering' },
      scope: null,
      head: items[0]!,
      children: items,
      noun: DEPLOYMENT_NOUN,
      columns: MONTHS,
      scale: DEPLOYMENT_SCALE,
      fyStart: 1,
    })
  }

  it('an item row’s Current caption names the worst item, keeping its ending, then how many share its status', () => {
    // A wide board: the Current column is 1400 - 320 - 12 × 40 = 600px, room for the caption on one line.
    measuredAt(1400)
    const columns = MONTHS
    const deployments = deploymentsRow()
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={columns} rows={[deployments]} scale={DEPLOYMENT_SCALE} onOpen={vi.fn()} />
      </Tooltip.Provider>,
    )
    const row = screen.getByTestId('ribbon-deployment_uptime')
    expect(within(row).getByText('99.63%').className).toContain('tabular-nums')
    const name = row.querySelector<HTMLElement>('[data-name]')!
    expect(name.textContent).toBe('Notification Relay - Multi-Region Active')
    const count = name.nextElementSibling as HTMLElement
    expect(count.textContent).toBe(' · 1 of 21 Red')
    expect(count.className).toContain('shrink-0')
    expect(screen.queryByText(/12 not reported/)).toBeNull()
    expect(screen.getByRole('row', { name: /; 12 not reported$/ })).toBe(row)
    expect(row.getAttribute('aria-label')).toBe(
      'Deployment uptime, Oct 2026: 99.63%, Red; worst Notification Relay - Multi-Region Active; 1 of 21 Red; 12 not reported',
    )
  })

  it('in a 136px Current column, the worst item’s name takes its own line under the value and the count the next', () => {
    // 936 - 320 - 12 × 40 = 136: the Current column at 1024px.
    measuredAt(936)
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={MONTHS} rows={[deploymentsRow()]} scale={DEPLOYMENT_SCALE} onOpen={vi.fn()} />
      </Tooltip.Provider>,
    )
    expect(screen.getByTestId('current-band').style.right).toBe('136px')
    const row = screen.getByTestId('ribbon-deployment_uptime')
    const current = row.querySelector('td:last-child')!
    const lines = [...current.children] as HTMLElement[]
    expect(lines.map((l) => l.textContent)).toEqual(['99.63%', 'Notification Relay - Multi-Region Active', '1 of 21 Red'])
    // The name alone on its line, still through ItemName, so a cut keeps the ending the deployments differ in.
    const name = lines[1]!.querySelector<HTMLElement>('[data-name]')!
    expect(name.textContent).toBe('Notification Relay - Multi-Region Active')
    expect(name.lastElementChild!.textContent).toBe(' - Multi-Region Active')
    expect(name.lastElementChild!.className).toContain('shrink-0')
    expect(lines[2]!.className).toContain('text-[11px]')
    // Every part is still in the row's accessible name.
    expect(row.getAttribute('aria-label')).toBe(
      'Deployment uptime, Oct 2026: 99.63%, Red; worst Notification Relay - Multi-Region Active; 1 of 21 Red; 12 not reported',
    )
  })

  it('in a 136px Current column, a short worst name keeps the count beside it', () => {
    measuredAt(936)
    const uptime = boardRow('uptime', 'Uptime', MONTHS.map((c) => status(c, 'R')), {
      current: '',
      worst: { name: 'Ledger', display: '99.06%', of: { same: 1, total: 24, notReported: 0 } },
    })
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={MONTHS} rows={[uptime]} scale={DEPLOYMENT_SCALE} onOpen={vi.fn()} />
      </Tooltip.Provider>,
    )
    const current = screen.getByTestId('ribbon-uptime').querySelector('td:last-child')!
    expect([...current.children].map((l) => l.textContent)).toEqual(['99.06%', 'Ledger · 1 of 24 Red'])
  })

  it('a one-column fiscal year reads in its short form, however wide the column', () => {
    measuredAt(1150)
    // H2 FY2025 … H1 FY2027: FY2025 and FY2027 have one half each, in 64px columns.
    renderBoard({ columns: buildTrendColumns('2027-H1', 1), label: '4-half status' })
    const grid = screen.getByRole('grid', { name: '4-half status' })
    const header = within(grid).getByRole('columnheader', { name: 'FY2025' })
    expect(header.querySelector('[aria-hidden="true"]')!.textContent).toBe('FY25')
    expect(within(grid).getByRole('columnheader', { name: 'FY2026' }).textContent).toBe('FY2026')
  })

  it('each category label links to its section and moves focus to the section’s heading', async () => {
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={MONTHS} rows={rowsFor(MONTHS)} scale={SCALE} onOpen={vi.fn()} />
        <h2 id="section-product" tabIndex={-1}>
          Product
        </h2>
      </Tooltip.Provider>,
    )
    const link = screen.getByRole('link', { name: 'Product' })
    expect(link.getAttribute('href')).toBe('#section-product')
    expect(link.className).toContain('hover:underline')
    await userEvent.setup().click(link)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Product' }))
  })

  it('with its section header hidden, a category label goes to the category’s first tile on the page', async () => {
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    const rows = [...rowsFor(MONTHS), boardRow('feedback-2', 'Feature adoption', MONTHS.map((c) => status(c, 'G')), { category: { id: 'product', name: 'Product' } })]
    render(
      <Tooltip.Provider>
        <StatusBoard label="12-month status" columns={MONTHS} rows={rows} scale={SCALE} onOpen={vi.fn()} />
        {/* Tiles in layout order, not board order: Feature adoption was moved first. */}
        <div data-layout-item="metric:feedback-2">
          <article aria-label="Feature adoption">
            <button type="button">Expand Feature adoption</button>
          </article>
        </div>
        <div data-layout-item="metric:feedback">
          <article aria-label="Customer feedback SLO">
            <button type="button">Expand Customer feedback SLO</button>
          </article>
        </div>
      </Tooltip.Provider>,
    )
    const link = screen.getByRole('link', { name: 'Product' })
    await userEvent.setup().click(link)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand Feature adoption' }))
    expect(scrolled.at(-1)).toBe(screen.getByRole('article', { name: 'Feature adoption' }))
  })

  it('a category with neither its section nor a tile on the page reads as plain text', () => {
    renderBoard()
    const delivery = screen.getByRole('rowheader', { name: /^Delivery/ })
    expect(within(delivery).queryByRole('link')).toBeNull()
    expect(within(delivery).getByText('Delivery').className).toContain('uppercase')
  })

  it('a category the filter leaves empty keeps its label and reads none match', () => {
    const rows = rowsFor(MONTHS).filter((r) => r.category.id !== 'design')
    render(
      <Tooltip.Provider>
        <StatusBoard
          label="12-month status"
          columns={MONTHS}
          rows={rows}
          scale={SCALE}
          onOpen={vi.fn()}
          categories={[
            { id: 'delivery', name: 'Delivery' },
            { id: 'product', name: 'Product' },
            { id: 'design', name: 'Design' },
          ]}
        />
      </Tooltip.Provider>,
    )
    const design = screen.getByRole('rowheader', { name: /^Design/ })
    expect(design.textContent).toBe('Design · none match')
    expect(within(design).getByText('· none match').className).toContain('text-xs')
    expect(within(design).queryByRole('link')).toBeNull()
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
    // No section is on the page, so the category labels are text and the grid is the first stop.
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
    // Long names wrap to two lines and the value truncates, so nothing clips at 320px.
    expect(visibleName.className).toContain('min-w-0')
    expect(visibleName.className).toContain('line-clamp-2')
    expect(visibleName.getAttribute('title')).toBe('Epics delivered on time')
    const value = within(nameRow).getByText('79%').closest<HTMLElement>('[data-testid="stacked-value"]')!
    expect(value.className).toContain('shrink-0')
    expect(value.className).toContain('max-w-[45%]')
    expect(value.className).toContain('truncate')
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

const WRITTEN = { state: 'written' as const, excerpt: 'Seven of 33 epics slipped, four of them in Checkout and Bill…', author: 'Avery Admin' }

/** The default rows with exec summary states: Epics written (Oct and Jul), Customer feedback missing; Accessibility has no data. */
function summaryRows(): BoardRow[] {
  const [epics, feedback, audit] = rowsFor(MONTHS)
  const withSummary = (row: BoardRow, at: Record<number, BoardCell['summary']>, summary: BoardRow['summary']): BoardRow => ({
    ...row,
    cells: row.cells.map((c, i) => (at[i] ? { ...c, summary: at[i] } : c)),
    summary,
  })
  return [withSummary(epics!, { 8: WRITTEN, 11: WRITTEN }, WRITTEN), withSummary(feedback!, { 11: { state: 'missing' } }, { state: 'missing' }), audit!]
}

function renderWhyBoard({ isAdmin = true, rows = summaryRows() } = {}) {
  const onOpen = vi.fn()
  const onWhy = vi.fn()
  render(
    <Tooltip.Provider>
      <StatusBoard label="12-month status" columns={MONTHS} rows={rows} scale={SCALE} onOpen={onOpen} onWhy={onWhy} isAdmin={isAdmin} />
    </Tooltip.Provider>,
  )
  return { onOpen, onWhy }
}

const EPICS_CURRENT = 'Epics delivered on time, Oct 2026: 79%, Off track; exec summary written.'

describe('StatusBoard with Why', () => {
  it('inline: → from Oct reaches Current, ← returns; Enter on Current opens the company card for the counted period', async () => {
    measuredAt(1150)
    const { onOpen, onWhy } = renderWhyBoard()
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`${SELECTED_EPICS}; exec summary written`)
    await user.keyboard('{ArrowRight}')
    const current = screen.getByRole('button', { name: EPICS_CURRENT })
    expect(document.activeElement).toBe(current)
    expect(current.getAttribute('aria-description')).toBe(`${WRITTEN.excerpt} Press Enter for why`)
    await user.keyboard('{Enter}')
    expect(onWhy).toHaveBeenCalledWith('epics', '2026-M10', current)
    expect(onOpen).not.toHaveBeenCalled()
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`${SELECTED_EPICS}; exec summary written`)
    await user.keyboard('{End}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`${SELECTED_EPICS}; exec summary written`)
    expect(screen.getAllByRole('button').filter((b) => b.tabIndex === 0)).toHaveLength(1)
  })

  it('a click on Current opens the card; month cells keep opening the dialog and W opens their card', async () => {
    measuredAt(1150)
    const { onOpen, onWhy } = renderWhyBoard()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: EPICS_CURRENT }))
    expect(onWhy).toHaveBeenLastCalledWith('epics', '2026-M10', screen.getByRole('button', { name: EPICS_CURRENT }))
    const sep = screen.getByRole('button', { name: /^Epics delivered on time, Sep 2026/ })
    await user.click(sep)
    expect(onOpen).toHaveBeenCalledWith('epics', sep)
    sep.focus()
    await user.keyboard('w')
    expect(onWhy).toHaveBeenLastCalledWith('epics', '2026-M09', sep)
  })

  it('Current shows the written mark, or the missing tag for the admin and for others', () => {
    measuredAt(1150)
    renderWhyBoard()
    const epics = screen.getByRole('button', { name: EPICS_CURRENT })
    expect(epics.querySelector('[data-summary-mark]')).toBeTruthy()
    expect(epics.textContent).toContain('79%')
    const feedback = screen.getByRole('button', { name: 'Customer feedback SLO, Oct 2026: 15 days, Watch; exec summary needed.' })
    expect(feedback.textContent).toContain('Exec summary needed')
    expect(within(feedback).getByText('Exec summary needed').className).toContain('text-status-r')
    cleanup()
    measuredAt(1150)
    renderWhyBoard({ isAdmin: false })
    const viewer = screen.getByRole('button', { name: 'Customer feedback SLO, Oct 2026: 15 days, Watch; exec summary needed.' })
    expect(viewer.textContent).toContain('No exec summary yet')
    expect(viewer.textContent).not.toContain('Exec summary needed')
  })

  it('month cells with a written summary carry the mark and say so in their name and hover label', async () => {
    measuredAt(1150)
    renderWhyBoard()
    const jul = screen.getByRole('button', { name: 'Epics delivered on time, Jul 2026: On track, 90%; exec summary written' })
    const mark = jul.querySelector('[data-summary-mark]')!
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.className).toContain('size-1.5')
    expect(mark.className).toContain('ring-ink/70')
    expect(screen.getByRole('button', { name: /^Epics delivered on time, Jun 2026: On track, 90%$/ }).querySelector('[data-summary-mark]')).toBeNull()
    act(() => jul.focus())
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain(`Summary: ${WRITTEN.excerpt}`))
  })

  it('a row with no value in the selected period has no Current cell to reach: → stays on Oct', async () => {
    measuredAt(1150)
    renderWhyBoard()
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Accessibility compliance, Oct 2026: No data')
  })

  it('stacked (360px): each ribbon row ends in a 32px trailing cell, reachable by → and by tap', async () => {
    measuredAt(310)
    const { onWhy } = renderWhyBoard()
    const user = userEvent.setup()
    const trailing = screen.getByRole('button', { name: EPICS_CURRENT })
    expect(trailing.closest('tr')).toBe(screen.getByTestId('ribbon-epics'))
    expect(trailing.textContent).toBe('Why')
    expect(trailing.closest('td')!.className).toContain('w-8')
    expect(trailing.querySelector('[data-summary-mark]')).toBeTruthy()
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(trailing)
    await user.click(screen.getByRole('button', { name: 'Customer feedback SLO, Oct 2026: 15 days, Watch; exec summary needed.' }))
    expect(onWhy).toHaveBeenLastCalledWith('feedback', '2026-M10', expect.any(HTMLElement))
    const grid = screen.getByRole('grid')
    const cols = [...grid.querySelectorAll('col')]
    expect(cols.at(-1)!.style.width).toBe('32px')
    expect((await axe(document.body)).violations).toEqual([])
  })

  it('has no axe violations inline', async () => {
    measuredAt(1150)
    renderWhyBoard()
    expect((await axe(document.body)).violations).toEqual([])
  })

  it('without onWhy, Current is plain text and → stops at Oct', async () => {
    measuredAt(1150)
    renderBoard({ rows: summaryRows() })
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`${SELECTED_EPICS}; exec summary written`)
    expect(screen.queryByRole('button', { name: EPICS_CURRENT })).toBeNull()
  })
})

describe('StatusCellTip', () => {
  const sep = MONTHS[MONTHS.length - 2]!

  it('adds the exec summary line on a company-root cell', () => {
    const { rerender } = render(
      <StatusCellTip column={sep} cell={status(sep, 'R', '72%')} streak={1} scale={SCALE} summary={WRITTEN} />,
    )
    expect(screen.getByTestId('tip-summary').textContent).toBe(`Summary: ${WRITTEN.excerpt}`)
    rerender(<StatusCellTip column={sep} cell={status(sep, 'R', '72%')} streak={1} scale={SCALE} summary={{ state: 'missing' }} />)
    expect(screen.getByTestId('tip-summary').textContent).toBe('Exec summary needed')
    rerender(<StatusCellTip column={sep} cell={status(sep, 'R', '72%')} streak={1} scale={SCALE} summary={{ state: 'optional' }} />)
    expect(screen.queryByTestId('tip-summary')).toBeNull()
  })

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
