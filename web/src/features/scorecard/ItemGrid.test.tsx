import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { buildTrendColumns } from './columns'
import { ItemGrid } from './ItemGrid'
import { buildItemRows, type ItemSort } from './logic/itemGrid'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']
type StatusLevel = components['schemas']['StatusLevel']

/** The container width; with `late`, it arrives after the first commit, as a real measurement does. */
const width = vi.hoisted(() => ({ value: 1296, late: false }))
vi.mock('../../ui/useElementWidth', async () => {
  const { useLayoutEffect, useState } = await import('react')
  return {
    useElementWidth: () => {
      const [measured, setMeasured] = useState(!width.late)
      useLayoutEffect(() => setMeasured(true), [])
      return [() => {}, measured ? width.value : 0]
    },
  }
})

const columns = buildTrendColumns('2026-M10', 1)

/** A tenant scale with four levels; the best is still called Green. */
const FOUR: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'O', label: 'Orange', color: '#9A3412', rank: 3 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 4 },
]
const STATUS_OF = (v: number) => (v >= 99.9 ? 'G' : v > 99.8 ? 'Y' : 'R')

function cellOf(id: string, period: string, v: number | null): Cell {
  return {
    metricKey: 'uptime',
    subjectId: id,
    period,
    ytd: false,
    value: v,
    display: v === null ? '' : `${v.toFixed(2)}%`,
    status: v === null ? '' : STATUS_OF(v),
    naReason: '',
    components: {},
    coverage: v === null ? [0, 1] : [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
  }
}

function service(id: string, name: string, oct: number | null, before: number | null = 99.99): ViewRow {
  return {
    metricKey: 'uptime',
    metricName: 'Uptime',
    categoryId: 'eng',
    subjectId: id,
    subjectName: name,
    subjectKind: 'item',
    format: 'percent2',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'uptime',
    definition: '',
    cells: columns.map((c, i) => cellOf(id, c.period, i === columns.length - 1 ? oct : before)),
  }
}

const GREEN = [
  'Ledger', 'Scheduler', 'Status Page', 'Data Export', 'Billing Worker', 'Email Relay', 'Feature Flags', 'Inventory API',
  'Notifications', 'Audit Log', 'Admin Console', 'Auth Service', 'Checkout API', 'Media CDN', 'Payments Gateway', 'Mobile Backend',
  'Webhooks',
]

/** 24 services: 18 Green, 2 Yellow, 1 Red, 3 not reported this month. */
const SERVICES: ViewRow[] = [
  service('svc-web', 'Web App', 99.06),
  service('svc-ingest', 'Analytics Ingest Worker', 99.83),
  service('svc-search', 'Search', 99.87),
  ...GREEN.map((name) => service(`svc-${name.toLowerCase().replace(/\W+/g, '-')}`, name, 99.99)),
  service('svc-public', 'Public API', 100),
  service('svc-push', 'Push Gateway', null),
  service('svc-pricing', 'Pricing Engine', null),
  service('svc-report', 'Reporting', null, null),
]
const groupOf = (id: string) => (id === 'svc-web' || id === 'svc-ledger' ? 'Payments' : 'Platform')
const ROWS = buildItemRows(SERVICES, columns, FOUR, groupOf, 1)

const serviceNames = (grid: HTMLElement) => [...grid.querySelectorAll('tbody th[scope=row] [data-name]')].map((n) => n.textContent)
const monthHeaders = (grid: HTMLElement) => [...grid.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent)

function Harness({ onOpenItem = () => {}, onSort = () => {} }: { onOpenItem?: (id: string) => void; onSort?: (s: ItemSort) => void }) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<ItemSort>('worst')
  return (
    <Tooltip.Provider>
      <ItemGrid
        head={SERVICES[0]!}
        rows={ROWS}
        columns={columns}
        scale={FOUR}
        direction="higher_better"
        noun={{ one: 'service', many: 'services' }}
        sort={sort}
        onSort={(s) => {
          setSort(s)
          onSort(s)
        }}
        filter={filter}
        onFilter={setFilter}
        onOpenItem={onOpenItem}
      />
    </Tooltip.Provider>
  )
}

