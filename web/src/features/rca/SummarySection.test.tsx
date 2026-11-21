import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { MetricSummary, RcaCellRef } from '../../api/queries'
import {
  conceptsOptional,
  COMPANY,
  deploymentMissing,
  hostileSummary,
  securityMissing,
  spendStale,
  summaryDraftDone,
  unwritten,
  uptimeCardSummary,
  uptimeCompanyAttribution,
  uptimeLinks,
  uptimeSummary,
  uptimeText,
} from '../../test/rcaFixtures'
import { API, companyUnitsHandler, server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { SummarySection, type SummarySectionProps } from './SummarySection'
import { useWhyCard, WhyCardProvider } from './WhyCardProvider'

function renderSection(summary: MetricSummary, extra: Partial<SummarySectionProps> = {}) {
  const onWrite = vi.fn()
  const onDraft = vi.fn()
  const onConfirm = vi.fn()
  renderApp(
    <WhyCardProvider scorecardId="sc-main">
      <SummarySection
        scorecardId="sc-main"
        summary={summary}
        context={false}
        samEnabled
        onWrite={onWrite}
        onDraft={onDraft}
        onConfirm={onConfirm}
        {...extra}
      />
    </WhyCardProvider>,
  )
  return { user: userEvent.setup(), onWrite, onDraft, onConfirm }
}

const firstThree: MetricSummary = { ...uptimeSummary, links: uptimeLinks.slice(0, 3) }
const asReader = (s: MetricSummary): MetricSummary => ({ ...s, canEdit: false })

describe('SummarySection: written', () => {
  it('shows the text, the byline and the first 3 of 12 links', async () => {
    renderSection(firstThree)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    const text = within(section).getByText(uptimeText)
    expect(text.getAttribute('dir')).toBe('auto')
    expect(within(section).getByText('Avery Admin · Nov 2')).toBeTruthy()
    const links = within(section).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'Postmortem: webhook queue saturation (opens in a new tab)',
      'INC-2041 (opens in a new tab)',
      'INC-2047 (opens in a new tab)',
    ])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(within(section).getAllByText('docs.example').length).toBeGreaterThan(0)
    const more = within(section).getByRole('button', { name: 'Show all 12 links' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands to all 12 links in place, announces it, and collapses again', async () => {
    const { user } = renderSection(firstThree)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    const more = within(section).getByRole('button', { name: 'Show all 12 links' })
    await user.click(more)
    await waitFor(() => expect(within(section).getAllByRole('link')).toHaveLength(12))
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.textContent).toBe('Show fewer')
    expect(document.activeElement).toBe(more)
    expect(await screen.findByText('Showing 12 links')).toBeTruthy()
    await user.click(more)
    expect(within(section).getAllByRole('link')).toHaveLength(3)
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows an excerpt with More, which loads the whole text', async () => {
    const { user } = renderSection(uptimeCardSummary)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText(uptimeCardSummary.text!)).toBeTruthy()
    const more = within(section).getByRole('button', { name: 'More' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await user.click(more)
    const whole = await within(section).findByText(uptimeText)
    expect(within(section).queryByRole('button', { name: 'More' })).toBeNull()
    // More is gone, so focus moves to the text it revealed rather than dropping to the dialog.
    await waitFor(() => expect(document.activeElement).toBe(whole))
    expect(whole.getAttribute('tabindex')).toBe('-1')
  })

  it('labels the section with the metric and period on a child cell’s card', async () => {
    renderSection(firstThree, { context: true })
    expect(await screen.findByRole('region', { name: 'Exec summary · Uptime · Oct 2026' })).toBeTruthy()
  })

  it('renders hostile text and titles as text, and http links as text', async () => {
    renderSection(hostileSummary)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('<b>bold</b> and **not markdown**')).toBeTruthy()
    expect(section.querySelector('b')).toBeNull()
    expect(within(section).getByText('xn--bcher-kva.example')).toBeTruthy()
    expect(within(section).queryByRole('link', { name: /Old wiki/ })).toBeNull()
    expect(within(section).getByText('Old wiki')).toBeTruthy()
    expect(within(section).getByRole('link', { name: '<img src=x onerror=alert(1)> (opens in a new tab)' })).toBeTruthy()
    expect(section.querySelector('img')).toBeNull()
  })
})

