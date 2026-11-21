import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { DEPLOYMENT_NOUN, DEPLOYMENT_SCALE, deploymentGroup, deploymentRows } from '../../test/deploymentFixtures'
import { buildMonthTrendColumns, buildTrendColumns } from './columns'
import { ItemDrillIn, type ItemDrillInProps } from './ItemDrillIn'
import { buildItemRows } from './logic/itemGrid'

const columns = buildMonthTrendColumns('2026-M10', 12, 1)
const rows = deploymentRows(columns)
const items = buildItemRows(rows, columns, DEPLOYMENT_SCALE, deploymentGroup, 1)
const item = (id: string) => items.find((r) => r.id === id)!

const WEST = { id: 'dep-identity-west', name: 'Identity Service - Staging Mirror West' }
const PORTAL = { id: 'dep-portal-cloud', name: 'Customer Portal - Private Cloud Tenant Suite' }

function draw(over: Partial<ItemDrillInProps> = {}) {
  const onStep = vi.fn<(id: string) => void>()
  const props: ItemDrillInProps = {
    head: rows[0]!,
    row: item('dep-notify-multi'),
    columns,
    scale: DEPLOYMENT_SCALE,
    noun: DEPLOYMENT_NOUN,
    total: 21,
    onBack: () => {},
    headingRef: createRef(),
    fy: 1,
    position: { index: 0, total: 13, next: WEST },
    onStep,
    ...over,
  }
  const utils = render(
    <MemoryRouter initialEntries={['/scorecards/sc-main/overview?focus=deployment_uptime&item=dep-notify-multi']}>
      <ItemDrillIn {...props} />
    </MemoryRouter>,
  )
  return { ...utils, onStep }
}

describe('ItemDrillIn value row', () => {
  it('quarter view: a stopped item names the year of a repeated quarter', () => {
    const q = buildTrendColumns('2026-Q3', 1)
    const quarterRows = deploymentRows(columns).map((r) => ({
      ...r,
      frequency: 'quarterly' as const,
      cells: q.map((c, i) => ({ ...r.cells[0]!, period: c.period, value: i === 3 ? 99.98 : null, display: i === 3 ? '99.98%' : '', status: i === 3 ? 'G' : '' })),
    }))
    const partner = buildItemRows(quarterRows, q, DEPLOYMENT_SCALE, deploymentGroup, 1).find((r) => r.id === 'dep-partner-sandbox')!
    draw({ head: quarterRows[0]!, row: partner, columns: q, position: { index: null, total: 0 } })
    expect(screen.getByTestId('drill-value-row').textContent).toContain('Last Q3 FY2025 · 99.98%')
  })
})

describe('ItemDrillIn Why', () => {
  const RULE = {
    type: 'bands' as const,
    bands: [
      { status: 'G', op: '>=', value: 99.9 },
      { status: 'Y', op: '>', value: 99.8 },
      { status: 'R', op: '', value: 0 },
    ],
  }
  const rcaRows = rows.map((r) => ({ ...r, rcaIdeal: 100, cells: r.cells.map((c) => ({ ...c, rule: RULE })) }))
  const rcaItems = buildItemRows(rcaRows, columns, DEPLOYMENT_SCALE, deploymentGroup, 1)

  it('the value row has Why? for the item’s cell, after since when', async () => {
    const onWhy = vi.fn()
    draw({ row: rcaItems.find((r) => r.id === 'dep-notify-multi')!, onWhy })
    const valueRow = screen.getByTestId('drill-value-row')
    const why = within(valueRow).getByRole('button', { name: 'Why is 99.63% in Oct 2026?' })
    expect(why.textContent).toBe('Why?')
    expect(valueRow.lastElementChild).toBe(why)
    await userEvent.setup().click(why)
    expect(onWhy).toHaveBeenCalledWith(why)
  })

  it('a perfect item has no Why?', () => {
    draw({ row: rcaItems.find((r) => r.id === 'dep-pay-eu')!, onWhy: vi.fn() })
    expect(within(screen.getByTestId('drill-value-row')).queryByRole('button')).toBeNull()
  })
})

