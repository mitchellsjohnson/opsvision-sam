import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { buildView, viewHandlers } from '../../test/viewFixtures'
import { LEGACY_OVERRIDE_REASON } from './columns'
import { TablePage } from './TablePage'

type Cell = components['schemas']['Cell']

function renderTable(route = '/scorecards/sc-main?period=2026-M10', props: { compact?: boolean } = {}) {
  server.use(...viewHandlers())
  renderApp(
    <TablePage scorecardId="sc-main" scorecardName="Main scorecard" {...props} />,
    { route },
  )
}

function periodHeaders(): string[] {
  const grid = screen.getByRole('grid')
  return within(grid)
    .getAllByRole('columnheader')
    .map((h) => (h.textContent ?? '').trim())
    .filter((t) => t !== '' && !t.startsWith('Metric'))
}

function gridCell(metric: string, subject: string, columnLabel: string): HTMLElement {
  const row = screen.getByRole('row', { name: new RegExp(`${metric}.*${subject}`, 'i') })
  const headers = periodHeaders()
  const idx = headers.findIndex((h) => h.startsWith(columnLabel))
  expect(idx).toBeGreaterThanOrEqual(0)
  const cells = within(row).getAllByRole('gridcell')
  return cells[idx] as HTMLElement
}

describe('TablePage', () => {
  it('at content width 960 shows six period headers and no horizontal scroll container', async () => {
    renderTable()
    await screen.findByRole('grid')
    expect(periodHeaders()).toHaveLength(6)
    expect(periodHeaders()).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    const grid = screen.getByRole('grid')
    expect(grid.className).not.toMatch(/overflow-x-auto/)
    expect(grid.closest('[class*="overflow-x-auto"]')).toBeNull()
    expect(grid.className).toMatch(/table-fixed/)
  })

  it('disables Later on the last month in the range', async () => {
    renderTable()
    await screen.findByRole('grid')
    const later = screen.getByRole('button', { name: 'Later' })
    expect(later).toHaveProperty('disabled', true)
  })

  it('exposes the not-applicable reason as the accessible name of the n/a chip', async () => {
    renderTable()
    await screen.findByRole('grid')
    const cell = gridCell('Defect rate', 'All units', 'Oct')
    const na = within(cell).getByRole('img', { name: 'Not measured this month' })
    expect(na.textContent).toMatch(/n\/a/i)
  })

  it('opens the drawer when Enter is pressed on a focused cell', async () => {
    renderTable()
    await screen.findByRole('grid')
    const user = userEvent.setup()
    const cell = gridCell('On-time delivery', 'All units', 'Oct')
    const button = within(cell).getByRole('button')
    button.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: /On-time delivery.*All units.*Oct 2026/ })).toBeTruthy()
  })

  it('groups twelve identical legacy override reasons into one note', async () => {
    server.use(
      ...viewHandlers({
        respond: (url) => {
          const view = buildView(url.searchParams)
          let count = 0
          for (const row of view.rows) {
            for (const cell of row.cells) {
              if (count >= 12) break
              if (cell.ytd) continue
              const override = {
                metricKey: row.metricKey,
                subjectId: row.subjectId,
                period: cell.period,
                value: null,
                status: 'G',
                reason: LEGACY_OVERRIDE_REASON,
                by: 'admin@example.test',
                at: '2026-10-05T12:00:00Z',
              }
              Object.assign(cell as Cell, {
                value: 1,
                display: '1.0',
                status: 'G',
                override,
              })
              count += 1
            }
          }
          return HttpResponse.json(view)
        },
      }),
    )
    renderApp(<TablePage scorecardId="sc-main" scorecardName="Main scorecard" />, {
      route: '/scorecards/sc-main?period=2026-M10',
    })
    await screen.findByRole('grid')
    expect(screen.getByText('12 values as reported in the legacy workbook')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'show cells' })).toBeTruthy()
  })

  describe('compact', () => {
    it('renders metric cards with six status letters instead of the grid', async () => {
      renderTable('/scorecards/sc-main?period=2026-M10', { compact: true })
      await screen.findByRole('article', { name: /On-time delivery/ })
      expect(screen.queryByRole('grid')).toBeNull()
      const card = screen.getByRole('article', { name: /On-time delivery/ })
      const letters = within(card)
        .getAllByRole('img')
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
      expect(letters).toHaveLength(6)
    })
  })
})
