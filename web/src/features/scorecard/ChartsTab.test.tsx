import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { axe } from 'vitest-axe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { buildView, viewHandlers } from '../../test/viewFixtures'
import { ChartsTab } from './ChartsTab'
import { ScorecardPage } from './ScorecardPage'

type ScorecardView = components['schemas']['ScorecardView']
type Cell = components['schemas']['Cell']

function LocationProbe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search + l.hash}</p>
}

const location = () => screen.getByTestId('location').textContent ?? ''

const ROUTE = '/scorecards/sc-main?period=2026-M10&tab=charts'

/** Renders the Charts tab; `edit` adjusts the fixture view the API returns. */
function renderCharts(route = ROUTE, edit?: (view: ScorecardView) => void) {
  const urls: URL[] = []
  server.use(
    ...viewHandlers({
      onView: (u) => urls.push(u),
      respond: edit
        ? (u) => {
            const view = buildView(u.searchParams)
            edit(view)
            return HttpResponse.json(view)
          }
        : undefined,
    }),
  )
  renderApp(
    <>
      <ChartsTab scorecardId="sc-main" />
      <LocationProbe />
    </>,
    { route },
  )
  return { urls }
}

/** The cell of a metric's top-level row for a period. */
function cellOf(view: ScorecardView, metric: string, period: string): Cell {
  const row = view.rows.find((r) => r.metricKey === metric && r.depth === 0)
  const cell = row?.cells.find((c) => c.period === period && !c.ytd)
  if (!cell) throw new Error(`no cell for ${metric} ${period}`)
  return cell
}

function tile(name: string): HTMLElement {
  return screen.getByRole('link', { name: new RegExp(name) })
}

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom; tests that need it add it.
  delete window.matchMedia
})

