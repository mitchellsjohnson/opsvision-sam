import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { buildTrendColumns } from './columns'
import { ItemSummaryTile } from './ItemSummaryTile'
import { buildItemRows } from './logic/itemGrid'
import { DEPLOYMENT_NOUN, DEPLOYMENT_SCALE, deploymentGroup, deploymentRows } from '../../test/deploymentFixtures'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']
type StatusLevel = components['schemas']['StatusLevel']
type StatusRule = components['schemas']['StatusRule']

/** The tile's measured width. */
const width = vi.hoisted(() => ({ value: 560 }))
vi.mock('../../ui/useElementWidth', () => ({
  useElementWidth: () => [() => {}, width.value],
}))

const columns = buildTrendColumns('2026-M10', 1)
const SCALE: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]
const STATUS_OF = (v: number) => (v >= 99.9 ? 'G' : v > 99.8 ? 'Y' : 'R')
const RULE: StatusRule = {
  type: 'bands',
  bands: [
    { status: 'G', op: '>=', value: 99.9 },
    { status: 'Y', op: '>', value: 99.8 },
    { status: 'R', op: '', value: 0 },
  ],
}

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
const id = (name: string) => `svc-${name.toLowerCase().replace(/\W+/g, '-')}`

/** 24 services: 18 Green, 2 Yellow, 1 Red, 3 not reported this month. */
const SERVICES: ViewRow[] = [
  service('svc-web', 'Web service', 99.2),
  service('svc-ingest', 'Analytics Ingest Worker', 99.83),
  service('svc-search', 'Search', 99.87),
  ...GREEN.map((name) => service(id(name), name, 99.99)),
  service('svc-public', 'Public API', 100),
  service('svc-push', 'Push Gateway', null),
  service('svc-pricing', 'Pricing Engine', null),
  service('svc-report', 'Reporting', null, null),
]
const NOUN = { one: 'service', many: 'services' }

function renderTile(services = SERVICES, { rule = RULE, onOpenItem = vi.fn(), onExpand = vi.fn() } = {}) {
  render(
    <main>
      <ItemSummaryTile
        head={services[0]!}
        rows={buildItemRows(services, columns, SCALE, () => 'Platform', 1)}
        columns={columns}
        scale={SCALE}
        direction="higher_better"
        noun={NOUN}
        rule={rule}
        onExpand={onExpand}
        onOpenItem={onOpenItem}
      />
    </main>,
  )
  return { onOpenItem, onExpand }
}

const rowButtons = () => screen.getAllByRole('button', { name: /^Open / })