describe('ItemGrid', () => {
  it('leads with the services at the best status, out of all of them, and the worst now', () => {
    width.value = 1296
    render(<Harness />)
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('18 of 24 services Green')).toBeTruthy()
    expect(within(summary).getByTestId('summary-counts').textContent).toBe('◆ 1 Red · ▲ 2 Yellow · 3 not reported · Oct 2026')
    const worst = within(summary).getByTestId('worst-now')
    expect(worst.textContent).toContain('Worst now')
    expect(within(worst).getByText('Web App')).toBeTruthy()
    expect(within(worst).getByText('99.06%')).toBeTruthy()
    expect(within(worst).getByRole('img', { name: 'Red' })).toBeTruthy()
    expect(within(worst).getByText('Red since Oct 2026 · 1 month · 1 Red month in the last 12 · Payments')).toBeTruthy()
  })

  it('a grid of services by month: not reported last, under their own header', () => {
    width.value = 1296
    render(<Harness />)
    const grid = screen.getByRole('grid', { name: 'Uptime by service and month' })
    const names = serviceNames(grid)
    expect(names).toHaveLength(24)
    expect(names.slice(0, 3)).toEqual(['Web App', 'Analytics Ingest Worker', 'Search'])
    expect(names.slice(-4)).toEqual(['Public API', 'Pricing Engine', 'Push Gateway', 'Reporting'])
    expect(grid.querySelector('th[scope=rowgroup]')!.textContent).toBe('Not reported this month · 3')
    expect(within(grid).getByRole('columnheader', { name: 'Red months' })).toBeTruthy()
    // One tab stop: the worst service's selected month.
    const stops = within(grid).getAllByRole('button').filter((b) => b.tabIndex === 0)
    expect(stops.map((b) => b.getAttribute('aria-label'))).toEqual(['Web App, Oct 2026: Red, 99.06%'])
    expect(screen.getByText('Nov 2025 – Oct 2026 · 12 months')).toBeTruthy()
    expect(within(grid).getAllByText('Not reported')).toHaveLength(3)
    expect(within(grid).getAllByText('Last Sep · 99.99%')).toHaveLength(2)
    expect(within(grid).getByText('No reports in 12 months')).toBeTruthy()
  })

  it('arrow down from the last reported row lands on the first not reported row', async () => {
    width.value = 1296
    render(<Harness />)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Public API, Oct 2026: Green, 100.00%' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Pricing Engine, Oct 2026: No data')
  })

  it('Enter opens the service', async () => {
    width.value = 1296
    const onOpenItem = vi.fn()
    render(<Harness onOpenItem={onOpenItem} />)
    screen.getByRole('button', { name: 'Web App, Oct 2026: Red, 99.06%' }).focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onOpenItem).toHaveBeenCalledWith('svc-web')
  })

  it('sort is a segmented control', async () => {
    width.value = 1296
    const onSort = vi.fn()
    render(<Harness onSort={onSort} />)
    const sort = screen.getByRole('radiogroup', { name: 'Sort services' })
    expect(within(sort).getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['Worst now', 'true'],
      ['Most Red months', 'false'],
      ['Name', 'false'],
    ])
    const user = userEvent.setup()
    within(sort).getByRole('radio', { name: 'Worst now' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(onSort).toHaveBeenLastCalledWith('reds')
    await user.click(within(sort).getByRole('radio', { name: 'Name' }))
    expect(onSort).toHaveBeenLastCalledWith('name')
    expect(serviceNames(screen.getByRole('grid')).slice(0, 3)).toEqual(['Admin Console', 'Analytics Ingest Worker', 'Audit Log'])
  })

  it('filters by service or group, and announces the count 300 ms after typing stops', async () => {
    width.value = 1296
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<Harness />)
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const input = screen.getByRole('searchbox', { name: 'Filter services' })
      expect(input.getAttribute('placeholder')).toBe('Filter 24 services')
      const live = screen.getByTestId('item-grid-live')
      await user.type(input, 'ledger')
      expect(live.textContent).toBe('')
      await act(async () => vi.advanceTimersByTime(300))
      expect(live.textContent).toBe('Showing 1 of 24 services')
      expect(serviceNames(screen.getByRole('grid'))).toEqual(['Ledger'])
      await user.clear(input)
      await user.type(input, 'payments')
      await act(async () => vi.advanceTimersByTime(300))
      // Group names match too: Web App and Ledger are in Payments, and Payments Gateway by name.
      expect(live.textContent).toBe('Showing 3 of 24 services')
      await user.clear(input)
      await user.type(input, 'xyz')
      expect(screen.getByText('No services match “xyz”.')).toBeTruthy()
      expect(screen.queryByRole('list', { name: 'Status key' })).toBeNull()
      expect(screen.queryByText(/^Arrow keys move between cells/)).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Clear filter' }))
      expect((input as HTMLInputElement).value).toBe('')
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('at a 272px container the rows stack and nothing overflows', () => {
    width.value = 272
    render(<Harness />)
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('data-stacked')).toBe('true')
    expect(grid.style.width).toBe('270px')
    expect(monthHeaders(grid)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    expect(screen.getByText('Last 6 of 12 months')).toBeTruthy()
    expect(grid.querySelectorAll('[data-testid^="name-row-"][aria-hidden="true"]')).toHaveLength(24)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
    const name = grid.querySelector('[data-testid="name-row-svc-ingest"] [data-name]')!
    expect(name.className).toContain('line-clamp-2')
  })

  it('at 342px: six months inline, no chip or group beside the value', () => {
    width.value = 342
    render(<Harness />)
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('data-stacked')).toBe('false')
    expect(monthHeaders(grid)).toEqual(['Service', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Oct value'])
    expect(within(grid).queryByText('Payments')).toBeNull()
    expect(within(grid).getAllByText('Last Sep')).toHaveLength(2)
  })

  it('back from a drill-in, focus returns to the item once the measured layout is in place', () => {
    // The first commit lays out unmeasured (inline); the measured 272px then stacks every row.
    width.value = 272
    width.late = true
    const rect = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 272, 100))
    try {
      render(
        <Tooltip.Provider>
          <ItemGrid
            head={SERVICES[0]!}
            rows={ROWS}
            columns={columns}
            scale={FOUR}
            direction="higher_better"
            noun={{ one: 'service', many: 'services' }}
            sort="worst"
            onSort={() => {}}
            filter=""
            onFilter={() => {}}
            onOpenItem={() => {}}
            restoreId="svc-search"
          />
        </Tooltip.Provider>,
      )
      expect(screen.getByRole('grid').getAttribute('data-stacked')).toBe('true')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search, Oct 2026: Yellow, 99.87%')
    } finally {
      rect.mockRestore()
      width.late = false
    }
  })

  it('long names clamp to two lines', () => {
    width.value = 1296
    render(<Harness />)
    const th = within(screen.getByRole('grid')).getByRole('rowheader', { name: /Analytics Ingest Worker/ })
    expect(th.querySelector('[data-name]')!.className).toContain('line-clamp-2')
  })

  it('has no axe violations', async () => {
    width.value = 1296
    const { container } = render(<Harness />)
    expect((await axe(container)).violations).toEqual([])
    width.value = 272
    const stacked = render(<Harness />)
    expect((await axe(stacked.container)).violations).toEqual([])
  })
})