describe('ItemDrillIn stepper', () => {
  it('names the neighbours, shows the position and steps on press', async () => {
    const { onStep } = draw({ row: item(WEST.id), position: { index: 1, total: 13, prev: { id: 'dep-notify-multi', name: 'Notification Relay - Multi-Region Active' }, next: PORTAL } })
    const stepper = screen.getByRole('group', { name: 'Step through deployments' })
    const prev = within(stepper).getByRole('button', { name: 'Previous deployment: Notification Relay - Multi-Region Active' })
    const next = within(stepper).getByRole('button', { name: `Next deployment: ${PORTAL.name}` })
    expect(prev.getAttribute('aria-keyshortcuts')).toBe('K')
    expect(next.getAttribute('aria-keyshortcuts')).toBe('J')
    expect(next.className).toContain('size-8')
    expect(within(stepper).getByText('2 of 13').className).toContain('tabular-nums')
    const user = userEvent.setup()
    await user.click(next)
    expect(onStep).toHaveBeenLastCalledWith(PORTAL.id)
    await user.click(prev)
    expect(onStep).toHaveBeenLastCalledWith('dep-notify-multi')
  })

  it('at the first item, Previous is disabled; there is no wrap-around', async () => {
    const { onStep } = draw()
    const prev = screen.getByRole('button', { name: 'Previous deployment' })
    expect((prev as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('1 of 13')).toBeTruthy()
    await userEvent.setup().click(prev)
    expect(onStep).not.toHaveBeenCalled()
  })

  it('at the last item, Next is disabled', () => {
    draw({ position: { index: 12, total: 13, prev: WEST } })
    expect((screen.getByRole('button', { name: 'Next deployment' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('13 of 13')).toBeTruthy()
  })

  it('an item not in the order reads a dash; Previous is disabled and Next goes to the first item', async () => {
    const { onStep } = draw({ row: item('dep-edge-cache'), position: { index: null, total: 13, next: { id: 'dep-notify-multi', name: 'Notification Relay - Multi-Region Active' } } })
    const dash = screen.getByText('–')
    expect(dash.getAttribute('aria-hidden')).toBe('true')
    const note = within(dash.parentElement!).getByText('not in the current list')
    expect(note.className).toContain('sr-only')
    expect((screen.getByRole('button', { name: 'Previous deployment' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next deployment: Notification Relay - Multi-Region Active' }))
    expect(onStep).toHaveBeenCalledWith('dep-notify-multi')
  })

  it('pressing Next onto the last item moves focus to Previous instead of losing it', async () => {
    const onStep = vi.fn()
    const base: ItemDrillInProps = {
      head: rows[0]!,
      row: item(WEST.id),
      columns,
      scale: DEPLOYMENT_SCALE,
      noun: DEPLOYMENT_NOUN,
      total: 21,
      onBack: () => {},
      headingRef: createRef(),
      fy: 1,
      position: { index: 11, total: 13, prev: PORTAL, next: { id: 'dep-renderer', name: 'Document Renderer - Shared Worker Pool' } },
      onStep,
    }
    const { rerender } = render(
      <MemoryRouter>
        <ItemDrillIn {...base} />
      </MemoryRouter>,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /^Next deployment/ }))
    rerender(
      <MemoryRouter>
        <ItemDrillIn {...base} row={item('dep-renderer')} position={{ index: 12, total: 13, prev: WEST }} />
      </MemoryRouter>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Previous deployment: ${WEST.name}` }))
  })

  it('J pressed on Next onto the last item moves focus to Previous, as a click does', async () => {
    const base: ItemDrillInProps = {
      head: rows[0]!,
      row: item(WEST.id),
      columns,
      scale: DEPLOYMENT_SCALE,
      noun: DEPLOYMENT_NOUN,
      total: 21,
      onBack: () => {},
      headingRef: createRef(),
      fy: 1,
      position: { index: 11, total: 13, prev: PORTAL, next: { id: 'dep-renderer', name: 'Document Renderer - Shared Worker Pool' } },
      onStep: vi.fn(),
    }
    const { rerender } = render(
      <MemoryRouter>
        <ItemDrillIn {...base} />
      </MemoryRouter>,
    )
    const user = userEvent.setup()
    screen.getByRole('button', { name: /^Next deployment/ }).focus()
    // The dialog's shortcut handler does the step; the drill-in only sees the key and the new item.
    await user.keyboard('j')
    rerender(
      <MemoryRouter>
        <ItemDrillIn {...base} row={item('dep-renderer')} position={{ index: 12, total: 13, prev: WEST }} />
      </MemoryRouter>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Previous deployment: ${WEST.name}` }))
  })

  it('K pressed on Previous onto the first item moves focus to Next', async () => {
    const base: ItemDrillInProps = {
      head: rows[0]!,
      row: item(WEST.id),
      columns,
      scale: DEPLOYMENT_SCALE,
      noun: DEPLOYMENT_NOUN,
      total: 21,
      onBack: () => {},
      headingRef: createRef(),
      fy: 1,
      position: { index: 1, total: 13, prev: { id: 'dep-notify-multi', name: 'Notification Relay - Multi-Region Active' }, next: PORTAL },
      onStep: vi.fn(),
    }
    const { rerender } = render(
      <MemoryRouter>
        <ItemDrillIn {...base} />
      </MemoryRouter>,
    )
    const user = userEvent.setup()
    screen.getByRole('button', { name: /^Previous deployment/ }).focus()
    await user.keyboard('k')
    rerender(
      <MemoryRouter>
        <ItemDrillIn {...base} row={item('dep-notify-multi')} position={{ index: 0, total: 13, next: WEST }} />
      </MemoryRouter>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Next deployment: ${WEST.name}` }))
  })

  it('the stepper sits at the end of the breadcrumb row; on phones the details share its line', () => {
    draw()
    const row = screen.getByTestId('drill-crumbs')
    const nav = within(row).getByRole('navigation', { name: 'Breadcrumb' })
    expect(nav.className).toContain('max-sm:basis-full')
    const stepper = within(row).getByRole('group', { name: 'Step through deployments' })
    expect(stepper.className).toContain('ml-auto')
    expect(within(row).getByTestId('drill-details').textContent).toBe('Platform')
    expect(nav.contains(within(row).getByTestId('drill-details'))).toBe(false)
  })

  it('has no axe violations', async () => {
    const { container } = draw()
    expect((await axe(container)).violations).toEqual([])
  })
})
