import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { CellRca } from '../../api/queries'
import type { components } from '../../api/schema'
import { epicsRca, webhooksNote, webhooksRca } from '../../test/rcaFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { RcaEditForm } from './RcaEditForm'
import { useWhyCard, WhyCardProvider } from './WhyCardProvider'

type PutBody = components['schemas']['PutCellRcaRequest']

function renderForm(rca: CellRca, extra: { samEnabled?: boolean } = {}) {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  const onDirtyChange = vi.fn()
  renderApp(
    <RcaEditForm
      scorecardId="sc-main"
      rca={rca}
      samEnabled={extra.samEnabled ?? false}
      onDone={onDone}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
    />,
  )
  const textarea = screen.getByRole('textbox', { name: 'What caused the gap?' })
  return { user: userEvent.setup(), textarea, onDone, onCancel, onDirtyChange }
}

function capturePut(respond?: (body: PutBody) => Response) {
  const bodies: PutBody[] = []
  server.use(
    http.put(`${API}/v1/scorecards/sc-main/rca`, async ({ request }) => {
      const body = (await request.json()) as PutBody
      bodies.push(body)
      return respond ? respond(body) : HttpResponse.json({ ...webhooksNote, text: body.text, links: body.links, revision: body.expectedRevision + 1 })
    }),
  )
  return bodies
}