describe('ChartsTab', () => {
  describe('data', () => {
    it('asks for the 12 fiscal months ending at the selected month, with no subject filter by default', async () => {
      const { urls } = renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(urls).toHaveLength(1)
      const q = urls[0]!.searchParams
      expect(q.getAll('periods')).toHaveLength(12)
      expect(q.getAll('periods')[0]).toBe('2025-M11')
      expect(q.getAll('periods')[11]).toBe('2026-M10')
      expect(q.getAll('ytd')).toEqual([])
      expect(q.getAll('subjects')).toEqual([])
    })

    it('uses each metric\'s shallowest row by default', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(tile('On-time delivery').textContent).toContain('All units')
      expect(tile('On-time delivery').textContent).toContain('84.3%')
      expect(screen.queryByText('Unit A')).toBeNull()
    })

    it('asks for the selected subject and shows that subject\'s tiles', async () => {
      const { urls } = renderCharts(`${ROUTE}&subject=unit-a`)
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(urls[0]!.searchParams.getAll('subjects')).toEqual(['unit-a'])
      expect(tile('On-time delivery').textContent).toContain('Unit A')
      expect(tile('On-time delivery').textContent).toContain('70.0%')
    })

    it('uses the quarter columns for a quarter period', async () => {
      const { urls } = renderCharts('/scorecards/sc-main?period=2026-Q3&tab=charts')
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(urls[0]!.searchParams.getAll('periods')).toEqual(['2026-Q1', '2026-Q2', '2026-Q3'])
      expect(screen.getAllByText(/Trend over 3 quarters/)).toHaveLength(2)
    })
  })

  describe('layout', () => {
    it('groups tiles under category headings, in category order', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(h2).toEqual(['Delivery', 'Quality'])
      const h3 = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
      expect(h3).toEqual(['On-time delivery', 'Defect rate'])
      const delivery = screen.getByRole('heading', { name: 'Delivery', level: 2 }).closest('section') as HTMLElement
      expect(within(delivery).getByRole('heading', { name: 'On-time delivery' })).toBeTruthy()
      expect(within(delivery).queryByRole('heading', { name: 'Defect rate' })).toBeNull()
    })
  })

  describe('summary strip', () => {
    it('counts the selected period by status, with letters and labels, plus NA and missing', async () => {
      renderCharts()
      const strip = await screen.findByRole('region', { name: 'Status summary' })
      const count = (label: string) =>
        within(strip).getByText(label).closest('li')?.lastElementChild?.textContent
      expect(count('Green')).toBe('0')
      expect(count('Yellow')).toBe('1')
      expect(count('Red')).toBe('0')
      expect(count('Not applicable')).toBe('1')
      expect(count('No data')).toBe('0')
      // The letter sits beside its label.
      expect(within(within(strip).getByText('Yellow').closest('li') as HTMLElement).getByRole('img').textContent).toBe('Y')
      expect(within(strip).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual([
        'Status: Green',
        'Status: Yellow',
        'Status: Red',
      ])
    })

    it('counts a metric with no value as missing', async () => {
      renderCharts(ROUTE, (view) => {
        Object.assign(cellOf(view, 'defect_rate', '2026-M10'), { naReason: '' })
      })
      const strip = await screen.findByRole('region', { name: 'Status summary' })
      const count = (label: string) =>
        within(strip).getByText(label).closest('li')?.lastElementChild?.textContent
      expect(count('No data')).toBe('1')
      expect(count('Not applicable')).toBe('0')
    })
  })

  describe('tiles', () => {
    it('shows the value, status letter, components and change', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const t = tile('On-time delivery')
      expect(t.textContent).toContain('84.3%')
      expect(within(t).getByRole('img', { name: 'Status: Yellow' }).textContent).toBe('Y')
      expect(t.textContent).toContain('440 / 522')
      expect(t.textContent).toContain('+2.1 pts vs Sep')
    })

    it('adds the direction wording for a lower-is-better metric', async () => {
      renderCharts(ROUTE, (view) => {
        Object.assign(cellOf(view, 'defect_rate', '2026-M10'), {
          value: 2.4,
          display: '2.4',
          status: 'Y',
          naReason: '',
          components: { defects: 2.4 },
          change: -17,
          changeKind: 'improvement_pct',
        })
      })
      await screen.findByRole('heading', { name: 'Quality', level: 2 })
      const t = tile('Defect rate')
      expect(t.textContent).toContain('17% worse vs Sep · lower is better')
      // One measure is not a ratio: no components line.
      expect(t.textContent).not.toContain(' / ')
    })

    it('shows the reason, and no status badge, when the current period is not applicable', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Quality', level: 2 })
      const t = tile('Defect rate')
      expect(within(t).getByText('Not measured this month')).toBeTruthy()
      expect(within(t).queryByRole('img', { name: /^Status/ })).toBeNull()
    })

    it('marks an overridden current value with a dagger and a note', async () => {
      renderCharts(ROUTE, (view) => {
        Object.assign(cellOf(view, 'on_time_pct', '2026-M10'), {
          override: { metricKey: 'on_time_pct', subjectId: 'root', period: '2026-M10', value: null, status: 'Y', reason: 'Audit finding', by: 'admin@example.test', at: '2026-10-05T12:00:00Z' },
        })
      })
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const t = tile('On-time delivery')
      const mark = within(t).getByText('†')
      expect(mark.getAttribute('title')).toBe('Overridden by admin@example.test on 2026-10-05: Audit finding')
      expect(t.textContent).toContain('Overridden by admin@example.test on 2026-10-05: Audit finding')
      const notes = screen.getByRole('region', { name: 'Override notes' })
      expect(notes.textContent).toContain('On-time delivery')
      expect(notes.textContent).toContain('Overridden by admin@example.test on 2026-10-05: Audit finding')
      expect(within(tile('Defect rate')).queryByText('†')).toBeNull()
    })
  })

  describe('sparkline', () => {
    it('has a visually hidden trend summary with the goal', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const summary = within(tile('On-time delivery')).getByText(
        'Trend over 12 months: from 95.0% to 84.3%; goal 90.0%',
      )
      expect(summary.className).toContain('sr-only')
    })

    it('leaves out the goal clause when there is no target', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Quality', level: 2 })
      // Current month is not applicable, so the trend ends at the last month with a value.
      const summary = within(tile('Defect rate')).getByText(/^Trend over 12 months/)
      expect(summary.textContent).toBe('Trend over 12 months: from 2.0 to 4.0')
      expect(summary.textContent).not.toContain('goal')
    })

    it('hides the chart graphic from assistive technology', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const graphic = within(tile('On-time delivery')).getByTestId('sparkline-graphic')
      expect(graphic.getAttribute('aria-hidden')).toBe('true')
    })

    function mockReducedMotion(matches: boolean) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: matches && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }))
    }

    it('animates by default', async () => {
      mockReducedMotion(false)
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(within(tile('On-time delivery')).getByTestId('sparkline-graphic').getAttribute('data-animated')).toBe('true')
    })

    it('disables animation when the person prefers reduced motion', async () => {
      mockReducedMotion(true)
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      expect(within(tile('On-time delivery')).getByTestId('sparkline-graphic').getAttribute('data-animated')).toBe('false')
    })
  })

  describe('states', () => {
    it('shows a loading skeleton first', () => {
      renderCharts()
      expect(screen.getByRole('status', { name: 'Loading charts' })).toBeTruthy()
    })

    it('shows the error with a retry that reloads', async () => {
      let fail = true
      server.use(
        http.get(`${API}/v1/scorecards/sc-main/view`, ({ request }) =>
          fail
            ? HttpResponse.json({ error: { code: 'internal', message: 'The view is unavailable' } }, { status: 500 })
            : HttpResponse.json(buildView(new URL(request.url).searchParams)),
        ),
      )
      renderApp(<ChartsTab scorecardId="sc-main" />, { route: ROUTE })
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Could not load the charts')
      fail = false
      await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }))
      expect(await screen.findByRole('heading', { name: 'Delivery', level: 2 })).toBeTruthy()
    })

    it('says so when there are no results', async () => {
      renderCharts(ROUTE, (view) => {
        view.rows = []
      })
      expect(await screen.findByText('No results for this selection.')).toBeTruthy()
    })
  })

  describe('navigation', () => {
    it('opens the Table tab at the metric, keeping the other parameters', async () => {
      const scrolled: string[] = []
      const original = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id)
      }
      try {
        server.use(...viewHandlers())
        renderApp(
          <>
            <Routes>
              <Route path="/scorecards/:sc" element={<ScorecardPage />} />
            </Routes>
            <LocationProbe />
          </>,
          { route: '/scorecards/sc-main?period=2026-M10&ytd=1&tab=charts' },
        )
        const user = userEvent.setup()
        await user.click(await screen.findByRole('link', { name: /On-time delivery/ }))
        await waitFor(() => expect(location()).toContain('tab=table'))
        expect(location()).toContain('period=2026-M10')
        expect(location()).toContain('ytd=1')
        expect(location().endsWith('#metric-on_time_pct')).toBe(true)
        expect(await screen.findByRole('table')).toBeTruthy()
        await waitFor(() => expect(scrolled).toContain('metric-on_time_pct'))
        expect(screen.getByRole('tab', { name: 'Table' }).getAttribute('aria-selected')).toBe('true')
      } finally {
        Element.prototype.scrollIntoView = original
      }
    })

    it('links each tile with a href to the table anchor', async () => {
      renderCharts()
      await screen.findByRole('heading', { name: 'Delivery', level: 2 })
      const href = tile('Defect rate').getAttribute('href') ?? ''
      expect(href).toContain('tab=table')
      expect(href).toContain('period=2026-M10')
      expect(href.endsWith('#metric-defect_rate')).toBe(true)
    })
  })

  it('has no accessibility violations', async () => {
    renderCharts(ROUTE, (view) => {
      // Cover the override marker too.
      Object.assign(cellOf(view, 'on_time_pct', '2026-M10'), {
        override: { metricKey: 'on_time_pct', subjectId: 'root', period: '2026-M10', value: null, status: 'Y', reason: '', by: 'admin@example.test', at: '2026-10-05T12:00:00Z' },
      })
    })
    await screen.findByRole('heading', { name: 'Delivery', level: 2 })
    const results = await axe(screen.getByRole('region', { name: 'Status summary' }).parentElement as HTMLElement)
    expect(results.violations).toEqual([])
  })
})
