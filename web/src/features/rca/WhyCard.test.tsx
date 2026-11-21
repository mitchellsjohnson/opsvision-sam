import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PutMetricSummaryRequest, RcaCellRef } from '../../api/queries'
import { COMPANY, spendStale, uptimeCardSummary, uptimeText, webhooksAttribution } from '../../test/rcaFixtures'
import { API, companyUnitsHandler, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { useWhyCard, WhyCardProvider, type WhyCardOpenOptions } from './WhyCardProvider'

const cellOf = (metric: string, subject: string): RcaCellRef => ({ metric, subject, period: '2026-M10' })
const WEBHOOKS = cellOf('uptime', 'webhooks')

function Harness({ cell, opts }: { cell: RcaCellRef; opts?: WhyCardOpenOptions }) {
  const why = useWhyCard()
  return (
    <button type="button" onClick={(e) => why.open(cell, e.currentTarget, opts)}>
      Open why
    </button>
  )
}

function setPhone(phone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('min-width: 640px') ? !phone : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => server.use(companyUnitsHandler))

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom unless a test defines it.
  delete window.matchMedia
  vi.unstubAllGlobals()
})

async function openCard(cell: RcaCellRef, opts?: WhyCardOpenOptions) {
  const user = userEvent.setup()
  renderApp(
    <WhyCardProvider scorecardId="sc-main">
      <Harness cell={cell} opts={opts} />
    </WhyCardProvider>,
  )
  const trigger = await screen.findByRole('button', { name: 'Open why' })
  await user.click(trigger)
  const dialog = await screen.findByRole('dialog')
  return { user, trigger, dialog }
}

async function loaded(dialog: HTMLElement, headline: string) {
  await within(dialog).findByText(headline)
}

