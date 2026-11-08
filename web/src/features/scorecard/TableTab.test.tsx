import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { contributionHandlers, contributionMeasure, viewHandlers } from '../../test/viewFixtures'
import { TableTab } from './TableTab'

function LocationProbe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

function renderTable(route = '/scorecards/sc-main?period=2026-M10') {
  const urls: URL[] = []
  server.use(...viewHandlers({ onView: (u) => urls.push(u) }))
  renderApp(
    <>
      <TableTab scorecardId="sc-main" scorecardName="Main scorecard" />
      <LocationProbe />
    </>,
    { route },
  )
  return { urls }
}

function headers() {
  return screen.getAllByRole('columnheader').map((h) => h.textContent ?? '')
}

/** The cell for a row header (by name) and a column header (by text). */
function cellAt(metric: string, subject: string, column: string): HTMLTableCellElement {
  const rowHeader = screen.getByRole('rowheader', { name: new RegExp(`${metric}.*${subject}`) })
  const row = rowHeader.closest('tr') as HTMLTableRowElement
  const cols = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '')
  const idx = cols.findIndex((t) => t.startsWith(column))
  expect(idx).toBeGreaterThan(0)
  return row.cells[idx] as HTMLTableCellElement
}

const location = () => screen.getByTestId('location').textContent ?? ''

