import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import { API, server, state } from '../../test/server'
import {
  defectOptional,
  missingSummaries,
  newSeen,
  ON_TIME_TEXT,
  onTimeWritten,
  publishBlockedResponse,
  spendStale,
  trainingMissing,
  writtenSummaries,
  publishedDocV1,
  publishedDocV2,
  publishedMonths,
  REPORT_SUMMARY,
  reportDocument,
  reportHandlers,
  reportViewWithUptime,
  type ReportHandlerOptions,
} from '../../test/reportFixtures'
import { renderApp } from '../../test/utils'
import { assistantHandlers, newAssistantSeen, type AssistantFakeOptions } from '../../test/assistantFixtures'
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

  it('a live report counts health from the Overview’s own request, in the tenant’s labels; a published one from its snapshot', async () => {
    const views: URL[] = []
    server.use(...viewHandlers({ onView: (u) => views.push(u) }), ...reportHandlers())
    const { unmount } = renderApp(<App />, { route: ROUTE })
    const health = await screen.findByRole('list', { name: 'Health this month' })
    expect(within(health).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['▲Y1 Yellow', '1 Not reported'])
    expect(views).toHaveLength(1)
    expect(views[0]!.searchParams.getAll('periods')).toHaveLength(12)
    unmount()

    views.length = 0
    server.use(...viewHandlers({ onView: (u) => views.push(u) }), ...reportHandlers({ document: published, months: publishedMonths }))
    renderApp(<App />, { route: ROUTE })
    await screen.findByRole('list', { name: 'Health this month' })
    expect(views).toEqual([])
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

  it('shows statuses as chips with shape and letter: Health, cards and the table', async () => {
    renderReport(ROUTE, {
      document: () => reportDocument({ live: false, revision: 1, view: reportViewWithUptime() }),
      months: publishedMonths,
    })
    const needs = (await screen.findByRole('heading', { name: 'Needs attention', level: 2 })).closest('section')!
    const uptime = within(needs).getByRole('heading', { name: 'Service uptime', level: 3 }).closest('article')!
    expect(uptime.textContent).toContain('◆R')
    expect(within(uptime).getByText('Red').className).toBe('sr-only')
    const table = screen.getByRole('table', { name: /Main scorecard/ })
    expect(within(table).getByRole('rowheader', { name: 'On-time delivery' }).closest('tr')!.textContent).toContain('84.3%▲Y')
  })

  it('a revision published before coarse periods were saved says which metrics it does not count, and an admin can publish again', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { document: () => publishedDocV1(), months: publishedMonths, seen })
    const line = await screen.findByText(
      '2 quarterly or twice-yearly metrics are not counted in this revision: it was published before their periods were saved.',
      { exact: false },
    )
    expect(line.closest('section')!.querySelector('h2')!.textContent).toBe('Summary')
    await userEvent.setup().click(within(line).getByRole('button', { name: 'Publish again to include them.' }))
    await waitFor(() => expect(seen.publishes).toHaveLength(1))
  })

  it('a viewer reads the not-counted line without the publish link', async () => {
    state.role = 'viewer'
    renderReport(ROUTE, { document: () => publishedDocV1(), months: publishedMonths })
    const line = await screen.findByText(/metrics are not counted in this revision/)
    expect(line.textContent).toBe(
      '2 quarterly or twice-yearly metrics are not counted in this revision: it was published before their periods were saved.',
    )
    expect(screen.queryByRole('button', { name: 'Publish again to include them.' })).toBeNull()
  })

  it('a revision with its standing has no not-counted line', async () => {
    renderReport(ROUTE, { document: () => publishedDocV2(), months: publishedMonths })
    await screen.findByRole('list', { name: 'Health this month' })
    expect(screen.queryByText(/not counted in this revision/)).toBeNull()
  })
})

