import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { MetricSummary, PutMetricSummaryRequest } from '../../api/queries'
import {
  COMPANY,
  conceptsOptional,
  uptimeCompanyAttribution,
  unwritten,
  uptimeLinks,
  uptimeSummary,
  uptimeText,
} from '../../test/rcaFixtures'
import { API, companyUnitsHandler, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { RcaEditForm } from './RcaEditForm'
import { useWhyCard, WhyCardProvider } from './WhyCardProvider'

const LABEL = 'Exec summary for Uptime, Oct 2026'
const PUT_PATH = `${API}/v1/scorecards/sc-main/metric-summaries/uptime/2026-M10`
const missing = unwritten(uptimeSummary)

function renderForm(summary: MetricSummary, extra: { samEnabled?: boolean } = {}) {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  const onDirtyChange = vi.fn()
  const view = renderApp(
    <RcaEditForm
      scorecardId="sc-main"
      summary={summary}
      attribution={uptimeCompanyAttribution}
      samEnabled={extra.samEnabled ?? false}
      onDone={onDone}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
    />,
  )
  return { user: userEvent.setup(), onDone, onCancel, onDirtyChange, ...view }
}

const textbox = () => screen.getByRole('textbox', { name: LABEL })

function capturePut(respond?: (body: PutMetricSummaryRequest) => Response | Promise<Response>) {
  const bodies: PutMetricSummaryRequest[] = []
  server.use(
    http.put(PUT_PATH, async ({ request }) => {
      const body = (await request.json()) as PutMetricSummaryRequest
      bodies.push(body)
      return respond
        ? respond(body)
        : HttpResponse.json({ ...uptimeSummary, text: body.text, links: body.links, linksTotal: body.links.length, revision: body.expectedRevision + 1 })
    }),
  )
  return bodies
}

describe('RcaEditForm: admins only', () => {
  it('renders nothing for someone who cannot edit', () => {
    const { container } = renderForm({ ...uptimeSummary, canEdit: false })
    expect(container.querySelector('form')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('RcaEditForm: text', () => {
  it('labels the text for the metric and month, with the hint', async () => {
    renderForm(missing)
    const box = await screen.findByRole('textbox', { name: LABEL })
    await waitFor(() => expect(document.activeElement).toBe(box))
    expect(
      screen.getByText('Plain text, up to 280 characters, for executives. Say what drove the month and what is not explained.'),
    ).toBeTruthy()
    expect(screen.getByText('Imported incidents and records appear under Attribution; add anything else as a link.')).toBeTruthy()
  })

  it('counts code points of the NFC text', async () => {
    renderForm(missing)
    // An emoji is one code point; a decomposed é is one after NFC.
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: `😀e\u0301${'x'.repeat(210)}` } })
    expect(screen.getByText('212 / 280')).toBeTruthy()
    expect(screen.getByText('212 / 280').getAttribute('aria-live')).toBeNull()
  })

  it('says how far over the limit, announces near it, and disables Save', async () => {
    renderForm(missing)
    const box = await screen.findByRole('textbox', { name: LABEL })
    fireEvent.change(box, { target: { value: 'x'.repeat(265) } })
    expect(screen.getByText('265 / 280').getAttribute('aria-live')).toBe('polite')
    fireEvent.change(box, { target: { value: 'x'.repeat(292) } })
    expect(screen.getByText('12 over').className).toContain('text-status-r')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves the NFC text with revision 0 for a new summary', async () => {
    const bodies = capturePut()
    const { user, onDone } = renderForm(missing)
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: 'Cafe\u0301 vendor outage on Webhooks (INC-2041)' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('saved', expect.objectContaining({ revision: 1 })))
    expect(bodies[0]).toEqual({ text: 'Caf\u00e9 vendor outage on Webhooks (INC-2041)', links: [], expectedRevision: 0 })
  })

  it('asks for text before saving', async () => {
    const bodies = capturePut()
    const { user } = renderForm(missing)
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: '   ' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Write what drove this metric this month')).toBeTruthy()
    expect(textbox().getAttribute('aria-invalid')).toBe('true')
    expect(bodies).toHaveLength(0)
  })

  it('starts from the written text and links', async () => {
    renderForm(uptimeSummary)
    expect(((await screen.findByRole('textbox', { name: LABEL })) as HTMLTextAreaElement).value).toBe(uptimeText)
    expect(screen.getByText('209 / 280')).toBeTruthy()
    expect(screen.getByText('12 / 25 links')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Link 12 title' }) as HTMLInputElement).value).toBe('Search failover review')
  })
})

describe('RcaEditForm: links', () => {
  it('rejects a link that is not https, wired to the field', async () => {
    const { user } = renderForm(missing)
    await user.click(await screen.findByRole('button', { name: 'Add link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link 1 title' }), 'Security review')
    const url = screen.getByRole('textbox', { name: 'Link 1 URL' })
    await user.type(url, 'http://wiki.example/security')
    await user.tab()
    const message = await screen.findByText('Use a link that starts with https://')
    expect(url.getAttribute('aria-invalid')).toBe('true')
    expect(url.getAttribute('aria-describedby')).toContain(message.closest('[id]')!.id)
  })

  it('asks for a title on a link', async () => {
    const { user } = renderForm(missing)
    await user.click(await screen.findByRole('button', { name: 'Add link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link 1 URL' }), 'https://docs.example/a')
    fireEvent.change(textbox(), { target: { value: 'Why' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Add a title for this link')).toBeTruthy()
  })

  it('stops links over 16 KB together', async () => {
    const big = Array.from({ length: 9 }, (_, i) => ({ title: `Doc ${i}`, url: `https://docs.example/${i}/${'a'.repeat(2000)}` }))
    renderForm({ ...uptimeSummary, links: big, linksTotal: big.length })
    expect(await screen.findByText('These links are too long together; shorten or remove some')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides Add link at 25 rows and removes a link with its 32px button', async () => {
    const { user } = renderForm(uptimeSummary)
    for (let i = 0; i < 13; i++) await user.click(await screen.findByRole('button', { name: 'Add link' }))
    // The counter counts links that will be saved, not blank rows (Minor 2).
    expect(screen.getByText('12 / 25 links')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull()
    const remove = screen.getByRole('button', { name: 'Remove link 25' })
    expect(remove.className).toContain('size-8')
    await user.click(remove)
    expect(screen.getByRole('button', { name: 'Add link' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 13 title' }), { target: { value: 'Runbook' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 13 URL' }), { target: { value: 'https://docs.example/runbook' } })
    expect(screen.getByText('13 / 25 links')).toBeTruthy()
  })

  it('counts a blank new row as no link', async () => {
    const { user } = renderForm(missing)
    await user.click(await screen.findByRole('button', { name: 'Add link' }))
    expect(screen.getByText('0 / 25 links')).toBeTruthy()
  })

  it('flags a link listed twice', async () => {
    const { user } = renderForm(uptimeSummary)
    await user.click(await screen.findByRole('button', { name: 'Add link' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 13 title' }), { target: { value: 'Again' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 13 URL' }), { target: { value: uptimeLinks[0]!.url } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This link is already listed')).toBeTruthy()
  })

  it('turns pasted links into rows and counts them', async () => {
    const bodies = capturePut()
    const { user, onDone } = renderForm(missing)
    await user.click(await screen.findByRole('button', { name: 'Paste links' }))
    const box = screen.getByRole('textbox', { name: 'Paste links' })
    await user.click(box)
    await user.paste('https://tracker.example/browse/INC-2041\nhttps://oncall.example/incidents/88412\nhttp://x')
    expect((screen.getByRole('textbox', { name: 'Link 1 title' }) as HTMLInputElement).value).toBe('INC-2041')
    expect((screen.getByRole('textbox', { name: 'Link 2 title' }) as HTMLInputElement).value).toBe('88412')
    expect(screen.getByText('2 / 25 links')).toBeTruthy()
    expect(screen.getByText('1 line not added: http://x is not an https link.')).toBeTruthy()
    fireEvent.change(textbox(), { target: { value: 'Webhooks lost 7h (INC-2041).' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(bodies[0]!.links).toEqual([
      { title: 'INC-2041', url: 'https://tracker.example/browse/INC-2041' },
      { title: '88412', url: 'https://oncall.example/incidents/88412' },
    ])
  })
})

describe('RcaEditForm: races, deletes and drafts (Review Focus 2, 3)', () => {
  it('keeps your text when someone else saved first, and shows theirs on request', async () => {
    const theirs = { ...uptimeSummary, text: 'Theirs: the deploy, then DNS.', links: [], linksTotal: 0, revision: 2 }
    const bodies = capturePut((body) =>
      body.expectedRevision === 1
        ? HttpResponse.json(
            { error: { code: 'conflict', message: 'Someone else changed this exec summary while you were editing.' }, current: theirs },
            { status: 409 },
          )
        : HttpResponse.json({ ...theirs, text: body.text, revision: 3 }),
    )
    const { user, onDone } = renderForm(uptimeSummary)
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: 'Mine: only the deploy.' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Someone else changed this exec summary while you were editing.')).toBeTruthy()
    const yours = screen.getByRole('region', { name: 'Your text' })
    expect(within(yours).getByText('Mine: only the deploy.')).toBeTruthy()
    expect(within(yours).getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()

    await user.click(within(alert).getByRole('button', { name: 'Show theirs' }))
    expect((textbox() as HTMLTextAreaElement).value).toBe('Theirs: the deploy, then DNS.')
    expect(screen.getByText('0 / 25 links')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Your text' })).getByText('Mine: only the deploy.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('saved', expect.objectContaining({ revision: 3 })))
    expect(bodies.map((b) => b.expectedRevision)).toEqual([1, 2])
  })

  it('keeps focus on Save through a 409, holding it with aria-disabled while the save runs', async () => {
    let release = () => {}
    capturePut(async () => {
      await new Promise<void>((r) => (release = r))
      return HttpResponse.json(
        { error: { code: 'conflict', message: 'Someone else changed this exec summary while you were editing.' }, current: uptimeSummary },
        { status: 409 },
      )
    })
    const { user } = renderForm(uptimeSummary)
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: 'Mine: only the deploy.' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    await user.click(save)
    await waitFor(() => expect(save.getAttribute('aria-disabled')).toBe('true'))
    expect(save.disabled).toBe(false)
    expect(document.activeElement).toBe(save)
    release()
    await screen.findByRole('alert')
    expect(document.activeElement).toBe(save)
    expect(save.getAttribute('aria-disabled')).toBeNull()
  })

  it('keeps focus on Draft with SAM while SAM drafts and once the draft is ready', async () => {
    server.use(
      http.post(`${PUT_PATH}/draft`, async () => {
        await delay(50)
        return HttpResponse.json({ id: 'd1', pending: false, text: 'INC-2041 saturated the queue.', createdAt: '2026-11-20T12:00:00Z', warnings: [] }, { status: 202 })
      }),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    const draft = await screen.findByRole('button', { name: 'Draft with SAM' })
    await user.click(draft)
    expect(await screen.findByRole('button', { name: 'Drafting…' })).toBe(draft)
    // A disabled button loses focus in browsers (jsdom keeps it), so it is held with aria-disabled instead.
    expect(draft.getAttribute('aria-disabled')).toBe('true')
    expect((draft as HTMLButtonElement).disabled).toBe(false)
    expect(document.activeElement).toBe(draft)
    await screen.findByRole('region', { name: 'Suggested by SAM' })
    expect(document.activeElement).toBe(draft)
  })

  it('says only admins write exec summaries on a 403', async () => {
    capturePut(() =>
      HttpResponse.json({ error: { code: 'forbidden', message: 'Only admins can write exec summaries.' } }, { status: 403 }),
    )
    const { user } = renderForm(missing)
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: 'Text.' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Only admins can write exec summaries.')).toBeTruthy()
  })

  it('warns that deleting a required summary blocks publishing, and deletes with the revision', async () => {
    let url = ''
    server.use(
      http.delete(PUT_PATH, ({ request }) => {
        url = request.url
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user, onDone } = renderForm(uptimeSummary)
    await user.click(await screen.findByRole('button', { name: 'Delete exec summary' }))
    expect(
      screen.getByText("Delete this exec summary? Oct 2026 can't be published again until a new one is written. The audit log keeps it."),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText(/^Delete this exec summary\?/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete exec summary' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('deleted', null))
    expect(new URL(url).searchParams.get('expectedRevision')).toBe('1')
  })

  it('leaves out the publishing sentence for an optional summary', async () => {
    const { user } = renderForm({ ...conceptsOptional, state: 'written', text: 'On time.', revision: 1 })
    await user.click(await screen.findByRole('button', { name: 'Delete exec summary' }))
    expect(screen.getByText('Delete this exec summary? The audit log keeps it.')).toBeTruthy()
  })

  it('has no Delete for a new summary', async () => {
    renderForm(missing)
    await screen.findByRole('textbox', { name: LABEL })
    expect(screen.queryByRole('button', { name: 'Delete exec summary' })).toBeNull()
  })

  it('puts SAM’s draft in the text only on Use this draft, with Undo, and never saves it', async () => {
    const bodies = capturePut()
    server.use(
      http.post(`${PUT_PATH}/draft`, () =>
        HttpResponse.json(
          { id: 'd1', pending: false, text: 'INC-2041 saturated the queue. 40m is not explained.', createdAt: '2026-11-20T12:00:00Z', warnings: ['INC-9999'] },
          { status: 202 },
        ),
      ),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    await user.click(await screen.findByRole('button', { name: 'Draft with SAM' }))
    const suggestion = await screen.findByRole('region', { name: 'Suggested by SAM' })
    expect(within(suggestion).getByText("from 3 services' attribution")).toBeTruthy()
    expect(
      within(suggestion).getByText('SAM mentioned INC-9999, which is not linked to this metric. Check it before using this draft.'),
    ).toBeTruthy()
    expect((textbox() as HTMLTextAreaElement).value).toBe(uptimeText)
    await user.click(within(suggestion).getByRole('button', { name: 'Use this draft' }))
    expect((textbox() as HTMLTextAreaElement).value).toBe('INC-2041 saturated the queue. 40m is not explained.')
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect((textbox() as HTMLTextAreaElement).value).toBe(uptimeText)
    expect(bodies).toHaveLength(0)
  })

  it('shows Drafting… while SAM writes, and Cancel stops waiting without an error', async () => {
    server.use(
      http.get(`${PUT_PATH}/draft/draft-1`, async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    await user.click(await screen.findByRole('button', { name: 'Draft with SAM' }))
    const drafting = await screen.findByRole('button', { name: 'Drafting…' })
    expect(drafting.getAttribute('aria-disabled')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Cancel draft' }))
    expect(await screen.findByRole('button', { name: 'Draft with SAM' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Suggested by SAM' })).toBeNull()
  })

  it('shows SAM’s failure with a way to its settings', async () => {
    server.use(
      http.post(`${PUT_PATH}/draft`, () =>
        HttpResponse.json({ error: { code: 'conflict', message: 'Save your model key in My settings first.' } }, { status: 409 }),
      ),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    await user.click(await screen.findByRole('button', { name: 'Draft with SAM' }))
    expect(await screen.findByText('Save your model key in My settings first.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'My settings → Ask SAM' }).getAttribute('href')).toBe('/settings/ask-sam')
  })

  it('has no axe violations', async () => {
    renderForm(uptimeSummary, { samEnabled: true })
    const form = await screen.findByRole('form', { name: 'Edit exec summary' })
    expect((await axe(form)).violations).toEqual([])
  })
})

describe('RcaEditForm: focus never drops to the dialog (Important 2)', () => {
  it('returns focus to Paste links when the paste box closes', async () => {
    const { user } = renderForm(missing)
    await user.click(await screen.findByRole('button', { name: 'Paste links' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Paste links' }))
  })

  it('returns focus to Delete exec summary after Keep', async () => {
    const { user } = renderForm(uptimeSummary)
    await user.click(await screen.findByRole('button', { name: 'Delete exec summary' }))
    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete exec summary' }))
  })

  it('moves focus to the next link after Remove link, or to Add link after the last', async () => {
    const { user } = renderForm(uptimeSummary)
    await user.click(await screen.findByRole('button', { name: 'Remove link 1' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Link 1 title' }))
    expect((document.activeElement as HTMLInputElement).value).toBe('INC-2041')
    await user.click(screen.getByRole('button', { name: 'Remove link 11' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add link' }))
  })

  it('moves focus to the text after Show theirs, Undo and Discard', async () => {
    const theirs = { ...uptimeSummary, text: 'Theirs.', links: [], linksTotal: 0, revision: 2 }
    capturePut(() =>
      HttpResponse.json(
        { error: { code: 'conflict', message: 'Someone else changed this exec summary while you were editing.' }, current: theirs },
        { status: 409 },
      ),
    )
    server.use(
      http.post(`${PUT_PATH}/draft`, () =>
        HttpResponse.json({ id: 'd1', pending: false, text: 'Drafted.', createdAt: '2026-11-20T12:00:00Z', warnings: [] }, { status: 202 }),
      ),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    fireEvent.change(await screen.findByRole('textbox', { name: LABEL }), { target: { value: 'Mine.' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await screen.findByRole('button', { name: 'Show theirs' }))
    expect(document.activeElement).toBe(textbox())

    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    await user.click(await screen.findByRole('button', { name: 'Use this draft' }))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(document.activeElement).toBe(textbox())

    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(document.activeElement).toBe(textbox())
  })

  it('returns focus to Draft with SAM after Cancel draft', async () => {
    server.use(
      http.get(`${PUT_PATH}/draft/draft-1`, async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const { user } = renderForm(uptimeSummary, { samEnabled: true })
    await user.click(await screen.findByRole('button', { name: 'Draft with SAM' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel draft' }))
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: 'Draft with SAM' }))
  })

  it('keeps Save and Cancel in view at the bottom of a long form', async () => {
    renderForm(uptimeSummary)
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save.parentElement?.className).toContain('sticky')
  })
})

describe('RcaEditForm in the card', () => {
  beforeEach(() => server.use(companyUnitsHandler))

  function Harness() {
    const why = useWhyCard()
    return (
      <button type="button" onClick={(e) => why.open({ metric: 'uptime', subject: COMPANY, period: '2026-M10' }, e.currentTarget)}>
        Open why
      </button>
    )
  }

  async function openEditor() {
    const user = userEvent.setup()
    renderApp(
      <WhyCardProvider scorecardId="sc-main">
        <Harness />
      </WhyCardProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Open why' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: 'Edit exec summary' }))
    return { user, dialog }
  }

  it('loads every link and the whole text, and keeps the attribution below', async () => {
    const { dialog } = await openEditor()
    const box = await within(dialog).findByRole('textbox', { name: LABEL })
    expect((box as HTMLTextAreaElement).value).toBe(uptimeText)
    expect(within(dialog).getByText('12 / 25 links')).toBeTruthy()
    expect(within(dialog).getByText('Why · Oct 2026 · Editing')).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: 'Attribution' })).toBeTruthy()
  })

  it('asks before discarding changes on Escape and Close', async () => {
    const { user, dialog } = await openEditor()
    fireEvent.change(await within(dialog).findByRole('textbox', { name: LABEL }), { target: { value: 'Changed my mind.' } })
    await user.keyboard('{Escape}')
    expect(within(dialog).getByText('Discard your changes?')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect((within(dialog).getByRole('textbox', { name: LABEL }) as HTMLTextAreaElement).value).toBe('Changed my mind.')
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: LABEL }))
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes without asking when nothing changed', async () => {
    const { user, dialog } = await openEditor()
    await within(dialog).findByRole('textbox', { name: LABEL })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('announces the save and returns to the card', async () => {
    capturePut()
    const { user, dialog } = await openEditor()
    fireEvent.change(await within(dialog).findByRole('textbox', { name: LABEL }), { target: { value: 'Webhooks lost 7h (INC-2041).' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Exec summary saved')).toBeTruthy()
    expect(within(dialog).queryByRole('textbox', { name: LABEL })).toBeNull()
  })
})
