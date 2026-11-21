import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import { AttentionCard, NeedsAttention, type AttentionMeta } from './AttentionCard'
import { chartTheme } from './charts/chartTheme'
import { buildTrendColumns } from './columns'
import type { RankedItem } from './logic/needsAttention'
import type { BoardCell } from './logic/statusBoard'

type StatusLevel = components['schemas']['StatusLevel']

/** The mini board's measured width; 0 (not measured) unless a test sets it. */
const width = vi.hoisted(() => ({ value: 0 }))
vi.mock('../../ui/useElementWidth', () => ({
  useElementWidth: () => [() => {}, width.value],
}))

const SCALE: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]
const columns = buildTrendColumns('2026-M10', 1)

function cells(statuses: string[]): BoardCell[] {
  return statuses.map((status, i) => ({ key: columns[i]!.key, kind: 'status', status, display: '', naReason: '', change: null, caption: '' }))
}
const RED_FROM_JUL = cells(['Y', 'Y', 'Y', 'Y', 'Y', 'Y', 'Y', 'Y', 'R', 'R', 'R', 'R'])

function ranked(over: Partial<RankedItem> = {}): RankedItem {
  return {
    metricKey: 'backlog',
    name: 'Weighted support backlog',
    categoryOrder: 1,
    status: 'R',
    value: 681,
    change: 34,
    direction: 'lower_better',
    rule: { type: 'bands', bands: [] },
    priorStatus: 'R',
    streakMonths: 4,
    priorLabel: 'Red',
    label: 'Red',
    since: 'Red since Jul 2026 · 4 months',
    tier: 1,
    distance: 0.5,
    newRed: false,
    reason: 'Red since Jul 2026 · 4 months',
    ...over,
  }
}

const META: AttentionMeta = {
  category: 'Quality',
  scale: SCALE,
  display: '681',
  caption: '',
  change: { text: '+34 vs Sep', move: { arrow: '▲', tone: 'bad' } },
  threshold: 'Lower is better · Yellow above 450 · Red above 600',
  trend: {
    points: columns.map((c, i) => ({ label: c.label, value: 500 + i * 16 })),
    goal: null,
    bands: [
      { status: 'R', op: '>', value: 600 },
      { status: 'Y', op: '>', value: 450 },
      { status: 'G', op: '', value: 0 },
    ],
    summary: 'Trend over 12 months: from 500 to 681',
  },
  ribbon: { cells: RED_FROM_JUL, labels: columns.map((c) => c.label[0]!) },
  why: { lead: 'Highest', name: 'Android App', display: '941', status: 'R', share: '4 of 8 products Red' },
}

function renderCard(props: Partial<Parameters<typeof AttentionCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ul>
        <li>
          <AttentionCard item={ranked()} meta={META} href="?period=2026-M10&focus=backlog" compact={false} {...props} />
        </li>
      </ul>
    </MemoryRouter>,
  )
}