describe('ReportPage on phones', () => {
  const original = window.matchMedia
  beforeEach(() => {
    // Under 640px: no min-width query matches.
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

  it('replaces the 8-column table with the status list, one row per metric, with no axe violations', async () => {
    const { container } = renderReport()
    await screen.findByRole('heading', { name: 'Scorecard table', level: 2 })
    expect(screen.queryByRole('columnheader', { name: 'YTD' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Metric' })).toBeNull()
    const list = screen.getByRole('table', { name: /Main scorecard, May 2026 – Oct 2026/ })
    const row = within(list).getByRole('rowheader', { name: 'On-time delivery' }).closest('tr')!
    expect(row.children).toHaveLength(2)
    expect(list.querySelectorAll('th[scope="rowgroup"]').length).toBeGreaterThan(0)
    expect((await axe(container)).violations).toEqual([])
  })

  it('offers one Download menu with PowerPoint and PDF', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob)
      return 'blob:report'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderReport()
    await screen.findByRole('heading', { name: 'Needs attention', level: 2 })
    expect(screen.queryByRole('button', { name: 'Download PPTX' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['PowerPoint (.pptx)', 'PDF'])
    await user.click(within(menu).getByRole('menuitem', { name: 'PDF' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('Main scorecard 2026-M10.pdf')
    expect(created[0]!.type).toBe('application/pdf')
  })

  it('Use my layout is a switch', async () => {
    server.use(
      http.get(`${API}/v1/me/layouts/:sc`, () =>
        HttpResponse.json({
          items: [{ id: 'metric:on_time_pct', size: 'small', hidden: true }],
          revision: 2,
          source: 'user',
          defaultRevision: 0,
        }),
      ),
    )
    renderReport()
    await screen.findByRole('heading', { name: 'Delivery', level: 2 })
    const toggle = screen.getByRole('switch', { name: 'Use my layout' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await userEvent.setup().click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delivery', level: 2 })).toBeNull())
  })

  it('lays Health out two by two', async () => {
    renderReport()
    const health = await screen.findByRole('list', { name: 'Health this month' })
    expect(health.className).toContain('grid-cols-2')
  })
})

describe('ReportPage: Draft with SAM', () => {
  function renderDraft(options: AssistantFakeOptions = {}) {
    const seen = newSeen()
    const sam = options.seen ?? newAssistantSeen()
    server.use(...assistantHandlers({ ...options, seen: sam }))
    const view = renderReport(ROUTE, { seen })
    return { seen, sam, ...view }
  }

  it('fills the summary with a draft marked for review, and saves nothing until Save', async () => {
    const { seen, sam, container } = renderDraft()
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    expect(await screen.findByText('SAM is drafting the summary…')).toBeTruthy()
    await waitFor(() => expect(box.value).toBe('October was steady: on-time delivery held at 84.3%.'), { timeout: 4000 })
    expect(sam.draftPosts).toHaveLength(1)
    const note = screen.getByText('Draft from SAM — review before saving')
    expect(box.getAttribute('aria-describedby')).toContain(note.id)
    expect(screen.getByText('claude-haiku-5-5 · 1,234 in · 56 out tokens')).toBeTruthy()
    expect(seen.summaryPuts).toEqual([])
    expect(screen.getByText('You have unsaved summary changes. Save before publishing.')).toBeTruthy()
    expect((await axe(container)).violations).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Save summary' }))
    await waitFor(() =>
      expect(seen.summaryPuts).toEqual([{ text: 'October was steady: on-time delivery held at 84.3%.', expectedRevision: 3 }]),
    )
    expect(screen.queryByText('Draft from SAM — review before saving')).toBeNull()
  })

  it('discards a draft back to the text before it', async () => {
    renderDraft()
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }, { timeout: 4000 }))
    expect(box.value).toBe(REPORT_SUMMARY)
    expect(screen.queryByText('Draft from SAM — review before saving')).toBeNull()
  })

  it('discards a second draft back to the text before the first', async () => {
    renderDraft()
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    await screen.findByRole('button', { name: 'Discard draft' }, { timeout: 4000 })
    await user.click(await screen.findByRole('button', { name: 'Draft with SAM' }, { timeout: 4000 }))
    await waitFor(() => expect(screen.queryByText('SAM is drafting the summary…')).toBeNull(), { timeout: 4000 })
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    expect(box.value).toBe(REPORT_SUMMARY)
  })

  it('shows why SAM could not draft, with the way to fix it', async () => {
    renderDraft()
    server.use(
      http.post(`${API}/v1/scorecards/:sc/reports/:period/summary/draft`, () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'Add your Claude API key in My settings → Ask SAM to draft with SAM.' } },
          { status: 409 },
        ),
      ),
    )
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Draft with SAM' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Add your Claude API key in My settings → Ask SAM to draft with SAM.')
    expect(within(alert).getByRole('link', { name: 'Open Ask SAM settings' }).getAttribute('href')).toBe('/settings/ask-sam')
    expect(box.value).toBe(REPORT_SUMMARY)
  })

  it('shows a draft that failed in the worker', async () => {
    renderDraft({ draft: { error: 'Claude could not be reached. Try again in a minute.' } })
    const box = (await screen.findByRole('textbox', { name: 'Summary' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(REPORT_SUMMARY))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Draft with SAM' }))
    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toContain(
      'Claude could not be reached. Try again in a minute.',
    )
    expect(box.value).toBe(REPORT_SUMMARY)
  })

  it('is not offered to viewers', async () => {
    state.role = 'viewer'
    renderReport()
    expect(await screen.findByText(REPORT_SUMMARY)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Draft with SAM' })).toBeNull()
  })
})

describe('ReportPage: exec summaries and the publish gate', () => {
  const blockName = '3 exec summaries needed before Oct 2026 can be published'

  it('a live report lists the missing summaries, with links to write them, and holds Publish', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { seen, summaries: missingSummaries })
    const heading = await screen.findByRole('heading', { name: blockName, level: 2 })
    const block = heading.closest('section')!
    const items = within(block).getAllByRole('listitem')
    expect(items.map((li) => within(li).getAllByRole('link')[0]!.textContent)).toEqual([
      'On-time delivery',
      'Service uptime',
      'Security training completion',
    ])
    expect(within(items[0]!).getByRole('link', { name: 'On-time delivery' }).getAttribute('href')).toBe(
      '/scorecards/sc-main/exec-summaries?period=2026-M10&why=on_time_pct',
    )
    expect(items[0]!.textContent).toContain('84.3%')
    expect(items[0]!.textContent).toContain('Yellow')
    expect(items[2]!.textContent).toContain('Below 100% (94%)')
    const write = within(items[1]!).getByRole('link', { name: 'Write exec summary for Service uptime' })
    expect(write.textContent).toBe('Write exec summary for Service uptime ›')
    expect(write.getAttribute('href')).toBe('/scorecards/sc-main/exec-summaries?period=2026-M10&why=svc_uptime')
    expect(within(block).getByRole('link', { name: 'View all exec summaries ›' }).getAttribute('href')).toBe(
      '/scorecards/sc-main/exec-summaries?period=2026-M10',
    )
    expect(block.textContent).toContain('1 written summary may be out of date (Spend vs plan); that does not block publishing.')
    expect(screen.queryByText(/Publishing is allowed/)).toBeNull()

    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    expect(publish.getAttribute('aria-disabled')).toBe('true')
    expect(publish.disabled).toBe(false)
    expect(publish.getAttribute('aria-describedby')).toContain(heading.id)
    const line = screen.getByText('Publishing needs 3 more exec summaries.')
    expect(publish.getAttribute('aria-describedby')).toContain(line.id)
    publish.focus()
    expect(document.activeElement).toBe(publish)
    await userEvent.setup().click(publish)
    expect(seen.publishes).toHaveLength(0)
  })

  it('shows the block to a viewer, without Write links or Publish', async () => {
    state.role = 'viewer'
    renderReport(ROUTE, { summaries: missingSummaries })
    const block = (await screen.findByRole('heading', { name: blockName })).closest('section')!
    expect(within(block).queryByRole('link', { name: /^Write/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('with nothing missing, Publish is enabled and a stale summary is mentioned, not blocking', async () => {
    const seen = newSeen()
    renderReport(ROUTE, { seen, summaries: [onTimeWritten, spendStale, defectOptional] })
    expect(await screen.findByText('1 exec summary may be out of date: Spend vs plan. Publishing is allowed.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /exec summar(y|ies) needed before/ })).toBeNull()
    const publish = screen.getByRole('button', { name: 'Publish' })
    expect(publish.getAttribute('aria-disabled')).not.toBe('true')
    expect(screen.queryByText(/Publishing needs/)).toBeNull()
    await userEvent.setup().click(publish)
    await waitFor(() => expect(seen.publishes).toHaveLength(1))
  })

  it('a 409 from Publish re-renders the block from its list and moves focus to its heading', async () => {
    renderReport(ROUTE, { summaries: writtenSummaries, publish: () => publishBlockedResponse([trainingMissing]) })
    await screen.findByRole('heading', { name: 'Needs attention', level: 2 })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish' }))
    const heading = await screen.findByRole('heading', { name: '1 exec summary needed before Oct 2026 can be published' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(within(heading.closest('section')!).getByRole('link', { name: 'Security training completion' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Publish' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Publishing needs 1 more exec summary.')).toBeTruthy()
  })

  it('a metric block shows the summary, its first 3 links with Show all, and the attribution line', async () => {
    renderReport(ROUTE, { summaries: writtenSummaries })
    const needs = (await screen.findByRole('heading', { name: 'Needs attention', level: 2 })).closest('section')!
    const block = (await within(needs).findByRole('heading', { name: 'On-time delivery', level: 3 })).closest('article')!
    const summary = await within(block).findByRole('group', { name: 'Exec summary' })
    expect(within(summary).getByText(ON_TIME_TEXT)).toBeTruthy()
    expect(within(summary).getByText('Avery Admin · Nov 2')).toBeTruthy()
    expect(within(summary).getAllByRole('link', { name: /opens in a new tab/ })).toHaveLength(3)
    const all = within(summary).getByRole('button', { name: 'Show all 12 links' })
    expect(all.getAttribute('aria-expanded')).toBe('false')
    const user = userEvent.setup()
    await user.click(all)
    expect(within(summary).getAllByRole('link', { name: /opens in a new tab/ })).toHaveLength(12)
    expect(document.activeElement).toBe(within(summary).getByRole('button', { name: 'Show fewer' }))
    const line = within(block).getByTestId('summary-attribution')
    expect(line.textContent).toBe('Attribution: 15.7 pts short of 100% · 6 of 38 items missed: DEL-101 · DEL-104')
    expect(within(line).getByRole('link', { name: 'DEL-101' }).getAttribute('href')).toBe('https://tracker.example/browse/DEL-101')
  })

  it('a missing summary says `Exec summary needed`, with Write for admins, and never other text', async () => {
    renderReport(ROUTE, { summaries: missingSummaries })
    const needs = (await screen.findByRole('heading', { name: 'Needs attention', level: 2 })).closest('section')!
    const block = (await within(needs).findByRole('heading', { name: 'On-time delivery', level: 3 })).closest('article')!
    const summary = await within(block).findByRole('group', { name: 'Exec summary' })
    expect(within(summary).getByText('Exec summary needed')).toBeTruthy()
    expect(within(summary).getByRole('link', { name: 'Write exec summary for On-time delivery' }).getAttribute('href')).toBe(
      '/scorecards/sc-main/exec-summaries?period=2026-M10&why=on_time_pct',
    )
    expect(summary.textContent).toBe('Exec summaryExec summary neededWrite exec summary for On-time delivery ›')
    expect(block.textContent).not.toContain(ON_TIME_TEXT)
  })

  it('collects the month’s summaries under Notes → Exec summaries, worst first', async () => {
    renderReport(ROUTE, { summaries: missingSummaries })
    const notes = (await screen.findByRole('heading', { name: 'Notes', level: 2 })).closest('section')!
    const heading = await within(notes).findByRole('heading', { name: 'Exec summaries', level: 3 })
    const lines = within(heading.parentElement!).getAllByRole('listitem').map((li) => li.textContent)
    expect(lines).toEqual([
      'Service uptime · 99.20% Red: Exec summary needed',
      'On-time delivery · 84.3% Yellow: Exec summary needed',
      'Security training completion · 94% Green: Exec summary needed',
      'Spend vs plan · 104% Green: Vendor renewals landed a month early.',
    ])
  })

  it('a published revision shows its frozen summaries and flags one edited since', async () => {
    const frozen = { ...onTimeWritten, text: 'As published.', revision: 2 }
    renderReport(ROUTE, {
      document: () => reportDocument({ live: false, revision: 1 }),
      months: publishedMonths,
      revisionSummaries: { 1: [frozen] },
      summaries: [{ ...onTimeWritten, revision: 3 }],
    })
    const needs = (await screen.findByRole('heading', { name: 'Needs attention', level: 2 })).closest('section')!
    const block = within(needs).getByRole('heading', { name: 'On-time delivery', level: 3 }).closest('article')!
    expect(await within(block).findByText('As published.')).toBeTruthy()
    expect(await within(block).findByText('Exec summary edited since publication')).toBeTruthy()
    expect(within(block).queryByText(ON_TIME_TEXT)).toBeNull()
    expect(screen.queryByRole('heading', { name: /needed before/ })).toBeNull()
  })

  it('a revision published before summaries says so and shows none', async () => {
    renderReport(ROUTE, { document: () => publishedDocV2(), months: publishedMonths, summaries: writtenSummaries })
    expect(await screen.findByText('This revision was published before exec summaries were required.')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Exec summary' })).toBeNull()
    expect(screen.queryByText(ON_TIME_TEXT)).toBeNull()
  })

  it('has no axe violations with the required block and summaries', async () => {
    const { container } = renderReport(ROUTE, { summaries: missingSummaries })
    await screen.findByRole('heading', { name: blockName })
    expect((await axe(container)).violations).toEqual([])
  })
})
