import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { API, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import {
  buildView,
  contribution,
  contributionHandlers,
  contributionMeasure,
  viewHandlers,
} from '../../test/viewFixtures'
import { CellDrawer, type DrawerTarget } from './CellDrawer'

type Row = components['schemas']['ViewRow']
type RecordContributions = components['schemas']['RecordContributions']

const LABELS: Record<string, string> = { '2026-M10': 'Oct 2026', '2026-M11': 'Nov 2026', '2026-M07': 'Jul 2026' }

function targetFor(metricKey: string, subjectId: string, period: string, ytd = false): DrawerTarget {
  const view = buildView(new URLSearchParams(ytd ? { ytd: period } : { periods: period }))
  const row = view.rows.find((r) => r.metricKey === metricKey && r.subjectId === subjectId) as Row
  const cell = row.cells[0] as components['schemas']['Cell']
  return {
    row,
    cell,
    columnLabel: ytd ? 'Year to date through Oct 2026' : (LABELS[period] ?? period),
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

/** Opens the drawer with ver-1's measures derived from records; `respond` answers each contributions request. */
function openDerived(
  target: DrawerTarget,
  respond: (url: URL) => RecordContributions | Response | Promise<RecordContributions | Response>,
) {
  const urls: URL[] = []
  server.use(
    ...contributionHandlers((url) => {
      urls.push(url)
      return respond(url)
    }),
    ...viewHandlers(),
  )
  renderApp(<Harness target={target} />)
  return { urls }
}

/** An on-time epic, a slipped one, and a still-due one, behind both measures of on-time delivery. */
function epicMeasures(over: { closed?: object; total?: object } = {}): RecordContributions {
  const met = contribution()
  const slipped = contribution({
    externalId: 'CHK-102',
    title: 'Address autocomplete',
    url: 'https://tracker.example.test/browse/CHK-102',
    reason: 'slipped',
    dates: { dueAt: '2026-10-10', completedAt: '2026-10-24' },
  })
  const due = contribution({
    externalId: 'CHK-103',
    title: 'Gift cards',
    url: 'https://tracker.example.test/browse/CHK-103',
    state: 'open',
    reason: 'pending',
    amount: 0,
    dates: { dueAt: '2026-10-30' },
  })
  return {
    measures: [
      contributionMeasure({
        measureKey: 'closed',
        recordsValue: 1,
        records: [met, { ...slipped, amount: 0 }, due],
        ...over.closed,
      }),
      contributionMeasure({ measureKey: 'total', recordsValue: 2, records: [met, slipped, due], ...over.total }),
    ],
  }
}

async function recordsRegion() {
  const dialog = await screen.findByRole('dialog')
  return within(dialog).findByRole('region', { name: 'Records behind this result' })
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

describe('CellDrawer records', () => {
  it('lists the records behind each derived measure, with links that open in a new tab', async () => {
    const { urls } = openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () => epicMeasures())
    const region = await recordsRegion()
    expect(await within(region).findAllByText('Derived from 3 records')).toHaveLength(2)
    expect(within(region).getByRole('heading', { name: 'Closed items' })).toBeTruthy()
    expect(within(region).getByRole('heading', { name: 'Total items' })).toBeTruthy()

    const closed = within(region).getByRole('table', { name: 'Closed items: records' })
    const link = within(closed).getByRole('link', { name: 'CHK-101 (opens in a new tab)' })
    expect(link.getAttribute('href')).toBe('https://tracker.example.test/browse/CHK-101')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')

    const rows = within(closed).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    const first = rows[0]?.textContent ?? ''
    expect(first).toContain('Saved cards at checkout')
    expect(first).toContain('Done')
    expect(first).toContain('Due date Oct 20')
    expect(first).toContain('Completed Oct 18')
    expect(first).toContain('Delivered on time')
    expect(first).not.toContain('adds')
    expect(rows[1]?.textContent).toContain('Slipped · adds 0')
    expect(rows[2]?.textContent).toContain('Still due · adds 0')
    expect(rows[2]?.textContent).toContain('Open')

    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      metric: 'on_time_pct',
      subject: 'root',
      period: '2026-M10',
    })
  })

  it("shows a record's contribution when it is not 1, and its priority", async () => {
    openDerived(targetFor('defect_rate', 'root', '2026-M07'), () => ({
      measures: [
        contributionMeasure({
          measureKey: 'defects',
          recordsValue: 65,
          records: [
            contribution({
              externalId: 'CHK-7',
              title: 'Payment page times out',
              priority: 'P1',
              state: 'open',
              reason: 'open_days',
              amount: 64,
              dates: { createdAt: '2026-06-28' },
            }),
            contribution({ externalId: 'CHK-8', title: 'Typo on receipt', priority: 'none', reason: 'open_days' }),
          ],
        }),
      ],
    }))
    const region = await recordsRegion()
    const table = await within(region).findByRole('table', { name: 'Defects: records' })
    const [p1, none] = within(table).getAllByRole('row').slice(1)
    expect(p1?.textContent).toContain('P1')
    expect(p1?.textContent).toContain('adds 64')
    expect(p1?.textContent).toContain('Created Jun 28')
    expect(none?.textContent).toContain('None')
    expect(none?.textContent).not.toContain('adds')
  })

  it('loads the next page with the cursor the API returned', async () => {
    const { urls } = openDerived(targetFor('defect_rate', 'root', '2026-M07'), (url) =>
      url.searchParams.get('cursor') === '100'
        ? {
            measures: [
              contributionMeasure({
                measureKey: 'defects',
                records: [contribution({ externalId: 'CHK-201', title: 'Second page defect' })],
              }),
            ],
          }
        : {
            measures: [contributionMeasure({ measureKey: 'defects', records: [contribution()] })],
            nextCursor: '100',
          },
    )
    const region = await recordsRegion()
    expect(await within(region).findByText('Derived from at least 1 record')).toBeTruthy()
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Load more records' }))
    expect(await within(region).findByText('Second page defect')).toBeTruthy()
    // The button goes away with the last page, so focus moves to the first new record.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Second page defect'))
    expect(urls.map((u) => u.searchParams.get('cursor'))).toEqual([null, '100'])
    expect(within(region).getByText('Derived from 2 records')).toBeTruthy()
    expect(within(region).queryByRole('button', { name: 'Load more records' })).toBeNull()
  })

  it('keeps Load more records as the way to retry when a later page fails', async () => {
    openDerived(targetFor('defect_rate', 'root', '2026-M07'), (url) =>
      url.searchParams.get('cursor') === '100'
        ? HttpResponse.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
        : { measures: [contributionMeasure({ measureKey: 'defects' })], nextCursor: '100' },
    )
    const region = await recordsRegion()
    const more = await within(region).findByRole('button', { name: 'Load more records' })
    await userEvent.setup().click(more)
    expect((await within(region).findByRole('alert')).textContent).toContain('Could not load more records.')
    expect(within(region).getByRole('button', { name: 'Load more records' })).toBe(document.activeElement)
  })

  it('says how far the data runs and how many commitments are still due', async () => {
    openDerived(targetFor('on_time_pct', 'root', '2026-M11'), () =>
      epicMeasures({ closed: { cutoff: '2026-11-14', pending: 2 }, total: { cutoff: '2026-11-14', pending: 2 } }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Through Nov 14')).toBeTruthy()
    expect(within(dialog).getAllByText('2 still due this month')).toHaveLength(1)
  })

  it('says nothing about a cutoff when the records cover the whole month', async () => {
    openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () => epicMeasures())
    const region = await recordsRegion()
    await within(region).findAllByText('Derived from 3 records')
    expect(screen.queryByText(/^Through /)).toBeNull()
    expect(screen.queryByText(/still due/)).toBeNull()
  })

  it('notes when typed values win over what the records give', async () => {
    openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () =>
      epicMeasures({
        closed: { value: 440, source: 'grid', recordsValue: 47 },
        total: { value: 522, source: 'grid', recordsValue: 66 },
      }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Entered · records give 47 / 66')).toBeTruthy()
  })

  it('has no typed-value note when the stored values came from records', async () => {
    openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () =>
      epicMeasures({
        closed: { value: 440, source: 'records', recordsValue: 440 },
        total: { value: 522, source: 'records', recordsValue: 522 },
      }),
    )
    const region = await recordsRegion()
    await within(region).findAllByText('Derived from 3 records')
    expect(screen.queryByText(/^Entered/)).toBeNull()
  })

  it('says when no records were counted', async () => {
    openDerived(targetFor('defect_rate', 'root', '2026-M07'), () => ({
      measures: [contributionMeasure({ measureKey: 'defects', recordsValue: 0, records: [] })],
    }))
    const region = await recordsRegion()
    expect(await within(region).findByText('No records counted in this period')).toBeTruthy()
    expect(within(region).queryByRole('table')).toBeNull()
  })

  it('shows a skeleton while the records load', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    openDerived(targetFor('on_time_pct', 'root', '2026-M10'), async () => {
      await gate
      return epicMeasures()
    })
    const region = await recordsRegion()
    expect(within(region).getByRole('status', { name: 'Loading records' })).toBeTruthy()
    release()
    await within(region).findAllByText('Derived from 3 records')
    expect(within(region).queryByRole('status', { name: 'Loading records' })).toBeNull()
  })

  it('shows a plain error with Retry when the records fail to load', async () => {
    let calls = 0
    openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () => {
      calls++
      return calls === 1
        ? HttpResponse.json({ error: { code: 'internal', message: 'store: scan failed' } }, { status: 500 })
        : epicMeasures()
    })
    const region = await recordsRegion()
    const alert = await within(region).findByRole('alert')
    expect(alert.textContent).toContain('Could not load the records.')
    expect(alert.textContent).not.toContain('store')
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await within(region).findAllByText('Derived from 3 records')).toHaveLength(2)
  })

  it('has no records section for a cell whose measures are entered', async () => {
    open(targetFor('on_time_pct', 'root', '2026-M10'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('FY26 published')
    await within(dialog).findAllByText(/pm@example.test/)
    expect(within(dialog).queryByRole('region', { name: 'Records behind this result' })).toBeNull()
  })

  it('has no records section when the API lists no derived measures', async () => {
    const { urls } = openDerived(targetFor('on_time_pct', 'root', '2026-M10'), () => ({ measures: [] }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(urls).toHaveLength(1))
    await within(dialog).findAllByText(/pm@example.test/)
    await waitFor(() =>
      expect(within(dialog).queryByRole('region', { name: 'Records behind this result' })).toBeNull(),
    )
  })

  it('does not ask for records behind a year-to-date cell', async () => {
    const { urls } = openDerived(targetFor('on_time_pct', 'root', '2026-M10', true), () => epicMeasures())
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('FY26 published')
    expect(urls).toHaveLength(0)
    expect(within(dialog).queryByRole('region', { name: 'Records behind this result' })).toBeNull()
  })

  it('has no accessibility violations with records listed', async () => {
    openDerived(targetFor('on_time_pct', 'root', '2026-M11'), () =>
      epicMeasures({
        closed: { cutoff: '2026-11-14', pending: 1, value: 440, source: 'grid', recordsValue: 47 },
        total: { cutoff: '2026-11-14', pending: 1, value: 522, source: 'grid', recordsValue: 66 },
      }),
    )
    const region = await recordsRegion()
    await within(region).findAllByText('Derived from 3 records')
    const dialog = screen.getByRole('dialog')
    await within(dialog).findByText('FY26 published')
    await within(dialog).findAllByText(/pm@example.test/)
    expect((await axe(dialog)).violations).toEqual([])
  })
})
