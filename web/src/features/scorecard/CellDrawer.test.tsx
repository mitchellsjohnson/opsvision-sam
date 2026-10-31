import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { buildView, viewHandlers } from '../../test/viewFixtures'
import { CellDrawer, type DrawerTarget } from './CellDrawer'

type Row = components['schemas']['ViewRow']

function targetFor(metricKey: string, subjectId: string, period: string, ytd = false): DrawerTarget {
  const view = buildView(new URLSearchParams(ytd ? { ytd: period } : { periods: period }))
  const row = view.rows.find((r) => r.metricKey === metricKey && r.subjectId === subjectId) as Row
  const cell = row.cells[0] as components['schemas']['Cell']
  return {
    row,
    cell,
    columnLabel: ytd ? 'Year to date through Oct 2026' : period === '2026-M10' ? 'Oct 2026' : period,
    fiscalYearStartMonth: 1,
  }
}

function Harness({ target, onClose = () => {} }: { target: DrawerTarget; onClose?: () => void }) {
  const [t, setT] = useState<DrawerTarget | null>(target)
  return (
    <CellDrawer
      scorecardId="sc-main"
      target={t}
      onClose={() => {
        setT(null)
        onClose()
      }}
    />
  )
}

function open(target: DrawerTarget, onClose?: () => void) {
  server.use(...viewHandlers())
  renderApp(<Harness target={target} onClose={onClose} />)
}

describe('CellDrawer', () => {
  it('titles the dialog with metric, subject and period', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog', { name: 'On-time delivery · All units · Oct 2026' })
    expect(dialog).toBeTruthy()
  })

  it('shows components, coverage, target, change and the methodology version', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('440 / 522')).toBeTruthy()
    expect(within(dialog).getByText('3 / 3')).toBeTruthy()
    expect(within(dialog).getByText('90.0%')).toBeTruthy()
    expect(within(dialog).getByText('+2.1 pts vs Sep')).toBeTruthy()
    expect(await within(dialog).findByText('FY26 published')).toBeTruthy()
  })

  it('lists components as key: value when the formula is not a two-measure ratio', async () => {
    open(targetFor('defect_rate', 'root', '2026-M08'))
    const dialog = await screen.findByRole('dialog')
    const components = (await within(dialog).findByText('Components')).nextElementSibling as HTMLElement
    await waitFor(() => expect(components.textContent).toBe('Defects 4'))
  })

  it('words an improvement_pct change as better or worse', async () => {
    open(targetFor('defect_rate', 'root', '2026-M08'))
    expect(await screen.findByText('17% worse vs Jul')).toBeTruthy()
  })

  it('words a positive improvement_pct change as better', async () => {
    open(targetFor('defect_rate', 'root', '2026-M07'))
    expect(await screen.findByText('12% better vs Jun')).toBeTruthy()
  })

  it('shows revision history for each component, newest first', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog')
    const history = await within(dialog).findByRole('region', { name: /Revision history/ })
    await within(history).findAllByText(/pm@example.test/)
    const items = within(history).getAllByRole('listitem').map((li) => li.textContent ?? '')
    // closed: newest then oldest; then total: newest then oldest
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('440')
    expect(items[0]).toContain('pm@example.test')
    expect(items[0]).toContain('2026-10-03')
    expect(items[1]).toContain('435')
    expect(items[1]).toContain('analyst@example.test')
    expect(items[2]).toContain('522')
  })

  it('has no override form for non-admins', async () => {
    state.role = 'viewer'
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('440 / 522')
    expect(within(dialog).queryByRole('combobox', { name: /Status/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Save override' })).toBeNull()
  })

  it('lets an admin save an override', async () => {
    let body: unknown
    server.use(
      http.put(`${API}/v1/scorecards/sc-main/overrides`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ...(body as object), value: null, by: 'x', at: '2026-10-30T00:00:00Z' })
      }),
    )
    const onClose = vi.fn()
    open(targetFor('on_time_pct', 'root', '2026-M10'), onClose)
    const dialog = await screen.findByRole('dialog')
    const user = userEvent.setup()
    await user.selectOptions(await within(dialog).findByRole('combobox', { name: 'Status' }), 'G')
    await user.type(within(dialog).getByLabelText(/Reason/), 'Audited by finance')
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }))
    await waitFor(() =>
      expect(body).toEqual({
        metricKey: 'on_time_pct',
        subjectId: 'root',
        period: '2026-M10',
        status: 'G',
        reason: 'Audited by finance',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('offers the tenant status scale in the status select', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const select = await screen.findByRole('combobox', { name: 'Status' })
    const names = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Keep computed status', 'G – Green', 'Y – Yellow', 'R – Red'])
  })

  it('sends an override value as a number', async () => {
    let body: Record<string, unknown> | undefined
    server.use(
      http.put(`${API}/v1/scorecards/sc-main/overrides`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(body)
      }),
    )
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/^Value/), '91.5')
    await user.click(screen.getByRole('button', { name: 'Save override' }))
    await waitFor(() => expect(body?.value).toBe(91.5))
    expect(body).not.toHaveProperty('status')
  })

  it('asks for a status or a value before saving', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Save override' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Choose a status or enter a value')
  })

  it('shows API errors inline', async () => {
    server.use(
      http.put(`${API}/v1/scorecards/sc-main/overrides`, () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'admin role required to manage overrides' } },
          { status: 403 },
        ),
      ),
    )
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Status' }), 'R')
    await user.click(screen.getByRole('button', { name: 'Save override' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('admin role required to manage overrides')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('clears an override with DELETE and shows the override details', async () => {
    let url: URL | undefined
    server.use(
      http.delete(`${API}/v1/scorecards/sc-main/overrides`, ({ request }) => {
        url = new URL(request.url)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open(targetFor('defect_rate', 'root', '2026-M08'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Overridden by admin@example.test on 2026-10-05: Audit finding/)).toBeTruthy()
    await userEvent.setup().click(await within(dialog).findByRole('button', { name: 'Clear override' }))
    await waitFor(() => expect(url).toBeTruthy())
    expect(Object.fromEntries(url!.searchParams)).toEqual({
      metricKey: 'defect_rate',
      subjectId: 'root',
      period: '2026-M08',
    })
  })

  it('has no Clear override button when the cell is not overridden', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    await screen.findByRole('combobox', { name: 'Status' })
    expect(screen.queryByRole('button', { name: 'Clear override' })).toBeNull()
  })

  it('explains that year-to-date cells cannot be overridden', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10', true))
    const dialog = await screen.findByRole('dialog', { name: /Year to date through Oct 2026/ })
    expect(await within(dialog).findByText(/cannot be overridden/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Save override' })).toBeNull()
  })

  it('has no accessibility violations when open', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('FY26 published')
    await within(dialog).findAllByText(/pm@example.test/)
    expect((await axe(dialog)).violations).toEqual([])
  })
})