describe('SummarySection: stale', () => {
  it('lists the reasons; admins get Edit and Still accurate', async () => {
    const { user, onWrite, onConfirm } = renderSection(spendStale)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('This exec summary may be out of date.')).toBeTruthy()
    expect(within(section).getByText('The value changed from 102% to 104%.')).toBeTruthy()
    expect(within(section).getByText('1 more product is over plan: Billing.')).toBeTruthy()
    expect(within(section).getByText('Avery Admin · Oct 30 · via MCP')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Edit' }))
    await user.click(within(section).getByRole('button', { name: 'Still accurate' }))
    expect(onWrite).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('shows readers the reasons without the buttons', async () => {
    renderSection(asReader(spendStale))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('The value changed from 102% to 104%.')).toBeTruthy()
    expect(within(section).queryByRole('button')).toBeNull()
  })
})

describe('SummarySection: missing (required)', () => {
  it('tells an admin what is missing and why, with Write exec summary and Draft with SAM', async () => {
    const { user, onWrite, onDraft } = renderSection(unwritten(uptimeSummary))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('No exec summary yet for Uptime, Oct 2026.')).toBeTruthy()
    expect(
      within(section).getByText(
        "It is required because 13 of 21 services are below 100% (worst Webhooks 99.06%). The month can't be published until it is written.",
      ),
    ).toBeTruthy()
    const write = within(section).getByRole('button', { name: 'Write exec summary' })
    expect(write.className).toContain('h-8')
    await user.click(write)
    await user.click(within(section).getByRole('button', { name: 'Draft with SAM' }))
    expect(onWrite).toHaveBeenCalledOnce()
    expect(onDraft).toHaveBeenCalledOnce()
    expect(within(section).queryByText('Product ops writes this summary.')).toBeNull()
  })

  it('offers no SAM draft when SAM is off', async () => {
    renderSection(unwritten(uptimeSummary), { samEnabled: false })
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByRole('button', { name: 'Write exec summary' })).toBeTruthy()
    expect(within(section).queryByRole('button', { name: 'Draft with SAM' })).toBeNull()
  })

  it.each(['contributor', 'viewer'])('tells a %s the same, says who writes it, and offers no buttons', async () => {
    renderSection(asReader(unwritten(uptimeSummary)))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('No exec summary yet for Uptime, Oct 2026.')).toBeTruthy()
    expect(within(section).getByText(/^It is required because 13 of 21 services are below 100%/)).toBeTruthy()
    expect(within(section).getByText('Product ops writes this summary.')).toBeTruthy()
    expect(within(section).queryByRole('button')).toBeNull()
  })

  it('words a status reason and a below-100% reason', async () => {
    renderSection(deploymentMissing)
    expect(
      await screen.findByText("It is required because it is Red (99.63%). The month can't be published until it is written."),
    ).toBeTruthy()
  })

  it('words a Green-below-100% reason', async () => {
    renderSection(securityMissing)
    expect(
      await screen.findByText("It is required because it is below 100% (94%). The month can't be published until it is written."),
    ).toBeTruthy()
  })

  it('uses a quieter block on a child cell’s card, with the same copy and actions', async () => {
    renderSection(unwritten(uptimeSummary), { context: true })
    const section = await screen.findByRole('region', { name: 'Exec summary · Uptime · Oct 2026' })
    expect(section.className).not.toContain('bg-status-r-bg')
    expect(section.className).toContain('bg-ink/[0.035]')
    expect(within(section).getByText('No exec summary yet for Uptime, Oct 2026.')).toBeTruthy()
    expect(within(section).getByRole('button', { name: 'Write exec summary' })).toBeTruthy()
  })

  it('keeps the red block on the company card', async () => {
    renderSection(unwritten(uptimeSummary))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(section.className).toContain('bg-status-r-bg')
  })

  it('has no axe violations', async () => {
    renderSection(unwritten(uptimeSummary))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect((await axe(section)).violations).toEqual([])
  })
})

describe('SummarySection: optional', () => {
  it('says it is not required; admins can add one', async () => {
    const { user, onWrite } = renderSection(conceptsOptional)
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('No exec summary (not required: 100% this month).')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Add one' }))
    expect(onWrite).toHaveBeenCalledOnce()
  })

  it('offers readers no button', async () => {
    renderSection(asReader(conceptsOptional))
    const section = await screen.findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('No exec summary (not required: 100% this month).')).toBeTruthy()
    expect(within(section).queryByRole('button')).toBeNull()
  })
})

describe('SummarySection: nothing stands in for a missing summary (Review Focus 3)', () => {
  beforeEach(() => server.use(companyUnitsHandler))

  function Harness({ cell }: { cell: RcaCellRef }) {
    const why = useWhyCard()
    return (
      <button type="button" onClick={(e) => why.open(cell, e.currentTarget)}>
        Open why
      </button>
    )
  }

  it('shows no SAM draft in the section after drafting and cancelling', async () => {
    server.use(
      http.post(`${API}/v1/scorecards/sc-main/metric-summaries/deployment_uptime/2026-M10/draft`, () =>
        HttpResponse.json({ ...summaryDraftDone, text: 'SAM says the relay failover stalled.' }, { status: 202 }),
      ),
    )
    const user = userEvent.setup()
    renderApp(
      <WhyCardProvider scorecardId="sc-main">
        <Harness cell={{ metric: 'deployment_uptime', subject: 'notification-relay', period: '2026-M10' }} />
      </WhyCardProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Open why' }))
    const dialog = await screen.findByRole('dialog')
    const section = await within(dialog).findByRole('region', { name: /^Exec summary/ })
    await user.click(await within(section).findByRole('button', { name: 'Draft with SAM' }))
    const suggestion = await within(dialog).findByRole('region', { name: 'Suggested by SAM' })
    expect(within(suggestion).getByText('SAM says the relay failover stalled.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    const after = await within(dialog).findByRole('region', { name: /^Exec summary/ })
    expect(within(after).getByText('No exec summary yet for Deployment uptime, Oct 2026.')).toBeTruthy()
    expect(within(dialog).queryByText(/SAM says/)).toBeNull()
  })

  it('shows a viewer the missing slot and nothing else', async () => {
    state.role = 'viewer'
    const user = userEvent.setup()
    renderApp(
      <WhyCardProvider scorecardId="sc-main">
        <Harness cell={{ metric: 'uptime', subject: COMPANY, period: '2026-M10' }} />
      </WhyCardProvider>,
    )
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/attribution`, () =>
        HttpResponse.json({ ...uptimeCompanyAttribution, summary: asReader(unwritten(uptimeSummary)) }),
      ),
    )
    await user.click(await screen.findByRole('button', { name: 'Open why' }))
    const dialog = await screen.findByRole('dialog')
    const section = await within(dialog).findByRole('region', { name: 'Exec summary' })
    expect(within(section).getByText('Product ops writes this summary.')).toBeTruthy()
    expect(within(section).queryByText(/13 of 21 services below 100% · worst/)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /exec summary|Draft with SAM/i })).toBeNull()
  })
})
