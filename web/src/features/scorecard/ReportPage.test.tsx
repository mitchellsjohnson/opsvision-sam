import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import { API, server, state } from '../../test/server'
import {
  newSeen,
  publishedMonths,
  REPORT_SUMMARY,
  reportDocument,
  reportHandlers,
  type ReportHandlerOptions,
} from '../../test/reportFixtures'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

const ROUTE = '/scorecards/sc-main/report?period=2026-M10'

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

const location = () => screen.getByTestId('location').textContent ?? ''

function renderReport(route = ROUTE, options: ReportHandlerOptions = {}) {
  server.use(...viewHandlers(), ...reportHandlers(options))
  return renderApp(
    <>
      <App />
      <Probe />
    </>,
    { route },
  )
}

const published = (url: URL) =>
  url.searchParams.get('revision') === 'live'
    ? reportDocument()
    : reportDocument({
        live: false,
        revision: 1,
        dataRevised: true,
        changes: [{ metricKey: 'on_time_pct', subjectId: 'root', period: '2026-M10', was: '82.0% Y', now: '84.3% Y' }],
      })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReportPage', () => {
  it('renders the report sections in document order, with table headers, and no axe violations', async () => {
    const { container } = renderReport()
    expect(await screen.findByRole('heading', { name: 'Report', level: 1 })).toBeTruthy()
    await screen.findByRole('heading', { name: 'Needs attention', level: 2 })
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2s).toEqual(['Summary', 'Needs attention', 'Delivery', 'Quality', 'Scorecard table', 'Notes', 'Report history'])
    const table = screen.getByRole('table', { name: /Main scorecard, May 2026 – Oct 2026/ })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Metric',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'YTD',
    ])
    expect(within(table).getByRole('rowheader', { name: 'On-time delivery' })).toBeTruthy()
    expect(screen.getByText(/Month to date, as of|Live data as of/)).toBeTruthy()
    expect((await axe(container)).violations).toEqual([])
  })

  it('the revised banner links to the live report, which requests revision=live', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { document: published, months: publishedMonths, seen })
    const banner = await screen.findByRole('region', { name: 'Data revised since publication' })
    expect(within(banner).getByText(/On-time delivery, All units, Oct 2026: 82\.0% Y → 84\.3% Y/)).toBeTruthy()
    const link = within(banner).getByRole('link', { name: 'View the live report' })
    expect(link.getAttribute('href')).toContain('revision=live')
    await userEvent.setup().click(link)
    await waitFor(() => expect(seen.documents.some((u) => u.searchParams.get('revision') === 'live')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Data revised since publication' })).toBeNull())
  })

  it('on a quarter says the report is monthly, disables its controls, and does not call publish', async () => {
    const seen = newSeen()
    renderReport('/scorecards/sc-main/report?period=2026-Q4', { seen })
    expect(await screen.findByText('The monthly report is available on a month.')).toBeTruthy()
    const controls = screen.getByRole('toolbar', { name: 'Report controls' })
    const publish = (await within(controls).findByRole('button', { name: 'Publish' })) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    expect((within(controls).getByRole('button', { name: 'Download PPTX' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(controls).getByRole('button', { name: 'Download PDF' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(controls).getByRole('checkbox', { name: 'Use my layout' }) as HTMLInputElement).disabled).toBe(true)
    await userEvent.setup().click(publish)
    const views = screen.getByRole('navigation', { name: 'Scorecard views' })
    expect(within(views).getByRole('link', { name: 'Overview' })).toBeTruthy()
    expect(seen.publishes).toHaveLength(0)
    expect(seen.documents).toHaveLength(0)
  })

  it('shows the published date and the publisher to an admin', async () => {
    renderReport(ROUTE, { document: published, months: publishedMonths })
    expect(await screen.findByText('Published on Nov 3, 2026 by Test Admin')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View live' })).toBeTruthy()
  })

  it('never shows a raw user id: a viewer sees the date only and the members list is not read', async () => {
    state.role = 'viewer'
    const seen = newSeen()
    renderReport(ROUTE, { document: published, months: publishedMonths, seen })
    expect(await screen.findByText('Published on Nov 3, 2026')).toBeTruthy()
    expect(screen.queryByText(/dev\|admin/)).toBeNull()
    expect(seen.members).toBe(0)
  })

  it('at a unit scope hides the summary and links to the company report', async () => {
    renderReport(`${ROUTE}&scope=unit-a`)
    await screen.findByRole('heading', { name: 'Summary', level: 2 })
    const link = await screen.findByRole('link', { name: 'Summary is written for Example Co' })
    expect(link.getAttribute('href')).toBe('/scorecards/sc-main/report?period=2026-M10')
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull()
    expect(screen.queryByText(REPORT_SUMMARY)).toBeNull()
  })

  it('an admin saves the summary with the revision it loaded', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { seen })
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.clear(box)
    await user.type(box, 'A steady month.')
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    await waitFor(() => expect(seen.summaryPuts).toEqual([{ text: 'A steady month.', expectedRevision: 3 }]))
    expect(await screen.findByText('Summary saved.')).toBeTruthy()
  })

  it('a stale summary save says so and Reload loads the newer summary and its revision', async () => {
    const seen = newSeen()
    let stored = { text: REPORT_SUMMARY, revision: 3 }
    renderReport(ROUTE, {
      seen,
      summary: () => stored,
      putSummary: (body) =>
        body.expectedRevision === stored.revision
          ? undefined
          : HttpResponse.json(
              { error: { code: 'conflict', message: 'the summary changed since it was loaded; reload it and try again' } },
              { status: 409 },
            ),
    })
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    stored = { text: 'Written by another admin.', revision: 4 }
    const user = userEvent.setup()
    await user.clear(box)
    await user.type(box, 'Mine.')
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This summary changed since you opened it.')
    expect(seen.summaryPuts).toEqual([{ text: 'Mine.', expectedRevision: 3 }])
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(box.value).toBe('Written by another admin.'))
    expect(screen.queryByText('This summary changed since you opened it.')).toBeNull()
    await user.type(box, ' Agreed.')
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    await waitFor(() => expect(seen.summaryPuts.at(-1)).toEqual({ text: 'Written by another admin. Agreed.', expectedRevision: 4 }))
    expect(await screen.findByText('Summary saved.')).toBeTruthy()
  })

  it('keeps the editor and the draft when Reload fails, and says the reload failed', async () => {
    let failGet = false
    renderReport(ROUTE, {
      summary: () =>
        failGet
          ? HttpResponse.json({ error: { code: 'internal', message: 'store unavailable' } }, { status: 500 })
          : { text: REPORT_SUMMARY, revision: 3 },
      putSummary: () => HttpResponse.json({ error: { code: 'conflict', message: 'stale' } }, { status: 409 }),
    })
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.clear(box)
    await user.type(box, 'My draft.')
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    const alert = await screen.findByRole('alert')
    failGet = true
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    expect(await screen.findByText('Could not reload the summary; try again.')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Summary' }) as HTMLTextAreaElement).value).toBe('My draft.')
    expect(screen.queryByText(/Could not load the summary/)).toBeNull()
  })

  it('clears the conflict once a later save succeeds', async () => {
    let puts = 0
    renderReport(ROUTE, {
      putSummary: () =>
        ++puts === 1 ? HttpResponse.json({ error: { code: 'conflict', message: 'stale' } }, { status: 409 }) : undefined,
    })
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.type(box, ' More.')
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    expect(await screen.findByText('This summary changed since you opened it.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    expect(await screen.findByText('Summary saved.')).toBeTruthy()
    expect(screen.queryByText('This summary changed since you opened it.')).toBeNull()
  })

  it('says so when the summary cannot be loaded', async () => {
    renderReport(ROUTE, {
      summary: () => HttpResponse.json({ error: { code: 'internal', message: 'store unavailable' } }, { status: 500 }),
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Could not load the summary/)
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull()
  })

  it('keeps Publish disabled with a warning while the summary has unsaved changes', async () => {
    renderReport()
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    expect(publish.disabled).toBe(false)
    const user = userEvent.setup()
    await user.type(box, ' More.')
    expect(publish.disabled).toBe(true)
    expect(screen.getByText('You have unsaved summary changes. Save before publishing.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    await waitFor(() => expect(publish.disabled).toBe(false))
    expect(screen.queryByText('You have unsaved summary changes. Save before publishing.')).toBeNull()
  })

  it('at a unit scope, disables downloads and publish and says so when the scope tree fails to load', async () => {
    server.use(http.get(`${API}/v1/items`, () => HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 })))
    renderReport(`${ROUTE}&scope=unit-a`)
    expect(await screen.findByText(/Could not load the units and items in this scope/)).toBeTruthy()
    const controls = screen.getByRole('toolbar', { name: 'Report controls' })
    expect((within(controls).getByRole('button', { name: 'Download PPTX' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(controls).getByRole('button', { name: 'Download PDF' }) as HTMLButtonElement).disabled).toBe(true)
    expect(((await within(controls).findByRole('button', { name: 'Publish' })) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names a not-applicable table cell n/a with its reason', async () => {
    renderReport()
    const table = await screen.findByRole('table', { name: /Main scorecard/ })
    expect(within(table).getByRole('img', { name: 'n/a: Not measured this month' })).toBeTruthy()
  })

  it('a viewer reads the summary text without a text box', async () => {
    state.role = 'viewer'
    renderReport()
    expect(await screen.findByText(REPORT_SUMMARY)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('publish warns that the month is not locked, posts, then refetches the report', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { seen })
    await screen.findByRole('heading', { name: 'Needs attention', level: 2 })
    expect(screen.getByText('This month is not locked.')).toBeTruthy()
    const before = seen.documents.length
    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(seen.publishes).toHaveLength(1))
    await waitFor(() => expect(seen.documents.length).toBeGreaterThan(before))
  })

  it('Use my layout hides the metrics the user hid', async () => {
    server.use(
      http.get(`${API}/v1/me/layouts/:sc`, () =>
        HttpResponse.json({
          items: [
            { id: 'section:delivery', size: 'wide', hidden: false },
            { id: 'metric:on_time_pct', size: 'small', hidden: true },
          ],
          revision: 2,
          source: 'user',
          defaultRevision: 0,
        }),
      ),
    )
    renderReport()
    await screen.findByRole('heading', { name: 'Delivery', level: 2 })
    const box = screen.getByRole('checkbox', { name: 'Use my layout' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.setup().click(box)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delivery', level: 2 })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Quality', level: 2 })).toBeTruthy()
  })

  it('downloads a PDF named for the scorecard and month', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob)
      return 'blob:report'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderReport()
    await screen.findByRole('heading', { name: 'Needs attention', level: 2 })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('Main scorecard 2026-M10.pdf')
    expect(created[0]!.type).toBe('application/pdf')
  })

  it('View live switches the URL to the live report', async () => {
    renderReport(ROUTE, { document: published, months: publishedMonths })
    await userEvent.setup().click(await screen.findByRole('button', { name: 'View live' }))
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main/report?period=2026-M10&revision=live'))
    expect(await screen.findByRole('button', { name: 'View published' })).toBeTruthy()
  })
})
