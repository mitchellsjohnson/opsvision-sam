import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { buildTrendColumns } from './columns'
import { ItemSummaryTile } from './ItemSummaryTile'
import { buildItemRows } from './logic/itemGrid'

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

  it('rows only for services not at the best status and those not reported, at most five, each one button', () => {
    width.value = 560
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
    expect(screen.getByTestId('item-tile-rest').textContent).toBe('1 more not reported · All other 18 services Green')
    expect(screen.getByTestId('item-tile-months').getAttribute('aria-hidden')).toBe('true')
  })

  it('a row opens that service; the footer opens them all', async () => {
    width.value = 560
    const { onOpenItem, onExpand } = renderTile()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Open Search trend/ }))
    expect(onOpenItem).toHaveBeenCalledWith('svc-search', expect.any(HTMLElement))
    await user.click(screen.getByRole('button', { name: 'See all 24 services' }))
    expect(onExpand).toHaveBeenCalled()
    expect(screen.getByText('Exceptions first · Oct 2026')).toBeTruthy()
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

  it('at 560px: twelve months inline, the columns within the width', () => {
    width.value = 560
    renderTile()
    const board = screen.getByTestId('item-tile-board')
    expect(board.getAttribute('data-stacked')).toBe('false')
    const total = rowButtons()[0]!.style.gridTemplateColumns.split(' ').reduce((n, w) => n + parseFloat(w), 0)
    expect(total).toBeLessThanOrEqual(560 - 12)
  })

  it('has no axe violations inline', async () => {
    width.value = 560
    renderTile()
    expect((await axe(document.body)).violations).toEqual([])
  })

  it('has no axe violations stacked', async () => {
    width.value = 300
    renderTile()
    expect((await axe(document.body)).violations).toEqual([])
  })
})