describe('WhyCard: the exec summary above the attribution', () => {
  it('puts the company exec summary first, labelled for a child cell, then the attribution', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    const summary = within(dialog).getByRole('region', { name: 'Exec summary · Uptime · Oct 2026' })
    const attribution = within(dialog).getByRole('region', { name: 'Attribution' })
    expect(summary.compareDocumentPosition(attribution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(attribution).getByText('Attribution · Webhooks')).toBeTruthy()
    expect(within(summary).getByRole('button', { name: 'Show all 12 links' })).toBeTruthy()
  })

  it('names no metric in the label on the company card', async () => {
    const { dialog } = await openCard(cellOf('uptime', COMPANY))
    await loaded(dialog, '13 of 21 services below 100% · worst Webhooks 99.06%')
    const section = within(dialog).getByRole('region', { name: 'Exec summary' })
    // The company's own card shows the whole text; a child card shows the excerpt with More.
    expect(await within(section).findByText(uptimeText)).toBeTruthy()
    expect(within(section).queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('shows a child card the excerpt with More', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    const section = await within(dialog).findByRole('region', { name: 'Exec summary · Uptime · Oct 2026' })
    expect(within(section).getByText(uptimeCardSummary.text!)).toBeTruthy()
    expect(within(section).getByRole('button', { name: 'More' })).toBeTruthy()
  })

  it('has no summary section for a viewer who cannot read the company cell', async () => {
    state.role = 'viewer'
    const { dialog } = await openCard(cellOf('epics_on_time', 'mobile'))
    await loaded(dialog, '27 pts short of 100% · 3 of 11 epics missed')
    expect(within(dialog).queryByRole('region', { name: /^Exec summary/ })).toBeNull()
    expect(within(dialog).getByRole('region', { name: 'Attribution' })).toBeTruthy()
  })

  it('gives admins Edit exec summary in the footer, and nobody else', async () => {
    const admin = await openCard(WEBHOOKS)
    await loaded(admin.dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(within(admin.dialog).getByRole('button', { name: 'Edit exec summary' })).toBeTruthy()
  })

  it('gives contributors no editor, Edit or Draft with SAM', async () => {
    state.role = 'contributor'
    const { dialog } = await openCard(cellOf('epics_on_time', COMPANY))
    await loaded(dialog, '16 pts short of 100% · 14 of 88 epics missed')
    expect(within(dialog).getByText('Product ops writes this summary.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Edit|Write exec summary|Draft with SAM/ })).toBeNull()
  })

  it('re-saves a stale summary unchanged on Still accurate, with every link', async () => {
    let body: PutMetricSummaryRequest | undefined
    let path = ''
    server.use(
      http.put(`${API}/v1/scorecards/sc-main/metric-summaries/:metric/:period`, async ({ request }) => {
        path = new URL(request.url).pathname
        body = (await request.json()) as PutMetricSummaryRequest
        return HttpResponse.json({ ...spendStale, state: 'written', stale: false, staleReasons: [], revision: 3 })
      }),
    )
    const { user, dialog } = await openCard(cellOf('spend_vs_plan', COMPANY))
    const section = await within(dialog).findByRole('region', { name: 'Exec summary' })
    await user.click(await within(section).findByRole('button', { name: 'Still accurate' }))
    await waitFor(() => expect(body).toBeDefined())
    expect(path).toBe('/v1/scorecards/sc-main/metric-summaries/spend_vs_plan/2026-M10')
    expect(body).toEqual({ text: spendStale.text, links: [], expectedRevision: 2 })
    expect(await screen.findByText('Exec summary saved')).toBeTruthy()
  })
})

describe('WhyCard: uptime attribution', () => {
  it('explains the gap with the bar sentence, incidents in evidence order and the remainder', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(within(dialog).getByText('Why · Oct 2026')).toBeTruthy()
    expect(within(dialog).getByText('Red · Green at 99.90% or better')).toBeTruthy()
    const sentence = within(dialog).getByText('7h 00m down: INC-2041 4h 10m, INC-2047 1h 53m, INC-2049 17m, 40m not explained')
    expect(sentence.className).toContain('sr-only')

    const incidents = within(dialog).getByRole('region', { name: 'Incidents' })
    expect(within(incidents).getByText('Incidents · 3')).toBeTruthy()
    const rows = within(incidents).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('[data-key]')?.textContent ?? null)).toEqual(['INC-2041', 'INC-2047', 'INC-2049', null])
    expect(rows.map((r) => r.querySelector('[data-points]')?.textContent)).toEqual(['0.56 pts', '0.25 pts', '0.04 pts', '0.09 pts'])
    expect(within(rows[1]!).getByText('Overlaps INC-2049 for 25m')).toBeTruthy()
    expect(within(rows[0]!).getByText('SEV2 · Oct 3, 14:05–18:15 UTC · 4h 10m')).toBeTruthy()
    expect(within(rows[3]!).getByText('Not explained by any incident')).toBeTruthy()
    expect(within(rows[3]!).getByText('40m of the 7h 00m reported')).toBeTruthy()
    expect(within(incidents).queryByRole('button', { name: /^Show all/ })).toBeNull()

    const link = within(incidents).getByRole('link', { name: 'INC-2041 (opens in a new tab)' })
    expect(link.getAttribute('href')).toBe('https://tracker.example/browse/INC-2041')
    const external = within(dialog).getAllByRole('link').filter((l) => l.getAttribute('target'))
    for (const a of external) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    // Three summary links and three incident keys.
    expect(external).toHaveLength(6)
  })

  it('anchored popover has no value row and one-line titles', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(within(dialog).queryByTestId('why-value')).toBeNull()
    expect(within(dialog).getByText('Webhook delivery queue saturated after config deploy').className).toContain('truncate')
  })

  it('shows the value row when asked, as from the Exec summaries view', async () => {
    const { dialog } = await openCard(WEBHOOKS, { showValue: true })
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(within(within(dialog).getByTestId('why-value')).getByText('99.06%')).toBeTruthy()
  })

  it('is a bottom sheet on phones, with the value row and two-line incident titles', async () => {
    setPhone(true)
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(dialog.className).toContain('bottom-0')
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Webhooks' })).toBeTruthy()
    expect(within(dialog).getByTestId('why-value')).toBeTruthy()
    expect(within(dialog).getByText('Webhook delivery queue saturated after config deploy').className).toContain('line-clamp-2')
  })

  it('uses an h3 in the desktop popover', async () => {
    setPhone(false)
    const { dialog } = await openCard(WEBHOOKS, { title: 'Webhooks · Uptime' })
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Webhooks · Uptime' })).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect((await axe(dialog)).violations).toEqual([])
  })
})

describe('WhyCard: 37 incidents (Review Focus 5)', () => {
  const observers: { cb: IntersectionObserverCallback; el?: Element }[] = []
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: IntersectionObserverCallback
        el?: Element
        constructor(cb: IntersectionObserverCallback) {
          this.cb = cb
          observers.push(this)
        }
        observe(el: Element) {
          this.el = el
        }
        unobserve() {}
        disconnect() {}
      },
    )
  })

  it('shows 5, Show all 37 incidents, and loads the next page of 50 at the end', async () => {
    const cursors: (string | null)[] = []
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/attribution`, ({ request }) => {
        cursors.push(new URL(request.url).searchParams.get('incidentsCursor'))
        return undefined
      }),
    )
    const { user, dialog } = await openCard(cellOf('uptime', 'event-bus'))
    await loaded(dialog, '0.90 pts short of 100% · 6h 40m down')
    const incidents = within(dialog).getByRole('region', { name: 'Incidents' })
    expect(within(incidents).getByText('Incidents · 37')).toBeTruthy()
    expect(incidents.querySelectorAll('[data-key]')).toHaveLength(5)
    // The arithmetic covers all 37, not only the 5 loaded.
    expect(
      within(dialog).getByText(
        '6h 40m down: INC-3001 10m, INC-3002 10m, INC-3003 10m, INC-3004 10m, INC-3005 10m, 32 more incidents 5h 20m, 30m not explained',
      ),
    ).toBeTruthy()

    const showAll = within(incidents).getByRole('button', { name: 'Show all 37 incidents' })
    expect(showAll.getAttribute('aria-expanded')).toBe('false')
    await user.click(showAll)
    expect(showAll.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(showAll)
    expect(await screen.findByText('Showing 37 incidents')).toBeTruthy()

    const sentinel = observers.at(-1)
    expect(sentinel?.el).toBeTruthy()
    act(() => sentinel!.cb([{ isIntersecting: true, target: sentinel!.el! } as IntersectionObserverEntry], {} as IntersectionObserver))
    await waitFor(() => expect(incidents.querySelectorAll('[data-key]')).toHaveLength(37))
    expect(cursors).toEqual([null, 'bus-p2'])
    expect(await screen.findByText('Loaded 32 more incidents')).toBeTruthy()
    expect(within(incidents).getByText('Event bus partition stall 37')).toBeTruthy()
    expect(within(incidents).getByText('Not explained by any incident')).toBeTruthy()

    await user.click(within(incidents).getByRole('button', { name: 'Show fewer' }))
    expect(incidents.querySelectorAll('[data-key]')).toHaveLength(5)
  })
})

describe('WhyCard: records and roll-ups', () => {
  it('states the unit cost once and gives record rows no points', async () => {
    const { dialog } = await openCard(cellOf('epics_on_time', 'checkout'))
    await loaded(dialog, '27 pts short of 100% · 3 of 11 epics missed')
    expect(within(dialog).getByText('Red · Green at 90% or better · each miss costs 9.1 pts')).toBeTruthy()
    const records = within(dialog).getByRole('region', { name: 'Records' })
    expect(within(records).getByText('Epics · 3 of 11 missed')).toBeTruthy()
    const rows = within(records).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.querySelector('[data-points]')).toBeNull()
    expect(within(rows[0]!).getByText('P2 · Slipped Oct 15 → Nov 12')).toBeTruthy()
    expect(within(rows[0]!).getByRole('link', { name: 'CHK-226 (opens in a new tab)' })).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Open in table' })).toBeTruthy()
  })

  it('lists the worst contributors with their attribution lines; a row opens the child and back returns', async () => {
    const { user, dialog } = await openCard(cellOf('epics_on_time', COMPANY))
    await loaded(dialog, '16 pts short of 100% · 14 of 88 epics missed')
    const list = within(dialog).getByRole('region', { name: 'Worst contributors' })
    expect(within(list).getByText('3 of 11 epics missed · CHK-226 + 2 more')).toBeTruthy()
    expect(within(list).getByText('2 of 11 epics missed · BIL-231 + 1 more')).toBeTruthy()
    expect(within(list).getByText('Nothing linked')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'and 5 more' })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: 'Exec summary' })).toBeTruthy()

    await user.click(within(list).getByRole('button', { name: /^Checkout/ }))
    await loaded(dialog, '27 pts short of 100% · 3 of 11 epics missed')
    expect(within(dialog).getByRole('heading', { name: 'Checkout' })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: 'Exec summary · Epics delivered on time · Oct 2026' })).toBeTruthy()
    const back = within(dialog).getByRole('button', { name: 'Back to Acme Demo' })
    expect(back.textContent).toBe('‹ Back to Acme Demo')
    await user.click(back)
    await loaded(dialog, '16 pts short of 100% · 14 of 88 epics missed')
    expect(within(dialog).getByRole('heading', { name: 'Acme Demo' })).toBeTruthy()
  })
})

describe('WhyCard: remainders and excess', () => {
  it('keeps a remainder within tolerance, saying so', async () => {
    const { dialog } = await openCard(cellOf('deployment_uptime', 'notification-relay'))
    expect(await within(dialog).findByText('5m of the 10h 00m reported (within 1% of the reported downtime)')).toBeTruthy()
    expect(within(dialog).getByText('Started Sep 30, 23:10 · 9h 05m of 9h 55m fell in Oct')).toBeTruthy()
    expect(within(dialog).queryByText(/^Incidents add up to/)).toBeNull()
  })

  it('calls out incidents that add up to more than was reported', async () => {
    const { dialog } = await openCard(cellOf('uptime', 'analytics-ingest'))
    const callout = await within(dialog).findByText(/^Incidents add up to 0\.20 pts \(1h 30m\)/)
    expect(callout.textContent).toBe(
      'Incidents add up to 0.20 pts (1h 30m), 15m more than the 1h 15m reported. The value is shown as reported; check the incident times or the reported downtime.',
    )
    expect(within(dialog).queryByText('Not explained by any incident')).toBeNull()
  })
})

describe('WhyCard: hostile text (Review Focus 4)', () => {
  it('renders a script URL’s key as text and an HTML title as text', async () => {
    const { dialog } = await openCard(cellOf('uptime', 'push-gateway'))
    const key = await within(dialog).findByText('INC-6666')
    expect(key.closest('a')).toBeNull()
    expect(within(dialog).queryByRole('link', { name: /INC-6666/ })).toBeNull()
    expect(within(dialog).getByText('<img src=x onerror="alert(1)">')).toBeTruthy()
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.querySelector('b')).toBeNull()
  })
})

describe('WhyCard: states and focus', () => {
  it('says there is nothing to explain at 100%', async () => {
    const { dialog } = await openCard(cellOf('uptime', 'checkout-api'))
    expect(await within(dialog).findByText('Nothing to explain: 100.00% in Oct 2026.')).toBeTruthy()
  })

  it('shows a busy skeleton while loading', async () => {
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/attribution`, async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const { dialog } = await openCard(WEBHOOKS)
    const busy = dialog.querySelector('[aria-busy="true"]')
    expect(busy).not.toBeNull()
    expect(within(busy as HTMLElement).getByText('Loading why')).toBeTruthy()
  })

  it('says what failed and tries again', async () => {
    let fail = true
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/attribution`, () =>
        fail ? HttpResponse.json({ error: { code: 'internal', message: 'Boom' } }, { status: 500 }) : HttpResponse.json(webhooksAttribution),
      ),
    )
    const { user, dialog } = await openCard(WEBHOOKS, { display: '99.06%' })
    expect(await within(dialog).findByText("Couldn't load why this cell is 99.06%.")).toBeTruthy()
    fail = false
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
  })

  it('focuses the heading on open; Escape closes and returns focus to the trigger', async () => {
    const { user, trigger, dialog } = await openCard(WEBHOOKS)
    const heading = within(dialog).getByRole('heading', { name: 'Webhooks' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('Close returns focus to the trigger', async () => {
    const { user, trigger, dialog } = await openCard(WEBHOOKS)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