describe('AttentionCard', () => {
  it('is an article titled by an h3 whose link covers the card; the link is described by the value and the reason', () => {
    renderCard()
    const card = screen.getByRole('article', { name: 'Weighted support backlog' })
    const heading = within(card).getByRole('heading', { level: 3 })
    const link = within(heading).getByRole('link')
    expect(link.getAttribute('href')).toBe('/?period=2026-M10&focus=backlog')
    expect(link.className).toContain('after:absolute')
    expect(link.textContent).toBe('Weighted support backlog')
    const described = (link.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '')
    expect(described).toContain('Red since Jul 2026 · 4 months')
    expect(described.some((t) => t.includes('681') && t.includes('Red') && t.includes('+34 vs Sep'))).toBe(true)
    expect(described).toContain('Trend over 12 months: from 500 to 681')
  })

  it('reads eyebrow, reason, title, value row, threshold, trend, ribbon and the why line', () => {
    renderCard()
    const card = screen.getByRole('article')
    expect(within(card).getByText('Quality')).toBeTruthy()
    expect(within(card).getByText('Red since Jul 2026 · 4 months').className).toContain('text-status-r')
    expect(within(card).getByText('Lower is better · Yellow above 450 · Red above 600')).toBeTruthy()
    expect(card.querySelector('svg')).toBeTruthy()
    const ribbon = within(card).getByTestId('attention-ribbon')
    expect(ribbon.getAttribute('aria-hidden')).toBe('true')
    expect(ribbon.children).toHaveLength(12)
    expect(within(card).getByTestId('attention-why').textContent).toBe('Highest: Android App 941 ◆R · 4 of 8 products Red')
  })

  it('the exec summary line sits under the driver line, above the stretched link, and opens the card', async () => {
    const onOpen = vi.fn()
    const summary = { display: { state: 'written' as const, excerpt: 'The backlog grew on two Android releases…', author: 'Avery Admin', canEdit: true }, periodLabel: 'Oct 2026', onOpen }
    renderCard({ meta: { ...META, summary } })
    const card = screen.getByRole('article')
    const line = within(card).getByTestId('attention-summary')
    expect(line.className).toContain('relative')
    expect(line.className).toContain('z-10')
    const why = within(line).getByRole('button', { name: 'Why Weighted support backlog is 681 in Oct 2026: exec summary by Avery Admin' })
    expect(why.textContent).toBe('Summary:The backlog grew on two Android releases…')
    const driver = within(card).getByTestId('attention-why')
    expect(driver.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(driver.textContent).toBe('Highest: Android App 941 ◆R · 4 of 8 products Red')
    await userEvent.setup().click(why)
    expect(onOpen).toHaveBeenCalledWith(why)
  })

  it('a missing exec summary reads Exec summary needed for admins and No exec summary yet for others', () => {
    const base = { periodLabel: 'Oct 2026', onOpen: vi.fn() }
    const { unmount } = renderCard({ meta: { ...META, summary: { ...base, display: { state: 'missing', canEdit: true } } } })
    expect(within(screen.getByTestId('attention-summary')).getByRole('button').textContent).toBe('Exec summary needed')
    unmount()
    renderCard({ meta: { ...META, summary: { ...base, display: { state: 'missing', canEdit: false } } } })
    const button = within(screen.getByTestId('attention-summary')).getByRole('button')
    expect(button.textContent).toBe('No exec summary yet')
    expect(button.getAttribute('aria-label')).toBe('Why is Weighted support backlog 681 in Oct 2026? No exec summary yet')
  })

  it('with no driver line, the summary line takes the card’s foot; phones hide it', () => {
    const summary = { display: { state: 'missing' as const, canEdit: true }, periodLabel: 'Oct 2026', onOpen: vi.fn() }
    const { unmount } = renderCard({ meta: { ...META, why: null, summary } })
    expect(screen.queryByTestId('attention-why')).toBeNull()
    expect(screen.getByTestId('attention-summary').className).toContain('border-t')
    unmount()
    renderCard({ meta: { ...META, summary }, compact: true })
    expect(screen.queryByTestId('attention-summary')).toBeNull()
  })

  it('a tier below Red gives its reason in the middle tone', () => {
    renderCard({ item: ranked({ tier: 2, status: 'Y', reason: 'Fell from Green' }) })
    expect(screen.getByText('Fell from Green').className).toContain('text-status-y')
  })

  it('compact (phones): no chart, a 6-cell ribbon, no eyebrow, threshold or why line', () => {
    renderCard({ compact: true })
    const card = screen.getByRole('article')
    expect(card.querySelector('svg')).toBeNull()
    expect(within(card).getByTestId('attention-ribbon').children).toHaveLength(6)
    expect(within(card).queryByText('Quality')).toBeNull()
    expect(within(card).queryByText(/^Lower is better/)).toBeNull()
    expect(within(card).queryByTestId('attention-why')).toBeNull()
    expect(within(card).getByRole('heading', { level: 3 }).className).toContain('text-sm')
  })

  it('remembers the link as the focus return target when it opens the metric', async () => {
    const { focusReturnRef } = await import('./focusTrigger')
    renderCard()
    const link = screen.getByRole('link')
    await userEvent.setup().click(link)
    expect(focusReturnRef.current).toBe(link)
  })

  it('item metrics: the worst item, the distribution, a mini board of the worst three, and how often it was Red', () => {
    const items: AttentionMeta['items'] = {
      worst: { name: 'Webhooks', display: '99.06%', status: 'R' },
      distribution: '18 of 24 Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported',
      rows: [
        { id: 'webhooks', name: 'Webhooks', display: '99.06%', cells: RED_FROM_JUL },
        { id: 'ingest', name: 'Analytics Ingest', display: '99.83%', cells: RED_FROM_JUL },
        { id: 'search', name: 'Search Indexer - Production Cluster A-1', display: '99.87%', cells: RED_FROM_JUL },
      ],
      why: 'Webhooks: Red in 4 of the last 12 months',
    }
    renderCard({
      item: ranked({ metricKey: 'uptime', name: 'Uptime', reason: '1 service Red' }),
      meta: { ...META, category: 'Engineering', items, trend: null, why: null, threshold: '' },
    })
    const card = screen.getByRole('article', { name: 'Uptime' })
    expect(within(card).getByText('1 service Red')).toBeTruthy()
    const value = within(card).getByTestId('attention-value')
    expect(value.textContent).toContain('Worst')
    expect(within(value).getByText('Webhooks')).toBeTruthy()
    expect(within(value).getByText('99.06%')).toBeTruthy()
    expect(within(card).getByText('18 of 24 Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported')).toBeTruthy()
    const board = within(card).getByTestId('attention-mini-board')
    expect(board.getAttribute('aria-hidden')).toBe('true')
    expect(board.querySelectorAll('[data-kind]')).toHaveLength(36)
    // One line that keeps the part siblings differ in; no native title.
    const names = [...board.querySelectorAll('[data-name]')]
    expect(names.map((n) => n.textContent)).toEqual(['Webhooks', 'Analytics Ingest', 'Search Indexer - Production Cluster A-1'])
    expect(names[2]!.lastElementChild!.textContent).toBe(' - Production Cluster A-1')
    expect(names[2]!.lastElementChild!.className).toContain('whitespace-pre')
    expect(board.querySelector('[title]')).toBeNull()
    expect(within(card).getByTestId('attention-why').textContent).toBe('Webhooks: Red in 4 of the last 12 months')
  })

  describe('mini board fits its card', () => {
    const LONG: AttentionMeta['items'] = {
      worst: { name: 'Search Indexer - Production Cluster A-1', display: '99.20%', status: 'R' },
      distribution: '8 of 21 Green · ◆ 1 Red · 12 not reported',
      rows: [
        { id: 'a1', name: 'Search Indexer - Production Cluster A-1', display: '99.20%', cells: RED_FROM_JUL },
        { id: 'eu', name: 'Payments Gateway - EU Region Primary', display: '99.85%', cells: RED_FROM_JUL },
        { id: 'web', name: 'Webhook Dispatcher - US Region Primary', display: '99.87%', cells: RED_FROM_JUL },
      ],
      why: 'Search Indexer - Production Cluster A-1: Red in 4 of the last 12 months',
    }
    const renderLong = () =>
      renderCard({
        item: ranked({ metricKey: 'uptime', name: 'Deployment uptime', reason: '1 deployment Red' }),
        meta: { ...META, items: LONG, trend: null, why: null, threshold: '' },
      })
    const px = (template: string) => template.split(' ').map((t) => Number(/^(\d+)px$/.exec(t)?.[1] ?? NaN))

    afterEach(() => {
      width.value = 0
    })

    it('a 458px board keeps a name column of at least 140px and halves to the last 6 months', () => {
      width.value = 458
      renderLong()
      const board = screen.getByTestId('attention-mini-board')
      expect(board.dataset.stacked).toBe('false')
      const rows = board.querySelectorAll('[data-mini-row]')
      expect(rows).toHaveLength(3)
      const cols = px((rows[0] as HTMLElement).style.gridTemplateColumns)
      expect(cols[0]).toBeGreaterThanOrEqual(140)
      expect(cols.reduce((a, b) => a + b, 0)).toBe(458)
      for (const r of rows) expect(r.querySelectorAll('[data-kind]')).toHaveLength(6)
    })

    it('a 240px board stacks: name and value on a line, 6 cells below, each wide enough for its letter', () => {
      width.value = 240
      renderLong()
      const board = screen.getByTestId('attention-mini-board')
      expect(board.dataset.stacked).toBe('true')
      for (const r of board.querySelectorAll('[data-mini-row]')) {
        const cells = r.querySelector('[data-cells]') as HTMLElement
        expect(cells.querySelectorAll('[data-kind]')).toHaveLength(6)
        const [cell] = px(cells.style.gridTemplateColumns.replace(/repeat\(\d+, (\d+px)\)/, '$1'))
        expect(cell).toBeGreaterThanOrEqual(18)
        expect(cells.textContent).toBe('YYRRRR')
      }
    })

    it('cells too narrow for a letter draw the shape only', () => {
      width.value = 12
      renderLong()
      const cells = screen.getByTestId('attention-mini-board').querySelector('[data-cells]')!
      expect(cells.textContent).toBe(chartTheme(SCALE, 'R').shape)
    })

    it('the Worst name is one line through ItemName, never broken inside a word', () => {
      width.value = 458
      renderLong()
      const value = screen.getByTestId('attention-value')
      const name = value.querySelector('[data-name]')!
      expect(name.textContent).toBe('Search Indexer - Production Cluster A-1')
      expect(name.lastElementChild!.textContent).toBe(' - Production Cluster A-1')
      expect(value.querySelector('.break-words')).toBeNull()
      // On a narrow card the name takes its own line under `Worst` rather than shrink below 16rem.
      expect(value.querySelector('[data-worst-name]')!.className).toContain('min-w-[min(100%,16rem)]')
    })
  })

  it('has no axe violations, full or compact', async () => {
    const { container, unmount } = renderCard()
    expect((await axe(container)).violations).toEqual([])
    unmount()
    const compact = renderCard({ compact: true })
    expect((await axe(compact.container)).violations).toEqual([])
  })
})

describe('NeedsAttention', () => {
  const entry = (item: RankedItem) => ({ item, meta: META, href: `?focus=${item.metricKey}` })
  const reds = ['a', 'b', 'c'].map((k) => entry(ranked({ metricKey: k, name: `Metric ${k}` })))

  function renderSection(shown: ReturnType<typeof entry>[], totals: { red: number; slipping: number; middle: number }, onShowAll = vi.fn()) {
    render(
      <MemoryRouter>
        <NeedsAttention shown={shown} totals={totals} worstLabel="Red" onShowAll={onShowAll} />
      </MemoryRouter>,
    )
    return onShowAll
  }

  it('all shown are Red: says how many of how many, with Show all', async () => {
    const onShowAll = renderSection(reds, { red: 5, slipping: 0, middle: 0 })
    const region = screen.getByRole('region', { name: 'Needs attention' })
    expect(within(region).getByRole('heading', { level: 2, name: 'Needs attention' })).toBeTruthy()
    expect(within(region).getByText('3 of 5 Red')).toBeTruthy()
    expect(within(region).getAllByRole('article')).toHaveLength(3)
    const showAll = within(region).getByRole('button', { name: 'Show all 5 Red' })
    // At least 24px tall (WCAG 2.5.8).
    expect(showAll.className).toContain('min-h-6')
    await userEvent.setup().click(showAll)
    expect(onShowAll).toHaveBeenCalled()
  })

  it('every Red shown: no Show all', () => {
    renderSection(reds, { red: 3, slipping: 0, middle: 0 })
    expect(screen.getByText('3 Red')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })

  it('mixed: what is shown by kind, and no Show all', () => {
    const shown = [
      entry(ranked({ metricKey: 'a' })),
      entry(ranked({ metricKey: 'b' })),
      entry(ranked({ metricKey: 'c', tier: 2, status: 'Y', label: 'Yellow', reason: 'Fell from Green' })),
    ]
    renderSection(shown, { red: 2, slipping: 1, middle: 4 })
    expect(screen.getByText('2 Red · 1 slipping')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })

  it('tier 3 is counted by its own label', () => {
    renderSection([entry(ranked({ metricKey: 'a' })), entry(ranked({ metricKey: 'w', tier: 3, status: 'Y', label: 'Yellow' }))], {
      red: 1,
      slipping: 0,
      middle: 1,
    })
    expect(screen.getByText('1 Red · 1 Yellow')).toBeTruthy()
  })
})
