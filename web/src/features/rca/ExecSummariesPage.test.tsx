import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import type { MetricSummary } from '../../api/queries'
import { uptimeSummary } from '../../test/rcaFixtures'
import {
  defectOptional,
  onTimeMissing,
  spendStale,
  summaryListHandler,
  trainingMissing,
  uptimeMissing,
} from '../../test/reportFixtures'
import { API, companyUnitsHandler, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { reminderText } from './summaryReminder'

// All data is synthetic.

const ROUTE = '/scorecards/sc-main/exec-summaries?period=2026-M10'
const uptime: MetricSummary = { ...uptimeSummary, categoryId: 'delivery' }
const ROWS: MetricSummary[] = [onTimeMissing, uptimeMissing, trainingMissing, spendStale, uptime, defectOptional]

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}
const location = () => screen.getByTestId('location').textContent ?? ''

function renderPage(route = ROUTE, rows: MetricSummary[] = ROWS) {
  server.use(...viewHandlers(), companyUnitsHandler, summaryListHandler('sc-main', { summaries: rows }))
  return renderApp(
    <>
      <App />
      <Probe />
    </>,
    { route },
  )
}

const table = () => screen.findByRole('table', { name: /Exec summaries/ })
const rowOf = (name: string) => screen.getByRole('rowheader', { name }).closest('tr')!