describe('ItemSummaryTile', () => {
  it('is a tile: an article with an h3, the item count and threshold line, and Expand', () => {
    width.value = 560
    renderTile()
    const tile = screen.getByRole('article', { name: 'Uptime' })
    expect(within(tile).getByRole('heading', { level: 3, name: 'Uptime' })).toBeTruthy()
    expect(within(tile).getByText('24 services · Green at 99.90% or better')).toBeTruthy()
    expect(within(tile).getByRole('button', { name: 'Expand Uptime' })).toBeTruthy()
  })

  it('leads with the worst service, its value and status, and since when', () => {
    width.value = 560
    renderTile()
    const value = screen.getByTestId('item-tile-worst')
    expect(value.textContent).toMatch(/^Worst/)
    expect(within(value).getByText('Web service')).toBeTruthy()
    expect(within(value).getByText('99.20%')).toBeTruthy()
    expect(within(value).getByRole('img', { name: 'Red' })).toBeTruthy()
    expect(screen.getByText('Red since Oct 2026 · 1 month')).toBeTruthy()
  })

  it('a proportion bar and the distribution in words, the best status first and bold', () => {
    width.value = 560
    renderTile()
    expect(screen.getByRole('img', { name: '18 Green, 2 Yellow, 1 Red, 3 not reported, of 24 services' })).toBeTruthy()
    const line = screen.getByTestId('item-tile-distribution')
    expect(line.textContent).toBe('18 Green · 2 Yellow · 1 Red · 3 not reported')
    expect(within(line).getByText('18 Green').tagName).toBe('STRONG')
  })

  it('names n/a services apart from not reported, in words, the bar and its spoken summary', () => {
    width.value = 560
    const retired = service('svc-retired', 'Retired service', null)
    retired.cells[retired.cells.length - 1]!.naReason = 'Retired in Oct'
    renderTile([...SERVICES, retired])
    expect(screen.getByTestId('item-tile-distribution').textContent).toBe('18 Green · 2 Yellow · 1 Red · 3 not reported · 1 n/a')
    expect(
      screen.getByRole('img', { name: '18 Green, 2 Yellow, 1 Red, 3 not reported, 1 not applicable, of 25 services' }).children,
    ).toHaveLength(5)
    // Not an exception: no row, and not counted among those not reported.
    expect(screen.queryByRole('button', { name: /^Open Retired service/ })).toBeNull()
    expect(screen.getByTestId('item-tile-rest').textContent).toBe('All other 18 services Green · 1 with no reports in 12 months')
  })

  it('states the threshold as an item metric’s: the best band only, whatever its chart kind', () => {
    width.value = 560
    renderTile(SERVICES.map((s) => ({ ...s, chartKind: 'ratio' })))
    expect(screen.getByText('24 services · Green at 99.90% or better')).toBeTruthy()
  })

  it('rows only for services not at the best status and those that stopped in view, at most five, each one button', () => {
    width.value = 600
    renderTile()
    expect(rowButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open Web service trend: 99.20%, Red',
      'Open Analytics Ingest Worker trend: 99.83%, Yellow',
      'Open Search trend: 99.87%, Yellow',
      'Open Pricing Engine trend: not reported this month, last Sep 99.99%',
      'Open Push Gateway trend: not reported this month, last Sep 99.99%',
    ])
    for (const b of rowButtons()) {
      const cells = b.querySelector('[data-cells]')!
      expect(cells.getAttribute('aria-hidden')).toBe('true')
      expect(cells.querySelectorAll('[data-kind]')).toHaveLength(12)
    }
    expect(screen.getByTestId('item-tile-rest').textContent).toBe('All other 18 services Green · 1 with no reports in 12 months')
    expect(screen.getByTestId('item-tile-months').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('Exceptions first · Oct 2026')).toBeTruthy()
  })

  it('a row opens that service; the footer opens them all', async () => {
    width.value = 560
    const { onOpenItem, onExpand } = renderTile()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Open Search trend/ }))
    expect(onOpenItem).toHaveBeenCalledWith('svc-search', expect.any(HTMLElement))
    await user.click(screen.getByRole('button', { name: 'See all 24 services' }))
    expect(onExpand).toHaveBeenCalled()
  })

  it('the closing line counts through the noun: All other 1 service Green', () => {
    width.value = 560
    renderTile([service('svc-web', 'Web service', 99.2), service('svc-api', 'API service', 99.95)])
    expect(screen.getByTestId('item-tile-rest').textContent).toBe('All other 1 service Green')
  })

  it('every service at the best status: no rows, and says so', () => {
    width.value = 560
    renderTile([service('svc-a', 'API service', 99.95), service('svc-b', 'Billing', 99.99)])
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0)
    expect(screen.getByTestId('item-tile-rest').textContent).toBe('All 2 services Green')
  })

  it('names how many services have their own target', () => {
    width.value = 560
    renderTile(SERVICES, {
      rule: {
        ...RULE,
        perSubject: [
          {
            subjectId: id('Status Page'),
            bands: [
              { status: 'G', op: '>=', value: 99.5 },
              { status: 'R', op: '', value: 0 },
            ],
          },
        ],
      },
    })
    expect(screen.getByText('24 services · Green at 99.90% or better · 1 service has its own target')).toBeTruthy()
  })

  it('at a 300px container the rows stack within the width', () => {
    width.value = 300
    renderTile()
    const board = screen.getByTestId('item-tile-board')
    expect(board.getAttribute('data-stacked')).toBe('true')
    expect(screen.queryByTestId('item-tile-months')).toBeNull()
    for (const b of rowButtons()) {
      const cells = b.querySelector<HTMLElement>('[data-cells]')!
      expect(cells.querySelectorAll('[data-kind]')).toHaveLength(6)
      expect(parseFloat(cells.style.width)).toBeLessThanOrEqual(300 - 12)
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
  })

  it('at 600px: twelve months inline, the columns filling the width', () => {
    width.value = 600
    renderTile()
    const board = screen.getByTestId('item-tile-board')
    expect(board.getAttribute('data-stacked')).toBe('false')
    const total = rowButtons()[0]!.style.gridTemplateColumns.split(' ').reduce((n, w) => n + parseFloat(w), 0)
    expect(total).toBe(600 - 12)
  })

  it('has no axe violations inline', async () => {
    width.value = 560
    renderTile()
    expect((await axe(document.body)).violations).toEqual([])
  })

  it('quarter view: a stopped row names the year of a repeated quarter (Last Q4 FY2025)', () => {
    width.value = 900
    const q = buildTrendColumns('2026-Q3', 1)
    const quarterly = (sid: string, name: string, values: (number | null)[]): ViewRow => ({
      ...service(sid, name, null),
      frequency: 'quarterly',
      cells: q.map((c, i) => cellOf(sid, c.period, values[i] ?? null)),
    })
    const services = [
      quarterly('svc-web', 'Web service', [99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.2]),
      quarterly('svc-partner', 'Partner API Gateway', [99.98, 99.98, 99.98, 99.98, 99.98]),
    ]
    render(
      <main>
        <ItemSummaryTile
          head={services[0]!}
          rows={buildItemRows(services, q, SCALE, () => 'Platform', 1)}
          columns={q}
          scale={SCALE}
          direction="higher_better"
          noun={NOUN}
          rule={RULE}
          onExpand={vi.fn()}
          onOpenItem={vi.fn()}
        />
      </main>,
    )
    const row = screen.getByRole('button', { name: /^Open Partner API Gateway trend/ })
    expect(row.querySelector('[data-value]')!.textContent).toBe('Last Q4 FY2025')
    expect(row.getAttribute('aria-label')).toBe('Open Partner API Gateway trend: not reported this quarter, last Q4 FY2025 99.98%')
  })

  it('has no axe violations stacked', async () => {
    width.value = 300
    renderTile()
    expect((await axe(document.body)).violations).toEqual([])
  })

  describe('the 21 deployments', () => {
    const deployments = deploymentRows(columns)
    const renderDeployments = () =>
      render(
        <main>
          <ItemSummaryTile
            head={deployments[0]!}
            rows={buildItemRows(deployments, columns, DEPLOYMENT_SCALE, deploymentGroup, 1)}
            columns={columns}
            scale={DEPLOYMENT_SCALE}
            direction="higher_better"
            noun={DEPLOYMENT_NOUN}
            rule={RULE}
            onExpand={vi.fn()}
            onOpenItem={vi.fn()}
          />
        </main>,
      )
    const names = () => rowButtons().map((b) => b.querySelector('[data-name]')!.textContent)

    it('a 536px tile shows the latest 6 months, so the names keep their room', () => {
      width.value = 536
      renderDeployments()
      expect(screen.getByTestId('item-tile-board').getAttribute('data-stacked')).toBe('false')
      for (const b of rowButtons()) expect(b.querySelectorAll('[data-cells] [data-kind]')).toHaveLength(6)
      expect(screen.getByTestId('item-tile-months').textContent).toBe('deploymentMayJunJulAugSepOctOct')
      expect(screen.getByText('Exceptions first · last 6 months · Oct 2026')).toBeTruthy()
    })

    it('rows for the Red one and those that stopped inside the shown months; none for the silent or the long stopped', () => {
      width.value = 536
      renderDeployments()
      expect(names()).toEqual([
        'Notification Relay - Multi-Region Active',
        'Webhook Dispatcher - US Region Primary',
        'Document Renderer - Shared Worker Pool',
        'Identity Service - Disaster Recovery Standby',
      ])
      expect(screen.queryByRole('button', { name: /Search Indexer - Legacy Cluster B/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Edge Cache/ })).toBeNull()
    })

    it('the footer counts what has no row', () => {
      width.value = 536
      renderDeployments()
      expect(screen.getByTestId('item-tile-rest').textContent).toBe(
        'All other 8 deployments Green · 1 stopped before May · 8 with no reports in 12 months',
      )
    })

    it('a stopped row reads Last Sep; the value is in the dialog', () => {
      width.value = 536
      renderDeployments()
      const row = screen.getByRole('button', { name: /^Open Webhook Dispatcher - US Region Primary trend/ })
      expect(row.querySelector('[data-value]')!.textContent).toBe('Last Sep')
      expect(row.getAttribute('aria-label')).toBe(
        'Open Webhook Dispatcher - US Region Primary trend: not reported this month, last Sep 100.00%',
      )
    })

    it('names keep their tail', () => {
      width.value = 536
      renderDeployments()
      const name = rowButtons()[1]!.querySelector('[data-name]')!
      expect(name.lastElementChild!.textContent).toBe(' - US Region Primary')
      expect(name.querySelector('.line-clamp-2')).toBeNull()
    })

    it('a half-width tile at 1024 (398px inside) stays inline', () => {
      width.value = 398
      renderDeployments()
      expect(screen.getByTestId('item-tile-board').getAttribute('data-stacked')).toBe('false')
      expect(screen.getByTestId('item-tile-months')).toBeTruthy()
    })

    it('at 358px the rows stack: name and value on a line, six cells below', () => {
      width.value = 358
      renderDeployments()
      expect(screen.getByTestId('item-tile-board').getAttribute('data-stacked')).toBe('true')
      expect(screen.queryByTestId('item-tile-months')).toBeNull()
      for (const b of rowButtons()) expect(b.querySelectorAll('[data-cells] [data-kind]')).toHaveLength(6)
    })

    it('has no axe violations', async () => {
      width.value = 536
      renderDeployments()
      expect((await axe(document.body)).violations).toEqual([])
    })
  })
})
