import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { RcaCellRef } from '../../api/queries'
import type { components } from '../../api/schema'
import { webhooksRca } from '../../test/rcaFixtures'
import { API, server, state } from '../../test/server'
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

afterEach(() => {
  // @ts-expect-error matchMedia is absent in jsdom unless a test defines it.
  delete window.matchMedia
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

describe('WhyCard: uptime', () => {
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

    const link = within(dialog).getByRole('link', { name: 'INC-2041 (opens in a new tab)' })
    expect(link.getAttribute('href')).toBe('https://tracker.example/browse/INC-2041')
    for (const a of within(dialog).getAllByRole('link').filter((l) => l.getAttribute('target'))) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(within(dialog).getAllByRole('link').filter((l) => l.getAttribute('target') === '_blank')).toHaveLength(4)
  })

  it('shows the write-up with its byline and links, the host beside each', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    const rca = await within(dialog).findByRole('region', { name: 'RCA' })
    expect(within(rca).getByText(webhooksRca.note!.text).getAttribute('dir')).toBe('auto')
    expect(within(rca).getByText('Avery Admin · Nov 3')).toBeTruthy()
    expect(within(rca).getByRole('link', { name: 'Postmortem (opens in a new tab)' })).toBeTruthy()
    expect(within(rca).getByText('docs.example')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('anchored popover has no value row', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect(within(dialog).queryByTestId('why-value')).toBeNull()
    expect(within(dialog).getByText('Webhook delivery queue saturated after config deploy').className).toContain('truncate')
  })

  it('shows the value row when asked, as from the RCAs view', async () => {
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

  it('notes the same outage from another source', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    expect(await within(dialog).findByText('Same window as sp-7h1q (Status page)')).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { dialog } = await openCard(WEBHOOKS)
    await loaded(dialog, '0.94 pts short of 100% · 7h 00m down')
    expect((await axe(dialog)).violations).toEqual([])
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

  it('offers an editor Add RCA and Draft with SAM on an empty note', async () => {
    const { dialog } = await openCard(cellOf('epics_on_time', 'checkout'))
    const rca = await within(dialog).findByRole('region', { name: 'RCA' })
    expect(within(rca).getByText('No RCA yet.')).toBeTruthy()
    expect(within(rca).getByRole('button', { name: 'Add RCA' })).toBeTruthy()
    expect(await within(rca).findByRole('button', { name: 'Draft with SAM' })).toBeTruthy()
  })

  it('tells a reader who has not written one yet', async () => {
    state.role = 'viewer'
    const { dialog } = await openCard(cellOf('epics_on_time', 'billing'))
    const rca = await within(dialog).findByRole('region', { name: 'RCA' })
    expect(within(rca).getByText("Billing hasn't written one yet.")).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Add RCA' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Draft with SAM' })).toBeNull()
  })

  it('lists the worst contributors; a row opens the child and the back button returns', async () => {
    const { user, dialog } = await openCard(cellOf('epics_on_time', 'acme'))
    await loaded(dialog, '16 pts short of 100% · 14 of 88 epics missed')
    const list = within(dialog).getByRole('region', { name: 'Worst contributors' })
    expect(within(list).getByText('3 missed · No RCA yet · CHK-226')).toBeTruthy()
    expect(within(list).getByText('2 missed · Why: Ledger freeze moved two epics into November…')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'and 5 more' })).toBeTruthy()
    // An available roll-up chases nobody: no empty state, Add RCA in the footer.
    expect(within(dialog).queryByRole('region', { name: 'RCA' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Add RCA' })).toBeTruthy()
    await user.click(within(list).getByRole('button', { name: /^Checkout/ }))
    await loaded(dialog, '27 pts short of 100% · 3 of 11 epics missed')
    expect(within(dialog).getByRole('heading', { name: 'Checkout' })).toBeTruthy()
    const back = within(dialog).getByRole('button', { name: 'Back to Acme Demo' })
    expect(back.textContent).toBe('‹ Back to Acme Demo')
    expect(back.querySelector('.sr-only')?.textContent).toBe('Back to')
    await user.click(back)
    await loaded(dialog, '16 pts short of 100% · 14 of 88 epics missed')
    expect(within(dialog).getByRole('heading', { name: 'Acme Demo' })).toBeTruthy()
  })
})

describe('WhyCard: remainders, excess and stale notes', () => {
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

  it('shows why a note may be out of date; Still accurate re-saves it unchanged', async () => {
    let body: components['schemas']['PutCellRcaRequest'] | undefined
    server.use(
      http.put(`${API}/v1/scorecards/sc-main/rca`, async ({ request }) => {
        body = (await request.json()) as typeof body
        return HttpResponse.json({ ...searchNote(), revision: 3 })
      }),
    )
    const { user, dialog } = await openCard(cellOf('uptime', 'search'))
    const rca = await within(dialog).findByRole('region', { name: 'RCA' })
    expect(within(rca).getByText('This RCA may be out of date.')).toBeTruthy()
    expect(within(rca).getByText('The value changed from 99.90% to 99.87%.')).toBeTruthy()
    expect(within(rca).getByText('1 new incident since it was written: INC-2049.')).toBeTruthy()
    expect(within(rca).getByText('Casey Contributor · Oct 28 · via MCP')).toBeTruthy()
    await user.click(within(rca).getByRole('button', { name: 'Still accurate' }))
    await waitFor(() => expect(body).toBeDefined())
    expect(body).toEqual({
      metric: 'uptime',
      subject: 'search',
      period: '2026-M10',
      text: searchNote().text,
      links: searchNote().links,
      expectedRevision: 2,
    })
    expect(await screen.findByText('RCA saved')).toBeTruthy()
  })
})

function searchNote() {
  return {
    text: 'Index rebuild during the planned failover; slow queries for about 30 minutes, no failed requests.',
    links: [],
    authorId: 'dev|contributor',
    authorName: 'Casey Contributor',
    channel: 'mcp' as const,
    updatedAt: '2026-10-28T09:00:00Z',
    revision: 2,
  }
}

describe('WhyCard: hostile text (Review Focus 3)', () => {
  it('renders script URLs as text, HTML as text, and hosts as punycode', async () => {
    const { dialog } = await openCard(cellOf('uptime', 'push-gateway'))
    const key = await within(dialog).findByText('INC-6666')
    expect(key.closest('a')).toBeNull()
    expect(within(dialog).queryByRole('link', { name: /INC-6666/ })).toBeNull()
    expect(within(dialog).getByText('<img src=x onerror="alert(1)">')).toBeTruthy()
    expect(dialog.querySelector('img[src="x"]')).toBeNull()
    expect(within(dialog).getByText('<b>bold</b> and **not markdown**')).toBeTruthy()
    expect(dialog.querySelector('b')).toBeNull()
    expect(within(dialog).getByText('xn--bcher-kva.example')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Runbook (opens in a new tab)' })).toBeTruthy()
    expect(within(dialog).queryByRole('link', { name: /Old wiki/ })).toBeNull()
    expect(within(dialog).getByText('Old wiki')).toBeTruthy()
  })
})

describe('WhyCard: states and focus', () => {
  it('says there is nothing to explain at 100%', async () => {
    const { dialog } = await openCard(cellOf('uptime', 'checkout-api'))
    expect(await within(dialog).findByText('Nothing to explain: 100.00% in Oct 2026.')).toBeTruthy()
  })

  it('shows a busy skeleton while loading', async () => {
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/rca`, async () => {
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
      http.get(`${API}/v1/scorecards/sc-main/rca`, () =>
        fail ? HttpResponse.json({ error: { code: 'internal', message: 'Boom' } }, { status: 500 }) : HttpResponse.json(webhooksRca),
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
