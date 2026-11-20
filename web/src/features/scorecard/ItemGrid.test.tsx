import * as Tooltip from '@radix-ui/react-tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { keys } from '../../api/queries'
import type { components } from '../../api/schema'
import { AuthContext } from '../../auth/context'
import { DEPLOYMENT_NOUN, DEPLOYMENT_SCALE, deploymentGroup, deploymentRows } from '../../test/deploymentFixtures'
import { testAuth } from '../../test/utils'
import { buildMonthTrendColumns, buildTrendColumns, type Column } from './columns'
import { ItemGrid, type ItemGridProps } from './ItemGrid'
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

/** How many times a status cell has rendered, to see that rows skip when nothing of theirs changed. */
const cellRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../ui/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/status')>()
  return {
    ...actual,
    StatusCell: (props: Parameters<typeof actual.StatusCell>[0]) => {
      cellRenders.count++
      return actual.StatusCell(props)
    },
  }
})

/** How many texts have been measured, to see that the grid measures again once fonts load. */
const measured = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../ui/textWidth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/textWidth')>()
  return {
    ...actual,
    textWidth: (text: string, font: string) => {
      measured.count++
      return actual.textWidth(text, font)
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

/** 24 services: 18 Green, 2 Yellow, 1 Red, 3 not reported this month (Reporting with no reports in the window). */
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
const SERVICE_NOUN = { one: 'service', many: 'services' }

const DEPLOYMENTS = deploymentRows(columns)
const DEP_ROWS = buildItemRows(DEPLOYMENTS, columns, DEPLOYMENT_SCALE, deploymentGroup, 1)
const COLUMNS_24 = buildMonthTrendColumns('2026-M10', 24, 1)
const DEP_ROWS_24 = buildItemRows(deploymentRows(COLUMNS_24), COLUMNS_24, DEPLOYMENT_SCALE, deploymentGroup, 1)

const serviceNames = (grid: HTMLElement) => [...grid.querySelectorAll('tbody th[scope=row] [data-name]')].map((n) => n.textContent)
const monthHeaders = (grid: HTMLElement) => [...grid.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent)
const valueOf = (grid: HTMLElement, id: string) => {
  const row = within(grid).getByTestId(`item-${id}`)
  return row.querySelector('[data-value]')?.textContent ?? within(grid).getByTestId(`name-row-${id}`).querySelector('[data-value]')?.textContent
}

/** A query cache that knows the deployments are in segments, so the group column is headed Segment. */
function segmentClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(
    keys.items,
    DEPLOYMENTS.map((d) => ({ id: d.subjectId, kindId: 'deployments', name: d.subjectName, orgUnitId: deploymentGroup(d.subjectId).toLowerCase(), sourceKeys: [] })),
  )
  client.setQueryData(keys.orgUnits, {
    units: ['Platform', 'Payments', 'Data', 'Mobile'].map((n) => ({ id: n.toLowerCase(), name: n, levelId: 'segment', parentId: 'acme', sourceKeys: [] })),
  })
  client.setQueryData(keys.orgLevels, [
    { id: 'company', name: 'Company', depth: 0 },
    { id: 'segment', name: 'Segment', depth: 1 },
  ])
  return client
}

function withProviders(ui: ReactElement, client = segmentClient()) {
  return (
    <AuthContext.Provider value={testAuth()}>
      <QueryClientProvider client={client}>
        <Tooltip.Provider>{ui}</Tooltip.Provider>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

function Harness({
  onOpenItem = () => {},
  onSort = () => {},
  rows = ROWS,
  head = SERVICES[0]!,
  cols = columns,
  scale = FOUR,
  noun = SERVICE_NOUN,
  range,
  restoreId,
  silent,
}: {
  onOpenItem?: (id: string) => void
  onSort?: (s: ItemSort) => void
  rows?: typeof ROWS
  head?: ViewRow
  cols?: Column[]
  scale?: StatusLevel[]
  noun?: { one: string; many: string }
  range?: ItemGridProps['range']
  restoreId?: string
  /** Controls the silent group from here, reporting each change. */
  silent?: { initial: boolean; onChange: (open: boolean) => void }
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<ItemSort>('worst')
  const [silentOpen, setSilentOpen] = useState(silent?.initial ?? false)
  const [, setTick] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        Re-render
      </button>
      <ItemGrid
        head={head}
        rows={rows}
        columns={cols}
        scale={scale}
        direction="higher_better"
        noun={noun}
        sort={sort}
        onSort={(s) => {
          setSort(s)
          onSort(s)
        }}
        filter={filter}
        onFilter={setFilter}
        onOpenItem={(id) => onOpenItem(id)}
        range={range}
        restoreId={restoreId}
        {...(silent
          ? {
              silentOpen,
              onSilentOpen: (open: boolean) => {
                silent.onChange(open)
                setSilentOpen(open)
              },
            }
          : {})}
      />
    </>
  )
}

const renderGrid = (props: Parameters<typeof Harness>[0] = {}) => render(withProviders(<Harness {...props} />))
const renderDeployments = (props: Parameters<typeof Harness>[0] = {}) =>
  renderGrid({ rows: DEP_ROWS, head: DEPLOYMENTS[0]!, scale: DEPLOYMENT_SCALE, noun: DEPLOYMENT_NOUN, ...props })

/** SERVICES plus Archive, not applicable this month. */
function withArchive() {
  const archive = service('svc-archive', 'Archive', null)
  Object.assign(archive.cells[archive.cells.length - 1]!, { naReason: 'Retired in Oct', coverage: [0, 0] })
  return buildItemRows([...SERVICES, archive], columns, FOUR, groupOf, 1)
}

describe('ItemGrid', () => {
  it('leads with the services at the best status, out of all of them, and the worst now', () => {
    width.value = 1296
    renderGrid()
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

  it('a grid of services by month: not reported under their own header, the silent collapsed last', () => {
    width.value = 1296
    renderGrid()
    const grid = screen.getByRole('grid', { name: 'Uptime by service and month' })
    const names = serviceNames(grid)
    expect(names).toHaveLength(23)
    expect(names.slice(0, 3)).toEqual(['Web App', 'Analytics Ingest Worker', 'Search'])
    expect(names.slice(-3)).toEqual(['Public API', 'Pricing Engine', 'Push Gateway'])
    expect([...grid.querySelectorAll('th[scope=rowgroup]')].map((th) => th.querySelector('[data-group-label]')?.textContent)).toEqual([
      'Not reported this month · 2',
      'No reports in the last 12 months · 1',
    ])
    expect(within(grid).getByRole('columnheader', { name: 'Red months' })).toBeTruthy()
    // One tab stop: the worst service's selected month.
    const stops = within(grid).getAllByRole('button').filter((b) => b.tabIndex === 0)
    expect(stops.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Web App, Oct 2026: Red, 99.06%', 'Show 1 service'])
    expect(screen.getByText('Nov 2025 – Oct 2026 · 12 months')).toBeTruthy()
    expect(valueOf(grid, 'svc-push')).toBe('Last Sep 99.99%')
  })

  it('arrow down from the last reported row lands on the first not reported row', async () => {
    width.value = 1296
    renderGrid()
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Public API, Oct 2026: Green, 100.00%' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Pricing Engine, Oct 2026: No data')
  })

  it('Enter opens the service', async () => {
    width.value = 1296
    const onOpenItem = vi.fn()
    renderGrid({ onOpenItem })
    screen.getByRole('button', { name: 'Web App, Oct 2026: Red, 99.06%' }).focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onOpenItem).toHaveBeenCalledWith('svc-web')
  })

  it('sort is a segmented control', async () => {
    width.value = 1296
    const onSort = vi.fn()
    renderGrid({ onSort })
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
      renderGrid()
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
    renderGrid()
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('data-stacked')).toBe('true')
    expect(grid.style.width).toBe('270px')
    expect(monthHeaders(grid)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    expect(screen.getByText('Last 6 of 12 months')).toBeTruthy()
    expect(grid.querySelectorAll('[data-testid^="name-row-"][aria-hidden="true"]')).toHaveLength(23)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
    expect(grid.querySelector('.line-clamp-2')).toBeNull()
    expect(valueOf(grid, 'svc-push')).toBe('Last Sep')
  })

  it('back from a drill-in, focus returns to the item once the measured layout is in place', () => {
    // The first commit lays out unmeasured (inline); the measured 272px then stacks every row.
    width.value = 272
    width.late = true
    const rect = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 272, 100))
    try {
      renderGrid({ restoreId: 'svc-search' })
      expect(screen.getByRole('grid').getAttribute('data-stacked')).toBe('true')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search, Oct 2026: Yellow, 99.87%')
    } finally {
      rect.mockRestore()
      width.late = false
    }
  })

  it('n/a services are counted and grouped apart from the not reported; the cell reads n/a', () => {
    width.value = 1296
    renderGrid({ rows: withArchive() })
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('18 of 25 services Green')).toBeTruthy()
    expect(within(summary).getByTestId('summary-counts').textContent).toBe('◆ 1 Red · ▲ 2 Yellow · 3 not reported · 1 n/a · Oct 2026')
    const grid = screen.getByRole('grid')
    expect([...grid.querySelectorAll('th[scope=rowgroup] [data-group-label]')].map((th) => th.textContent)).toEqual([
      'Not reported this month · 2',
      'Not applicable this month · 1',
      'No reports in the last 12 months · 1',
    ])
    expect(serviceNames(grid).slice(-1)).toEqual(['Archive'])
    expect(valueOf(grid, 'svc-archive')).toBe('n/a')
  })

  it('Escape in a non-empty filter clears it and goes no further; in an empty one it passes on', async () => {
    width.value = 1296
    renderGrid()
    const seen: boolean[] = []
    const listen = (e: KeyboardEvent) => e.key === 'Escape' && seen.push(e.defaultPrevented)
    window.addEventListener('keydown', listen)
    try {
      const user = userEvent.setup()
      const input = screen.getByRole('searchbox', { name: 'Filter services' }) as HTMLInputElement
      await user.type(input, 'led')
      await user.keyboard('{Escape}')
      expect(input.value).toBe('')
      expect(serviceNames(screen.getByRole('grid'))).toHaveLength(23)
      await user.keyboard('{Escape}')
      expect(seen).toEqual([true, false])
    } finally {
      window.removeEventListener('keydown', listen)
    }
  })

  it('the range control shows only where the grid can show more months than the shortest range', () => {
    const range = { control: <button type="button">Range control</button>, minCount: 6, maxCount: 24 }
    width.value = 342
    renderGrid({ range })
    expect(screen.queryByRole('button', { name: 'Range control' })).toBeNull()
    width.value = 1296
    const wide = renderGrid({ range })
    expect(within(wide.container).getByRole('button', { name: 'Range control' })).toBeTruthy()
  })

  it('rows skip re-rendering when nothing of theirs changed', async () => {
    width.value = 1296
    renderGrid()
    const user = userEvent.setup()
    const before = cellRenders.count
    await user.click(screen.getByRole('button', { name: 'Re-render' }))
    expect(cellRenders.count).toBe(before)
    // Moving the tab stop redraws the two rows it leaves and enters, not all 23.
    screen.getByRole('button', { name: 'Web App, Oct 2026: Red, 99.06%' }).focus()
    const moved = cellRenders.count
    await user.keyboard('{ArrowDown}')
    expect(cellRenders.count - moved).toBeLessThanOrEqual(2 * columns.length)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Analytics Ingest Worker, Oct 2026: Yellow, 99.83%')
  })

  it('one item: no filter and no sort control', () => {
    width.value = 1296
    renderGrid({ rows: ROWS.slice(0, 1) })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('every item silent: their group is open, with no button', () => {
    width.value = 1296
    const silent = buildItemRows([service('a', 'Alpha', null, null), service('b', 'Beta', null, null)], columns, FOUR, groupOf, 1)
    renderGrid({ rows: silent })
    const grid = screen.getByRole('grid')
    expect(serviceNames(grid)).toEqual(['Alpha', 'Beta'])
    expect(within(grid).queryByRole('button', { name: /^Show / })).toBeNull()
  })
})

describe('ItemGrid: the 21 deployments', () => {
  it('every row is one height and no name is clamped', () => {
    width.value = 1294
    renderDeployments()
    const grid = screen.getByRole('grid')
    expect(grid.querySelector('.line-clamp-2')).toBeNull()
    const rows = [...grid.querySelectorAll<HTMLElement>('tr[data-testid^="item-"]')]
    expect(rows).toHaveLength(13)
    for (const tr of rows) expect(tr.className).toContain('h-8')
    const name = within(grid).getByTestId('item-dep-portal-cloud').querySelector('[data-name]')!
    expect(name.textContent).toBe('Customer Portal - Private Cloud Tenant Suite')
  })

  it('fills the card', () => {
    for (const w of [1774, 1294, 878, 600]) {
      width.value = w
      const { unmount } = renderDeployments()
      expect(screen.getByRole('grid').style.width).toBe(`${w}px`)
      unmount()
    }
  })

  it('group column: headed by the groups’ level when they differ; none with one group', async () => {
    width.value = 1294
    const { unmount } = renderDeployments()
    const grid = screen.getByRole('grid')
    expect(within(grid).getByRole('columnheader', { name: 'Segment' })).toBeTruthy()
    expect(within(within(grid).getByTestId('item-dep-portal-cloud')).getByText('Platform').tagName).toBe('TD')
    unmount()
    const one = buildItemRows(DEPLOYMENTS, columns, DEPLOYMENT_SCALE, () => 'Platform', 1)
    renderDeployments({ rows: one })
    const single = screen.getByRole('grid')
    expect(within(single).queryByRole('columnheader', { name: 'Segment' })).toBeNull()
    expect(within(single).queryByRole('columnheader', { name: 'Group' })).toBeNull()
    expect(monthHeaders(single)[1]).toBe('Nov')
  })

  it('no group column at 878: the cells keep their 24px target', () => {
    width.value = 878
    renderDeployments()
    expect(within(screen.getByRole('grid')).queryByRole('columnheader', { name: 'Segment' })).toBeNull()
  })

  it('one-line not reported', () => {
    width.value = 1294
    const { unmount } = renderDeployments()
    const grid = screen.getByRole('grid')
    expect(valueOf(grid, 'dep-webhooks-us')).toBe('Last Sep 100.00%')
    expect(valueOf(grid, 'dep-search-legacy')).toBe('Last Dec 99.20%')
    unmount()
    renderDeployments({ rows: DEP_ROWS_24, cols: COLUMNS_24 })
    const long = screen.getByRole('grid')
    expect(monthHeaders(long)).toHaveLength(24 + 3)
    expect(valueOf(long, 'dep-search-legacy')).toBe('Last Dec 2025 99.20%')
  })

  it('quarter view: a repeated quarter carries its year (Last Q3 FY2025)', () => {
    width.value = 1294
    const q = buildTrendColumns('2026-Q3', 1)
    const quarterly = (id: string, name: string, values: (number | null)[]): ViewRow => ({
      ...service(id, name, null),
      frequency: 'quarterly',
      cells: q.map((c, i) => cellOf(id, c.period, values[i] ?? null)),
    })
    const rows = buildItemRows(
      [
        quarterly('dep-pay-eu', 'Payments Gateway - EU Region Primary', [100, 100, 100, 100, 100, 100, 100, 99.99]),
        quarterly('dep-partner', 'Partner API Gateway - Sandbox Environment', [99.98, 99.98, 99.98, 99.98]),
      ],
      q,
      DEPLOYMENT_SCALE,
      deploymentGroup,
      1,
    )
    renderDeployments({ rows, cols: q })
    expect(valueOf(screen.getByRole('grid'), 'dep-partner')).toBe('Last Q3 FY2025 99.98%')
  })

  it('silent group is last and collapsed; Show opens it and keeps focus on the button', async () => {
    width.value = 1294
    renderDeployments()
    const grid = screen.getByRole('grid')
    const bodies = grid.querySelectorAll('tbody')
    const last = bodies[bodies.length - 1]!
    expect(last.querySelector('[data-group-label]')!.textContent).toBe('No reports in the last 12 months · 8')
    const show = within(last).getByRole('button', { name: 'Show 8 deployments' })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    expect(show.hasAttribute('aria-controls')).toBe(false)
    expect(within(last).getByTestId('silent-preview').textContent).toMatch(/^Analytics Warehouse - Batch Loader Primary, Analytics Warehouse/)
    expect(serviceNames(grid)).toHaveLength(13)

    const user = userEvent.setup()
    await user.click(show)
    const after = grid.querySelectorAll('tbody')
    const rowsBody = after[after.length - 1]!
    expect(rowsBody.id).not.toBe('')
    expect(show.getAttribute('aria-controls')).toBe(rowsBody.id)
    expect(show.getAttribute('aria-expanded')).toBe('true')
    expect(rowsBody.querySelectorAll('tr[data-testid^="item-"]')).toHaveLength(8)
    expect(document.activeElement).toBe(show)
    expect(show.textContent).toBe('Hide')
    expect(screen.getByTestId('item-grid-live').textContent).toBe('Showing 8 more deployments')
    expect(within(grid).queryByTestId('silent-preview')).toBeNull()

    await user.click(show)
    expect(serviceNames(grid)).toHaveLength(13)
    expect(document.activeElement).toBe(show)
    expect(screen.getByTestId('item-grid-live').textContent).toBe('Hid 8 deployments')
  })

  it('a silent row reads no reports in its value cell', async () => {
    width.value = 1294
    renderDeployments()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 8 deployments' }))
    expect(valueOf(screen.getByRole('grid'), 'dep-edge-cache')).toBe('—No reports')
  })

  it('phone header: the silent group header is two lines, with no name preview', () => {
    width.value = 340
    renderDeployments()
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('data-stacked')).toBe('true')
    const header = grid.querySelector('[data-testid="silent-header"]')!
    expect(header.className).toContain('flex-col')
    expect(within(header as HTMLElement).getByRole('button', { name: 'Show 8 deployments' })).toBeTruthy()
    expect(within(grid).queryByTestId('silent-preview')).toBeNull()
  })

  it('phone grid: no fiscal-year row when the shown months sit in one year; two years keep it', () => {
    width.value = 340
    const { unmount } = renderDeployments()
    expect(screen.getByRole('grid').querySelectorAll('th[scope=colgroup]')).toHaveLength(0)
    unmount()
    width.value = 1294
    renderDeployments()
    expect([...screen.getByRole('grid').querySelectorAll('th[scope=colgroup]')].map((th) => th.textContent)).toEqual(['FY2025', 'FY2026'])
  })

  it('phone summary: Worst now on two lines, the name keeping its tail, no group or Red-month count', () => {
    width.value = 340
    renderDeployments()
    const worst = screen.getByTestId('worst-now')
    const [first, second] = [...worst.children] as HTMLElement[]
    expect(first!.textContent).toBe('Worst nowNotification Relay - Multi-Region Active')
    expect(first!.querySelector('[data-name]')).toBeTruthy()
    expect(second!.textContent).toContain('99.63%')
    expect(second!.textContent).toContain('Red since Oct 2026 · 1 month')
    expect(worst.textContent).not.toContain('Platform')
    expect(worst.textContent).not.toContain('in the last 12')
  })

  it('filter that matches only silent items: rows under the match count, no Show button, the tab stop on the first', async () => {
    width.value = 1294
    renderDeployments()
    const user = userEvent.setup()
    const input = screen.getByRole('searchbox', { name: 'Filter deployments' })
    await user.type(input, 'Warehouse')
    const grid = screen.getByRole('grid')
    expect(serviceNames(grid)).toEqual(['Analytics Warehouse - Batch Loader Primary', 'Analytics Warehouse - Batch Loader Replica'])
    expect(grid.querySelector('[data-testid="silent-header"] [data-group-label]')!.textContent).toBe(
      'No reports in the last 12 months · 2 match',
    )
    expect(within(grid).queryByRole('button', { name: /^Show |^Hide$/ })).toBeNull()
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Analytics Warehouse - Batch Loader Primary, Oct 2026: No data')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Analytics Warehouse - Batch Loader Replica, Oct 2026: No data')
  })

  it('back to a silent item opens its group, then focuses its cell', () => {
    width.value = 1294
    const onChange = vi.fn()
    renderDeployments({ restoreId: 'dep-edge-cache', silent: { initial: false, onChange } })
    expect(onChange).toHaveBeenCalledWith(true)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edge Cache, Oct 2026: No data')
    expect(screen.getByTestId('item-grid-live').textContent).toBe('Showing 8 more deployments')
  })

  it('tooltip leads with the full name and group', async () => {
    width.value = 1294
    renderDeployments()
    act(() => screen.getByRole('button', { name: /^Customer Portal - Private Cloud Tenant Suite, Oct 2026/ }).focus())
    const tip = await screen.findByTestId('tip-title')
    expect(tip.textContent).toBe('Customer Portal - Private Cloud Tenant Suite · Platform')
    expect(tip.parentElement!.firstElementChild).toBe(tip)
  })

  it('measures again when fonts load', async () => {
    width.value = 1294
    let resolve = () => {}
    const ready = new Promise<void>((r) => (resolve = r))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready } })
    try {
      renderDeployments()
      const first = measured.count
      expect(first).toBeGreaterThan(0)
      await act(async () => {
        resolve()
        await ready
      })
      expect(measured.count).toBeGreaterThan(first)
    } finally {
      delete (document as { fonts?: unknown }).fonts
    }
  })

  it('phone legend is one line with only the keys present', () => {
    width.value = 340
    renderDeployments()
    const legend = screen.getByRole('list', { name: 'Status key' })
    expect(within(legend).getAllByRole('listitem').map((li) => li.lastChild?.textContent)).toEqual(['Green', 'Red', 'No data'])
    expect(legend.className).toContain('flex-nowrap')
    expect(legend.className).toContain('text-[11px]')
  })

  it('desktop legend shows the keys present in the shown months', () => {
    width.value = 1294
    renderDeployments()
    const legend = screen.getByRole('list', { name: 'Status key' })
    expect(within(legend).getAllByRole('listitem').map((li) => li.lastChild?.textContent)).toEqual(['Green', 'Yellow', 'Red', 'No data'])
  })

  it('has no axe violations, collapsed and expanded, inline and stacked', async () => {
    width.value = 1294
    const { container, unmount } = renderDeployments()
    expect((await axe(container)).violations).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 8 deployments' }))
    expect((await axe(container)).violations).toEqual([])
    unmount()
    width.value = 340
    const stacked = renderDeployments()
    expect((await axe(stacked.container)).violations).toEqual([])
  })
})
