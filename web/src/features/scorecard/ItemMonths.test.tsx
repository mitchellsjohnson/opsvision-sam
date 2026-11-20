import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { DEPLOYMENT_SCALE, deploymentRows } from '../../test/deploymentFixtures'
import { buildMonthTrendColumns } from './columns'
import { ItemMonths } from './ItemMonths'

const columns = buildMonthTrendColumns('2026-M10', 12, 1)

function rowOf(id: string) {
  const row = deploymentRows(columns).find((r) => r.subjectId === id)!
  if (id === 'dep-notify-multi') {
    // As in the demo: 99.99% in September, so October fell 0.36 points.
    Object.assign(row.cells.find((c) => c.period === '2026-M09')!, { value: 99.99, display: '99.99%', status: 'G' })
  }
  return row
}

/** A table row's cells as text, ` · ` between, leaving out the status chips beside their labels. */
function rowText(row: HTMLElement): string {
  return [...row.children]
    .map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement
      for (const chip of copy.querySelectorAll('[data-role="status-chip"]')) chip.remove()
      return copy.textContent
    })
    .join(' · ')
}

function draw(id: string) {
  return render(<ItemMonths row={rowOf(id)} columns={columns} scale={DEPLOYMENT_SCALE} format="percent2" valueLabel="Uptime" />)
}

describe('ItemMonths', () => {
  it('is collapsed by default: a Monthly values button and no table', () => {
    draw('dep-notify-multi')
    const button = screen.getByRole('button', { name: 'Monthly values' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-controls')).toBeNull()
    expect(button.className).toContain('h-8')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('open: every shown month, newest first, with value, status in words and the change', async () => {
    draw('dep-notify-multi')
    const button = screen.getByRole('button', { name: 'Monthly values' })
    await userEvent.setup().click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const table = screen.getByRole('table', { name: 'Monthly values' })
    expect(button.getAttribute('aria-controls')).toBe(table.id)
    expect(table.className).toContain('max-w-[640px]')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Month', 'Uptime', 'Status', 'Change'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(12)
    expect(rowText(rows[0]!)).toBe('Oct 2026 · 99.63% · Red · ▼ −0.36 pts')
    expect(rowText(rows[1]!)).toBe('Sep 2026 · 99.99% · Green · ▼ −0.01 pts')
    // Equal values: no arrow, zero points.
    expect(rowText(rows[2]!)).toBe('Aug 2026 · 100.00% · Green · 0.00 pts')
    expect(rowText(rows.at(-1)!)).toMatch(/^Nov 2025 · /)
    // A fall in uptime is bad; the chip carries the status as well as the word.
    expect(rows[0]!.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('bad')
    expect(rows[0]!.querySelector('[data-role="status-chip"]')).toBeTruthy()
    // Phones keep the columns inside the card: the unit is left to the screen reader there.
    expect(rows[0]!.querySelector('[data-tone] span')!.className).toContain('max-sm:sr-only')
  })

  it('a missing prior month or value reads a dash', async () => {
    draw('dep-identity-west')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Monthly values' }))
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    // First reported in Aug: Aug has nothing to compare with; Jul has no value.
    expect(rowText(rows[2]!)).toBe('Aug 2026 · 100.00% · Green · —')
    expect(rowText(rows[3]!)).toBe('Jul 2026 · — · No data · —')
  })

  it('controlled: the open state comes from the caller', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <span>{open ? 'open' : 'shut'}</span>
          <ItemMonths row={rowOf('dep-notify-multi')} columns={columns} scale={DEPLOYMENT_SCALE} format="percent2" valueLabel="Uptime" open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Harness />)
    expect(screen.getByRole('table')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Monthly values' }))
    expect(screen.getByText('shut')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('has no axe violations, open or shut', async () => {
    const { container } = draw('dep-notify-multi')
    expect((await axe(container)).violations).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Monthly values' }))
    expect((await axe(container)).violations).toEqual([])
  })
})