describe('ExecSummariesPage', () => {
  it('heads the page and shows the needed summaries by default, with state toggles counting each', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Exec summaries', level: 1 })).toBeTruthy()
    expect(screen.getByText('Oct 2026 · one per metric that is not at 100% · required to publish')).toBeTruthy()
    const toggles = await screen.findByRole('group', { name: 'Show exec summaries by state' })
    await waitFor(() =>
      expect(within(toggles).getAllByRole('button').map((b) => b.textContent)).toEqual(['3 Needed', '1 To review', '1 Written', '6 All']),
    )
    expect(within(toggles).getByRole('button', { name: '3 Needed' }).getAttribute('aria-pressed')).toBe('true')
    const t = await table()
    expect(within(t).getAllByRole('rowheader').filter((h) => h.getAttribute('scope') === 'row').map((h) => h.textContent)).toEqual([
      'On-time delivery',
      'Service uptime',
      'Security training completion',
    ])
  })

  it('groups rows by category with the columns of spec §10.5', async () => {
    renderPage()
    const t = await table()
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Metric',
      'This month',
      "Why it's required",
      'Attribution',
      'Exec summary',
      'Action',
    ])
    const groups = [...t.querySelectorAll('th[scope="rowgroup"]')].map((th) => th.textContent)
    expect(groups).toEqual(['Delivery · 2', 'Quality · 1'])
    const svc = rowOf('Service uptime')
    const cells = [...svc.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[0]).toBe('99.20%◆RRedworst Web service')
    expect(cells[1]).toBe('1 of 2 services below 100%')
    expect(cells[2]).toBe('Nothing linked')
    expect(cells[3]).toBe('Exec summary needed')
    expect(within(svc).getByRole('button', { name: 'Write exec summary for Service uptime' })).toBeTruthy()
    expect([...rowOf('On-time delivery').querySelectorAll('td')][2]!.textContent).toBe(
      '15.7 pts short of 100% · 6 of 38 items missed · DEL-101, DEL-104',
    )
    expect([...rowOf('Security training completion').querySelectorAll('td')][2]!.textContent).toBe('6 pts short of 100% · Nothing linked')
  })

  it('toggles by state, kept in the URL, and names optional rows as not required', async () => {
    renderPage()
    const toggles = await screen.findByRole('group', { name: 'Show exec summaries by state' })
    const user = userEvent.setup()
    await user.click(await within(toggles).findByRole('button', { name: '1 To review' }))
    await waitFor(() => expect(location()).toBe(`${ROUTE}&state=stale`))
    expect(within(toggles).getByRole('button', { name: '1 To review' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(toggles).getByRole('button', { name: '3 Needed' }).getAttribute('aria-pressed')).toBe('false')
    const spend = await screen.findByRole('rowheader', { name: 'Spend vs plan' })
    const row = spend.closest('tr')!
    expect(row.textContent).toContain('Vendor renewals landed a month early.')
    expect(row.textContent).toContain('Avery Admin · Oct 30')
    expect(within(row).getByRole('button', { name: 'Review exec summary for Spend vs plan' })).toBeTruthy()

    await user.click(within(toggles).getByRole('button', { name: '6 All' }))
    await waitFor(() => expect(location()).toBe(`${ROUTE}&state=all`))
    const defect = (await screen.findByRole('rowheader', { name: 'Defect rate' })).closest('tr')!
    expect([...defect.querySelectorAll('td')][1]!.textContent).toBe('Not required (100%)')
    const written = rowOf('Uptime')
    expect(written.textContent).toContain('Avery Admin · Nov 2')
    expect(written.textContent).toContain('12 links')
    expect(within(written).getByRole('button', { name: 'Edit exec summary for Uptime' })).toBeTruthy()

    await user.click(within(toggles).getByRole('button', { name: '3 Needed' }))
    await waitFor(() => expect(location()).toBe(ROUTE))
  })

  it('offers contributors and viewers Open, never Write', async () => {
    for (const role of ['contributor', 'viewer'] as const) {
      state.role = role
      const { unmount } = renderPage(`${ROUTE}&state=all`)
      await table()
      expect(screen.getByRole('button', { name: 'Open exec summary for Service uptime' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^(Write|Review|Edit) / })).toBeNull()
      expect(rowOf('Service uptime').textContent).toContain('No exec summary yet')
      unmount()
    }
  })

  it('filters by metric name', async () => {
    renderPage(`${ROUTE}&state=all`)
    await table()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: 'Filter 6 metrics' }), 'uptime')
    expect(screen.getAllByRole('rowheader').filter((h) => h.getAttribute('scope') === 'row').map((h) => h.textContent)).toEqual([
      'Service uptime',
      'Uptime',
    ])
  })

  it('copies a plain-text reminder of what is needed, with a link to this view', async () => {
    renderPage()
    await table()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Copy reminder' }))
    expect(await screen.findByText('Reminder copied')).toBeTruthy()
    const url = `${window.location.origin}/scorecards/sc-main/exec-summaries?period=2026-M10`
    expect(await navigator.clipboard.readText()).toBe(reminderText([onTimeMissing, uptimeMissing, trainingMissing], url, 'Oct 2026'))
  })

  it('Edit opens the company card; after a save the row updates in place, focus stays and the save is announced', async () => {
    renderPage(`${ROUTE}&state=written`)
    await table()
    const user = userEvent.setup()
    const edit = screen.getByRole('button', { name: 'Edit exec summary for Uptime' })
    await user.click(edit)
    const dialog = await screen.findByRole('dialog', { name: 'Acme Demo · Uptime' })
    await user.click(await within(dialog).findByRole('button', { name: 'Edit exec summary' }))
    const box = await within(dialog).findByRole('textbox', { name: 'Exec summary for Uptime, Oct 2026' })
    fireEvent.change(box, { target: { value: 'Webhooks lost 7h to one deploy (INC-2041).' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Exec summary saved for Uptime')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The row stays even though the list was refetched, and shows what was saved.
    await waitFor(() => expect(rowOf('Uptime').textContent).toContain('Webhooks lost 7h to one deploy (INC-2041).'))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit exec summary for Uptime' }))
  })

  it('Write on a needed summary keeps the row after it is written, under Needed', async () => {
    renderPage()
    await table()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Write exec summary for Security training completion' }))
    const dialog = await screen.findByRole('dialog', { name: 'Acme Demo · Security training completion' })
    await user.click(await within(dialog).findByRole('button', { name: 'Write exec summary' }))
    const box = await within(dialog).findByRole('textbox', { name: 'Exec summary for Security training completion, Oct 2026' })
    fireEvent.change(box, { target: { value: 'Two teams finished after the deadline.' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Exec summary saved for Security training completion')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const row = rowOf('Security training completion')
    expect(row.textContent).toContain('Two teams finished after the deadline.')
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Edit exec summary for Security training completion' }))
  })

  it('announces a save once, in one live region', async () => {
    renderPage()
    await table()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Write exec summary for Security training completion' }))
    const dialog = await screen.findByRole('dialog', { name: 'Acme Demo · Security training completion' })
    await user.click(await within(dialog).findByRole('button', { name: 'Write exec summary' }))
    const box = await within(dialog).findByRole('textbox', { name: 'Exec summary for Security training completion, Oct 2026' })
    fireEvent.change(box, { target: { value: 'Two teams finished after the deadline.' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await screen.findByText('Exec summary saved for Security training completion')
    const saying = screen.getAllByRole('status', { hidden: true }).filter((s) => /saved/.test(s.textContent ?? ''))
    expect(saying.map((s) => s.textContent)).toEqual(['Exec summary saved for Security training completion'])
  })

  it('shows a coarse metric’s counted period, required in the month that closed it, as needed for that month', async () => {
    const a11y: MetricSummary = {
      ...defectOptional,
      metricKey: 'a11y_pct',
      metricName: 'Accessibility compliance',
      period: '2026-H1',
      standing: { display: '82%', status: 'G', headline: '18 pts short of 100%' },
    }
    renderPage(`${ROUTE}&state=all`, [...ROWS, a11y])
    await table()
    const cells = [...rowOf('Accessibility compliance').querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[1]).toBe('Required for Jun 2026')
    expect(cells[3]).toBe('Needed for Jun 2026')
    expect(screen.queryAllByText('Not required (100%)')).toHaveLength(1)
  })

  it('Copy reminder is unavailable with nothing needed, and says so when the clipboard refuses', async () => {
    const { unmount } = renderPage(ROUTE, [uptime, defectOptional])
    await screen.findByText(/Every exec summary for Oct 2026 is written/)
    expect((screen.getByRole('button', { name: 'Copy reminder' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()

    renderPage()
    await table()
    const user = userEvent.setup()
    const refuse = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await user.click(screen.getByRole('button', { name: 'Copy reminder' }))
    expect(await screen.findByText('Couldn’t copy the reminder: the browser did not allow it.')).toBeTruthy()
    expect(screen.queryByText('Reminder copied')).toBeNull()
    refuse.mockRestore()
  })

  it('Write explains itself when the organization has no single top-level unit', async () => {
    server.use(
      ...viewHandlers(),
      summaryListHandler('sc-main', { summaries: ROWS }),
      http.get(`${API}/v1/org/units`, () =>
        HttpResponse.json({
          units: [
            { id: 'a', name: 'Unit A', levelId: 'l1', parentId: '', sourceKeys: [] },
            { id: 'b', name: 'Unit B', levelId: 'l1', parentId: '', sourceKeys: [] },
          ],
        }),
      ),
    )
    renderApp(<App />, { route: ROUTE })
    await table()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Write exec summary for Service uptime' }))
    expect((await screen.findByRole('alert')).textContent).toBe('No exec summary can be written: the organization has no single top-level unit.')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the card named by ?why= on load', async () => {
    renderPage(`${ROUTE}&why=security_training`)
    expect(await screen.findByRole('dialog', { name: 'Acme Demo · Security training completion' })).toBeTruthy()
  })

  it('says when every summary is written, with the way to the Report', async () => {
    renderPage(ROUTE, [uptime, defectOptional])
    expect(await screen.findByText('Every exec summary for Oct 2026 is written. The month can be published.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to the Report ›' }).getAttribute('href')).toBe('/scorecards/sc-main/report?period=2026-M10')
    expect(screen.queryByRole('table', { name: /Exec summaries/ })).toBeNull()
  })

  it('says when nothing is required this month', async () => {
    renderPage(ROUTE, [defectOptional])
    expect(await screen.findByText('Every metric is at 100% this month; no exec summary is required.')).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { container } = renderPage(`${ROUTE}&state=all`)
    await table()
    expect((await axe(container)).violations).toEqual([])
  })

  describe('on a phone', () => {
    const original = window.matchMedia
    beforeEach(() => {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia
    })
    afterEach(() => {
      window.matchMedia = original
    })

    it('lists one card per metric with a full-width action', async () => {
      const { container } = renderPage()
      const list = await screen.findByRole('list', { name: 'Exec summaries needed for Oct 2026' })
      const items = within(list).getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items[1]!.textContent).toContain('Service uptime')
      const write = within(items[1]!).getByRole('button', { name: 'Write exec summary for Service uptime' })
      expect(write.className).toContain('w-full')
      expect(write.className).toContain('h-10')
      expect(screen.queryByRole('table', { name: /Exec summaries/ })).toBeNull()
      expect((await axe(container)).violations).toEqual([])
    })
  })
})