describe('RcaEditForm: text', () => {
  it('focuses the text and counts code points of the NFC text', async () => {
    const { textarea } = renderForm(epicsRca)
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    // An emoji is one code point; a decomposed é is one after NFC.
    fireEvent.change(textarea, { target: { value: `😀e\u0301${'x'.repeat(119)}` } })
    expect(screen.getByText('121 / 280')).toBeTruthy()
    expect(screen.getByText('121 / 280').getAttribute('aria-live')).toBeNull()
  })

  it('says how far over the limit, announces near it, and disables Save', async () => {
    const { textarea } = renderForm(epicsRca)
    fireEvent.change(textarea, { target: { value: 'x'.repeat(265) } })
    expect(screen.getByText('265 / 280').getAttribute('aria-live')).toBe('polite')
    fireEvent.change(textarea, { target: { value: 'x'.repeat(292) } })
    const over = screen.getByText('12 over')
    expect(over.className).toContain('text-status-r')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the text normalized to NFC, with the cell and revision 0 for a new note', async () => {
    const bodies = capturePut()
    const { user, textarea, onDone } = renderForm(epicsRca)
    fireEvent.change(textarea, { target: { value: 'Cafe\u0301 vendor slipped CHK-233' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('saved', expect.objectContaining({ revision: 1 })))
    expect(bodies[0]).toEqual({
      metric: 'epics_on_time',
      subject: 'checkout',
      period: '2026-M10',
      text: 'Caf\u00e9 vendor slipped CHK-233',
      links: [],
      expectedRevision: 0,
    })
  })

  it('asks for text before saving', async () => {
    const bodies = capturePut()
    const { user, textarea } = renderForm(epicsRca)
    fireEvent.change(textarea, { target: { value: '   ' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Write what caused the gap')).toBeTruthy()
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
    expect(bodies).toHaveLength(0)
  })
})

describe('RcaEditForm: links', () => {
  it('rejects a link that is not https, wired to the field', async () => {
    const { user } = renderForm(epicsRca)
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link 1 title' }), 'Security review')
    const url = screen.getByRole('textbox', { name: 'Link 1 URL' })
    await user.type(url, 'http://wiki.example/security')
    await user.tab()
    const message = await screen.findByText('Use a link that starts with https://')
    expect(url.getAttribute('aria-invalid')).toBe('true')
    expect(url.getAttribute('aria-describedby')).toContain(message.closest('[id]')!.id)
  })

  it('asks for a title on a link', async () => {
    const { user } = renderForm(epicsRca)
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link 1 URL' }), 'https://docs.example/a')
    fireEvent.change(screen.getByRole('textbox', { name: 'What caused the gap?' }), { target: { value: 'Why' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Add a title for this link')).toBeTruthy()
  })

  it('stops links that are too long together', async () => {
    const { user } = renderForm(epicsRca)
    const long = `https://docs.example/${'a'.repeat(2000)}`
    for (const n of [1, 2, 3]) {
      await user.click(screen.getByRole('button', { name: 'Add link' }))
      fireEvent.change(screen.getByRole('textbox', { name: `Link ${n} title` }), { target: { value: `Doc ${n}` } })
      fireEvent.change(screen.getByRole('textbox', { name: `Link ${n} URL` }), { target: { value: `${long}${n}` } })
    }
    expect(screen.getByText('These links are too long together; shorten or remove one')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides Add link at five links and removes a link with its 32px button', async () => {
    const { user } = renderForm(epicsRca)
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: 'Add link' }))
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull()
    const remove = screen.getByRole('button', { name: 'Remove link 5' })
    expect(remove.className).toContain('size-8')
    await user.click(remove)
    expect(screen.getByRole('button', { name: 'Add link' })).toBeTruthy()
  })

  it('flags a link listed twice', async () => {
    const { user } = renderForm({ ...webhooksRca })
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 2 title' }), { target: { value: 'Again' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Link 2 URL' }), { target: { value: webhooksNote.links[0]!.url } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This link is already listed')).toBeTruthy()
  })
})

describe('RcaEditForm: races and drafts (Review Focus 5)', () => {
  it('keeps your text when someone else saved first, and shows theirs on request', async () => {
    const theirs = { ...webhooksNote, text: 'Theirs: the deploy, then DNS.', revision: 2, authorName: 'Casey Contributor' }
    const bodies = capturePut((body) =>
      body.expectedRevision === 1
        ? HttpResponse.json(
            { error: { code: 'conflict', message: 'Someone else changed this RCA while you were editing.' }, current: theirs },
            { status: 409 },
          )
        : HttpResponse.json({ ...theirs, text: body.text, revision: 3 }),
    )
    const { user, textarea, onDone } = renderForm(webhooksRca)
    fireEvent.change(textarea, { target: { value: 'Mine: only the deploy.' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Someone else changed this RCA while you were editing.')).toBeTruthy()
    const yours = screen.getByRole('region', { name: 'Your text' })
    expect(within(yours).getByText('Mine: only the deploy.')).toBeTruthy()
    expect(within(yours).getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()

    await user.click(within(alert).getByRole('button', { name: 'Show theirs' }))
    expect((textarea as HTMLTextAreaElement).value).toBe('Theirs: the deploy, then DNS.')
    expect(within(screen.getByRole('region', { name: 'Your text' })).getByText('Mine: only the deploy.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('saved', expect.objectContaining({ revision: 3 })))
    expect(bodies.map((b) => b.expectedRevision)).toEqual([1, 2])
  })

  it('puts SAM’s draft in the text only on Use this draft, with Undo, and never saves it', async () => {
    const bodies = capturePut()
    server.use(
      http.post(`${API}/v1/scorecards/sc-main/rca/draft`, () =>
        HttpResponse.json(
          { id: 'd1', pending: false, text: 'INC-2041 saturated the queue. 0.09 pts not explained.', createdAt: '2026-11-20T12:00:00Z', warnings: [] },
          { status: 202 },
        ),
      ),
    )
    const { user, textarea } = renderForm(webhooksRca, { samEnabled: true })
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    const suggestion = await screen.findByRole('region', { name: 'Suggested by SAM' })
    expect(within(suggestion).getByText('from 3 incidents and the remainder')).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).value).toBe(webhooksNote.text)
    await user.click(within(suggestion).getByRole('button', { name: 'Use this draft' }))
    expect((textarea as HTMLTextAreaElement).value).toBe('INC-2041 saturated the queue. 0.09 pts not explained.')
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect((textarea as HTMLTextAreaElement).value).toBe(webhooksNote.text)
    expect(bodies).toHaveLength(0)
  })

  it('shows Drafting… while SAM writes, and Cancel stops waiting without an error', async () => {
    server.use(
      http.get(`${API}/v1/scorecards/sc-main/rca/draft/draft-1`, async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const { user } = renderForm(webhooksRca, { samEnabled: true })
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    const drafting = await screen.findByRole('button', { name: 'Drafting…' })
    expect((drafting as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Cancel draft' }))
    expect(await screen.findByRole('button', { name: 'Draft with SAM' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Suggested by SAM' })).toBeNull()
  })

  it('warns about keys SAM named that are not linked to the cell', async () => {
    server.use(
      http.post(`${API}/v1/scorecards/sc-main/rca/draft`, () =>
        HttpResponse.json(
          { id: 'd1', pending: false, text: 'INC-9999 caused it.', createdAt: '2026-11-20T12:00:00Z', warnings: ['INC-9999'] },
          { status: 202 },
        ),
      ),
    )
    const { user } = renderForm(webhooksRca, { samEnabled: true })
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    expect(
      await screen.findByText('SAM mentioned INC-9999, which is not linked to this cell. Check it before using this draft.'),
    ).toBeTruthy()
  })

  it('shows SAM’s failure with a way to its settings', async () => {
    server.use(
      http.post(`${API}/v1/scorecards/sc-main/rca/draft`, () =>
        HttpResponse.json({ error: { code: 'conflict', message: 'Save your model key in My settings first.' } }, { status: 409 }),
      ),
    )
    const { user } = renderForm(webhooksRca, { samEnabled: true })
    await user.click(screen.getByRole('button', { name: 'Draft with SAM' }))
    expect(await screen.findByText('Save your model key in My settings first.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'My settings → Ask SAM' }).getAttribute('href')).toBe('/settings/ask-sam')
  })

  it('asks before deleting, with two buttons, and deletes with the revision', async () => {
    let query = ''
    server.use(
      http.delete(`${API}/v1/scorecards/sc-main/rca`, ({ request }) => {
        query = new URL(request.url).search
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user, onDone } = renderForm(webhooksRca)
    await user.click(screen.getByRole('button', { name: 'Delete RCA' }))
    expect(screen.getByText('Delete this RCA? It is removed for everyone; the audit log keeps it.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText(/^Delete this RCA\?/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete RCA' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('deleted', null))
    expect(new URLSearchParams(query).get('expectedRevision')).toBe('1')
  })

  it('has no Delete RCA for a new note', () => {
    renderForm(epicsRca)
    expect(screen.queryByRole('button', { name: 'Delete RCA' })).toBeNull()
  })

  it('has no axe violations', async () => {
    renderForm(webhooksRca, { samEnabled: true })
    const form = screen.getByRole('form', { name: 'Edit RCA' })
    expect((await axe(form)).violations).toEqual([])
  })
})

describe('RcaEditForm in the card', () => {
  function Harness() {
    const why = useWhyCard()
    return (
      <button type="button" onClick={(e) => why.open({ metric: 'uptime', subject: 'webhooks', period: '2026-M10' }, e.currentTarget)}>
        Open why
      </button>
    )
  }

  it('asks before discarding changes on Escape and Close', async () => {
    const user = userEvent.setup()
    renderApp(
      <WhyCardProvider scorecardId="sc-main">
        <Harness />
      </WhyCardProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Open why' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: 'Edit' }))
    expect(within(dialog).getByText('Why · Oct 2026 · Editing')).toBeTruthy()
    const textarea = within(dialog).getByRole('textbox', { name: 'What caused the gap?' })
    fireEvent.change(textarea, { target: { value: 'Changed my mind.' } })

    await user.keyboard('{Escape}')
    expect(within(dialog).getByText('Discard your changes?')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect((within(dialog).getByRole('textbox', { name: 'What caused the gap?' }) as HTMLTextAreaElement).value).toBe(
      'Changed my mind.',
    )

    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes without asking when nothing changed', async () => {
    const user = userEvent.setup()
    renderApp(
      <WhyCardProvider scorecardId="sc-main">
        <Harness />
      </WhyCardProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Open why' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: 'Edit' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