describe('TableTab', () => {
  it('renders category groups, a caption, and status letters', async () => {
    renderTable()
    await screen.findByRole('table')
    expect(screen.getByRole('table', { name: /Main scorecard.*Nov 2025.*Oct 2026/ })).toBeTruthy()
    expect(screen.getByText(/^Main scorecard, Nov 2025 to Oct 2026$/)).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Delivery' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Quality' })).toBeTruthy()

    const yellow = cellAt('On-time delivery', 'All units', 'Oct')
    expect(yellow.textContent).toContain('84.3%')
    expect(within(yellow).getByRole('img', { name: 'Status: Yellow' }).textContent).toBe('Y')
    const green = cellAt('On-time delivery', 'All units', 'Sep')
    expect(within(green).getByRole('img', { name: 'Status: Green' }).textContent).toBe('G')
  })

  it('uses a semantic, scrollable, labelled table region', async () => {
    renderTable()
    const table = await screen.findByRole('table')
    const region = screen.getByRole('region', { name: /Main scorecard/ })
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(region.contains(table)).toBe(true)
    for (const th of within(table).getAllByRole('columnheader')) {
      expect(th.getAttribute('scope')).toBe('col')
    }
    expect(screen.getByRole('rowheader', { name: /On-time delivery.*All units/ }).getAttribute('scope')).toBe('row')
  })

  describe('columns', () => {
    it('month: 12 fiscal months ending at the selected month, no YTD without ytd=1', async () => {
      const { urls } = renderTable()
      await screen.findByRole('table')
      expect(headers().slice(1)).toEqual([
        'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
      ])
      const q = urls[0]!.searchParams
      expect(q.getAll('periods')).toHaveLength(12)
      expect(q.getAll('periods')[11]).toBe('2026-M10')
      expect(q.getAll('ytd')).toEqual([])
    })

    it('month with ytd=1 adds a YTD column through the selected month', async () => {
      const { urls } = renderTable('/scorecards/sc-main?period=2026-M10&ytd=1')
      await screen.findByRole('table')
      const h = headers()
      expect(h).toHaveLength(14)
      expect(h[13]).toMatch(/^YTD/)
      expect(screen.getByText(/with year to date through Oct 2026$/)).toBeTruthy()
      expect(urls[0]!.searchParams.getAll('ytd')).toEqual(['2026-M10'])
      expect(cellAt('On-time delivery', 'All units', 'YTD').textContent).toContain('95.0%')
    })

    it('quarter: the fiscal quarters up to the selected one, plus YTD', async () => {
      const { urls } = renderTable('/scorecards/sc-main?period=2026-Q3&ytd=1')
      await screen.findByRole('table')
      expect(headers().slice(1).map((t) => t.slice(0, 2))).toEqual(['Q1', 'Q2', 'Q3', 'YT'])
      expect(urls[0]!.searchParams.getAll('periods')).toEqual(['2026-Q1', '2026-Q2', '2026-Q3'])
      expect(urls[0]!.searchParams.getAll('ytd')).toEqual(['2026-M09'])
    })

    it('half: halves up to the selected one', async () => {
      const { urls } = renderTable('/scorecards/sc-main?period=2026-H2')
      await screen.findByRole('table')
      expect(headers().slice(1)).toEqual(['H1', 'H2'])
      expect(urls[0]!.searchParams.getAll('periods')).toEqual(['2026-H1', '2026-H2'])
    })

    it('year: three fiscal years and never YTD', async () => {
      const { urls } = renderTable('/scorecards/sc-main?period=2026-FY&ytd=1')
      await screen.findByRole('table')
      expect(headers().slice(1)).toEqual(['FY2024', 'FY2025', 'FY2026'])
      expect(urls[0]!.searchParams.getAll('ytd')).toEqual([])
    })

    it('does not query until the default period is known', async () => {
      const { urls } = renderTable('/scorecards/sc-main')
      await screen.findByRole('table')
      expect(urls.length).toBeGreaterThan(0)
      for (const u of urls) expect(u.searchParams.getAll('periods').length).toBeGreaterThan(0)
    })
  })

  describe('cells', () => {
    it('shows an NA reason in muted text with no status badge', async () => {
      renderTable()
      await screen.findByRole('table')
      const cell = cellAt('Defect rate', 'All units', 'Oct')
      expect(within(cell).getByText('Not measured this month')).toBeTruthy()
      expect(within(cell).queryByRole('img')).toBeNull()
      expect(cell.className).not.toMatch(/status-/)
    })

    it('shows an em dash labelled "No data" for a missing cell', async () => {
      renderTable()
      await screen.findByRole('table')
      const cell = cellAt('Defect rate', 'All units', 'Sep')
      const dash = within(cell).getByRole('img', { name: 'No data' })
      expect(dash.textContent).toBe('—')
    })

    it('marks overridden cells with a dagger that links to a footnote', async () => {
      renderTable()
      await screen.findByRole('table')
      const cell = cellAt('Defect rate', 'All units', 'Aug')
      const dagger = within(cell).getByRole('link', { name: /overridden/i })
      expect(dagger.textContent).toBe('†')
      const note = screen.getByText('Overridden by admin@example.test on 2026-10-05: Audit finding')
      const target = note.closest('[id]') as HTMLElement
      expect(dagger.getAttribute('href')).toBe(`#${target.id}`)
      expect(within(cell).getByRole('img', { name: 'Status: Red' })).toBeTruthy()
    })
  })

  describe('rows', () => {
    it('shows depth 0 and 1 subjects, with deeper subjects behind a toggle', async () => {
      renderTable()
      await screen.findByRole('table')
      expect(screen.getByRole('rowheader', { name: /On-time delivery.*All units/ })).toBeTruthy()
      expect(screen.getByRole('rowheader', { name: /Unit A/ })).toBeTruthy()
      expect(screen.queryByRole('rowheader', { name: /Team A1/ })).toBeNull()

      const toggle = screen.getByRole('button', { name: /Show.*Unit A/ })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      const user = userEvent.setup()
      await user.click(toggle)
      const team = screen.getByRole('rowheader', { name: /Team A1/ })
      const expanded = screen.getByRole('button', { name: /Hide.*Unit A/ })
      expect(expanded.getAttribute('aria-expanded')).toBe('true')
      expect(team.closest('tr')?.id).toBe(expanded.getAttribute('aria-controls'))

      await user.click(expanded)
      expect(screen.queryByRole('rowheader', { name: /Team A1/ })).toBeNull()
    })

    it('restricts to the subject filter and its descendants', async () => {
      server.use(
        http.get(`${API}/v1/org/units`, () =>
          HttpResponse.json({
            units: [
              { id: 'root', name: 'All units', levelId: 'l0', parentId: '', sourceKeys: [] },
              { id: 'unit-a', name: 'Unit A', levelId: 'l1', parentId: 'root', sourceKeys: [] },
              { id: 'team-a1', name: 'Team A1', levelId: 'l2', parentId: 'unit-a', sourceKeys: [] },
              { id: 'unit-b', name: 'Unit B', levelId: 'l1', parentId: 'root', sourceKeys: [] },
            ],
          }),
        ),
      )
      const { urls } = renderTable('/scorecards/sc-main?period=2026-M10&subject=unit-a')
      await screen.findByRole('table')
      expect(urls.at(-1)?.searchParams.getAll('subjects').sort()).toEqual(['team-a1', 'unit-a'])
      expect(screen.getByRole('rowheader', { name: /Unit A/ })).toBeTruthy()
      expect(screen.queryByRole('rowheader', { name: /Unit B/ })).toBeNull()
      expect(screen.queryByRole('rowheader', { name: /On-time delivery.*All units/ })).toBeNull()
      // The selected subject is the top row, so its child sits behind the toggle.
      expect(screen.queryByRole('rowheader', { name: /Team A1/ })).toBeNull()
      expect(screen.getByRole('button', { name: /Show.*Unit A/ })).toBeTruthy()
    })
  })

  describe('methodology and structure', () => {
    it('restates under a chosen version and goes back to as-reported', async () => {
      const { urls } = renderTable()
      await screen.findByRole('table')
      const user = userEvent.setup()
      const select = await screen.findByRole('combobox', { name: 'View under methodology…' })
      await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1))
      await user.selectOptions(select, 'ver-2')

      await waitFor(() => expect(location()).toContain('restate=ver-2'))
      await waitFor(() => expect(urls.at(-1)?.searchParams.get('restate')).toBe('ver-2'))
      expect(
        await screen.findByText('Restated under FY27 proposal. Stored results are unchanged.'),
      ).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Back to as-reported' }))
      await waitFor(() => expect(location()).not.toContain('restate'))
      expect(screen.queryByText(/Restated under/)).toBeNull()
      await waitFor(() => expect(urls.at(-1)?.searchParams.get('restate')).toBeNull())
    })

    it('toggles the structure between as of each month and today', async () => {
      const { urls } = renderTable()
      await screen.findByRole('table')
      const user = userEvent.setup()
      const asOf = screen.getByRole('radio', { name: 'As of each month' }) as HTMLInputElement
      expect(asOf.checked).toBe(true)
      expect(urls[0]!.searchParams.get('structure')).toBeNull()

      await user.click(screen.getByRole('radio', { name: "Today's structure" }))
      await waitFor(() => expect(location()).toContain('structure=current'))
      await waitFor(() => expect(urls.at(-1)?.searchParams.get('structure')).toBe('current'))

      await user.click(screen.getByRole('radio', { name: 'As of each month' }))
      await waitFor(() => expect(location()).not.toContain('structure'))
    })

    it('reads restate and structure from the URL', async () => {
      const { urls } = renderTable('/scorecards/sc-main?period=2026-M10&restate=ver-1&structure=current')
      await screen.findByText('Restated under FY26 published. Stored results are unchanged.')
      await screen.findByRole('table')
      expect(urls.at(-1)?.searchParams.get('restate')).toBe('ver-1')
      expect(urls.at(-1)?.searchParams.get('structure')).toBe('current')
    })
  })

  describe('states', () => {
    it('shows a loading skeleton first', async () => {
      renderTable()
      expect(screen.getByRole('status', { name: /loading/i })).toBeTruthy()
      await screen.findByRole('table')
    })

    it('shows the error and retries', async () => {
      let fail = true
      server.use(
        ...viewHandlers({
          respond: () =>
            fail
              ? HttpResponse.json({ error: { code: 'internal', message: 'The view is unavailable' } }, { status: 500 })
              : undefined,
        }),
      )
      renderApp(<TableTab scorecardId="sc-main" scorecardName="Main scorecard" />, {
        route: '/scorecards/sc-main?period=2026-M10',
      })
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('The view is unavailable')
      fail = false
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
      await screen.findByRole('table')
    })

    it('shows an empty state with no rows', async () => {
      server.use(
        ...viewHandlers({
          respond: () =>
            HttpResponse.json({ periods: ['2026-M10'], ytd: [], categories: [], rows: [], versionByPeriod: {} }),
        }),
      )
      renderApp(<TableTab scorecardId="sc-main" scorecardName="Main scorecard" />, {
        route: '/scorecards/sc-main?period=2026-M10',
      })
      expect(await screen.findByText('No results for this selection.')).toBeTruthy()
      expect(screen.queryByRole('table')).toBeNull()
    })
  })

  describe('drawer', () => {
    it('opens from a cell and shows components', async () => {
      renderTable()
      await screen.findByRole('table')
      const user = userEvent.setup()
      await user.click(within(cellAt('On-time delivery', 'All units', 'Oct')).getByRole('button'))
      const dialog = await screen.findByRole('dialog', { name: /On-time delivery.*All units.*Oct 2026/ })
      expect(within(dialog).getByText('440 / 522')).toBeTruthy()
    })

    it('returns focus to the cell when the drawer closes', async () => {
      renderTable()
      await screen.findByRole('table')
      const user = userEvent.setup()
      const button = within(cellAt('On-time delivery', 'All units', 'Oct')).getByRole('button')
      await user.click(button)
      await screen.findByRole('dialog')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(button)
    })

    it('invalidates the view after clearing an override', async () => {
      const { urls } = renderTable()
      await screen.findByRole('table')
      let deleted: URL | undefined
      server.use(
        http.delete(`${API}/v1/scorecards/sc-main/overrides`, ({ request }) => {
          deleted = new URL(request.url)
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const before = urls.length
      const user = userEvent.setup()
      await user.click(within(cellAt('Defect rate', 'All units', 'Aug')).getByRole('button'))
      await user.click(await screen.findByRole('button', { name: 'Clear override' }))
      await waitFor(() => expect(deleted).toBeTruthy())
      expect(deleted?.searchParams.get('metricKey')).toBe('defect_rate')
      await waitFor(() => expect(urls.length).toBeGreaterThan(before))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('asks for the records behind a cell only when its drawer opens', async () => {
      const asked: URL[] = []
      server.use(
        ...contributionHandlers((url) => {
          asked.push(url)
          return { measures: [contributionMeasure()] }
        }),
        ...viewHandlers(),
      )
      renderApp(<TableTab scorecardId="sc-main" scorecardName="Main scorecard" />, {
        route: '/scorecards/sc-main?period=2026-M10',
      })
      await screen.findByRole('table')
      expect(asked).toHaveLength(0)
      await userEvent.setup().click(within(cellAt('On-time delivery', 'Unit A', 'Oct')).getByRole('button'))
      const dialog = await screen.findByRole('dialog')
      expect(await within(dialog).findAllByText('Derived from 1 record')).toHaveLength(1)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.searchParams.get('subject')).toBe('unit-a')
    })

    it('does not show the override form to viewers', async () => {
      state.role = 'viewer'
      renderTable()
      await screen.findByRole('table')
      await userEvent.setup().click(within(cellAt('On-time delivery', 'All units', 'Oct')).getByRole('button'))
      const dialog = await screen.findByRole('dialog')
      await within(dialog).findByText('440 / 522')
      expect(within(dialog).queryByRole('button', { name: 'Save override' })).toBeNull()
    })
  })

  it('anchors each metric\'s first row for links from the Charts tab', async () => {
    renderTable()
    await screen.findByRole('table')
    const anchor = document.getElementById('metric-on_time_pct')
    expect(anchor?.getAttribute('scope')).toBe('row')
    expect(anchor?.textContent).toContain('On-time delivery')
    expect(document.getElementById('metric-defect_rate')).toBeTruthy()
  })

  it('has no accessibility violations', async () => {
    renderTable('/scorecards/sc-main?period=2026-M10&ytd=1')
    const table = await screen.findByRole('table')
    const results = await axe(table.closest('[role="region"]') as HTMLElement)
    expect(results.violations).toEqual([])
  })
})
