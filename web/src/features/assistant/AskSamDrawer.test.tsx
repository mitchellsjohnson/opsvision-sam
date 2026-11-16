import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import {
  assistantHandlers,
  message,
  newAssistantSeen,
  thread,
  type AssistantFakeOptions,
} from '../../test/assistantFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'

const OVERVIEW = '/scorecards/sc-main/overview?period=2026-M10&scope=unit-a'
const POLL = { timeout: 4000 }

function renderWithSam(route = OVERVIEW, options: AssistantFakeOptions = {}) {
  const seen = options.seen ?? newAssistantSeen()
  server.use(...viewHandlers(), ...assistantHandlers({ last4: 'x9Q2', ...options, seen }))
  renderApp(<App />, { route })
  return seen
}

async function openFromControlBar() {
  await screen.findByRole('heading', { name: 'Overview', level: 1 })
  const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
  const user = userEvent.setup()
  await user.click(within(bar).getByRole('button', { name: 'Ask SAM' }))
  const drawer = await screen.findByRole('dialog', { name: 'Ask SAM' })
  return { user, drawer }
}

async function composer(drawer: HTMLElement) {
  return (await within(drawer).findByRole('textbox', { name: 'Ask SAM a question' })) as HTMLTextAreaElement
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const originalMatchMedia = window.matchMedia
afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe('Ask SAM drawer', () => {
  it('opens from the control bar with the owl, the context chip and starters', async () => {
    renderWithSam()
    const { drawer } = await openFromControlBar()
    expect(drawer.querySelector('img[data-sam]')).toBeTruthy()
    expect(await within(drawer).findByText('Oct 2026 · Unit A')).toBeTruthy()
    expect(await within(drawer).findByRole('button', { name: 'What needs attention in Unit A?' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'Summarize Oct 2026' })).toBeTruthy()
    expect(document.activeElement).toBe(await composer(drawer))
  })

  it('opens from the chart dialog about that metric', async () => {
    renderWithSam(`${OVERVIEW}&focus=on_time_pct`)
    const focus = await screen.findByRole('dialog', { name: /On-time delivery/ })
    const user = userEvent.setup()
    const ask = within(focus).getByRole('button', { name: 'Ask SAM' })
    expect((ask as HTMLButtonElement).disabled).toBe(false)
    await user.click(ask)
    const drawer = await screen.findByRole('dialog', { name: 'Ask SAM' })
    expect(await within(drawer).findByText('Oct 2026 · Unit A · On-time delivery')).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'How is On-time delivery measured?' })).toBeTruthy()
    // Over the chart dialog, SAM is modal too, so its scroll and focus work.
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
    expect(screen.getByRole('dialog', { name: /On-time delivery/ })).toBeTruthy()
    expect(document.activeElement).toBe(ask)
  })

  it('sends the question with the context, shows SAM thinking, then announces the reply', async () => {
    const seen = renderWithSam()
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Why is on-time delivery yellow?{Enter}')
    await waitFor(() => expect(seen.posts).toHaveLength(1))
    expect(seen.threadCreates).toEqual([
      { context: { page: 'overview', scorecardId: 'sc-main', period: '2026-M10', scope: 'unit-a' } },
    ])
    expect(seen.posts[0]!.body).toEqual({
      text: 'Why is on-time delivery yellow?',
      context: { page: 'overview', scorecardId: 'sc-main', period: '2026-M10', scope: 'unit-a' },
    })
    expect(await within(drawer).findByText('SAM is looking into it')).toBeTruthy()
    expect((await composer(drawer)).value).toBe('')
    expect(await within(drawer).findByText('84.3%', {}, POLL)).toBeTruthy()
    expect(within(drawer).queryByText('SAM is looking into it')).toBeNull()
    expect(within(drawer).getByText('claude-haiku-5-5 · 1,234 in · 56 out tokens')).toBeTruthy()
    const live = within(drawer).getByTestId('sam-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('SAM replied: On-time delivery is 84.3% in Oct 2026.')
    expect((await axe(drawer)).violations).toEqual([])
  })

  it('stops polling once the answer is in', async () => {
    const seen = renderWithSam()
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Hello{Enter}')
    await within(drawer).findByText('84.3%', {}, POLL)
    const reads = seen.threadGets
    await sleep(1800)
    expect(seen.threadGets).toBe(reads)
  })

  it('stops polling when the drawer closes', async () => {
    const seen = renderWithSam(OVERVIEW, { pendingReads: 99 })
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Hello{Enter}')
    await within(drawer).findByText('SAM is looking into it')
    await user.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
    const reads = seen.threadGets
    await sleep(1800)
    expect(seen.threadGets).toBe(reads)
  })

  it('keeps the chat on screen when a background poll fails, and recovers', async () => {
    renderWithSam(OVERVIEW, { pendingReads: 99 })
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Hello{Enter}')
    await within(drawer).findByText('SAM is looking into it')
    let failing = true
    server.use(
      http.get(`${API}/v1/assistant/threads/:id`, () =>
        failing ? HttpResponse.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 }) : undefined,
      ),
    )
    expect(await within(drawer).findByText('Lost connection to SAM. Retrying…', {}, POLL)).toBeTruthy()
    expect(within(drawer).getByText('Hello')).toBeTruthy()
    expect(within(drawer).getByText('SAM is looking into it')).toBeTruthy()
    expect(within(drawer).queryByText(/Could not load this chat/)).toBeNull()
    failing = false
    await waitFor(() => expect(within(drawer).queryByText('Lost connection to SAM. Retrying…')).toBeNull(), POLL)
    expect(within(drawer).getByText('Hello')).toBeTruthy()
  })

  it('keeps a first question asked just before closing, and shows it on reopening', async () => {
    const seen = renderWithSam()
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.post(`${API}/v1/assistant/threads/:id/messages`, async () => {
        await gate
        return undefined
      }),
    )
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Hello{Enter}')
    await waitFor(() => expect(seen.threadCreates).toHaveLength(1))
    await user.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
    release()
    await waitFor(() => expect(seen.posts).toHaveLength(1))
    await openFromControlBar()
    const reopened = screen.getByRole('dialog', { name: 'Ask SAM' })
    expect(await within(reopened).findByText('Hello')).toBeTruthy()
    expect(await within(reopened).findByText('84.3%', {}, POLL)).toBeTruthy()
    expect(seen.threadCreates).toHaveLength(1)
  })

  it('retries a failed first question in the chat it already started', async () => {
    const seen = renderWithSam()
    let refused = false
    server.use(
      http.post(`${API}/v1/assistant/threads/:id/messages`, () => {
        if (refused) return undefined
        refused = true
        return HttpResponse.json(
          { error: { code: 'unavailable', message: 'The provider could not be reached; try again later.' } },
          { status: 503 },
        )
      }),
    )
    const { user, drawer } = await openFromControlBar()
    const box = await composer(drawer)
    await user.type(box, 'Hello{Enter}')
    expect((await within(drawer).findByRole('alert')).textContent).toContain('The provider could not be reached')
    await user.type(box, '{Enter}')
    await waitFor(() => expect(seen.posts).toHaveLength(1))
    expect(seen.threadCreates).toHaveLength(1)
    expect(seen.posts[0]!.threadId).toBe('th-new-1')
    expect(await within(drawer).findByText('84.3%', {}, POLL)).toBeTruthy()
  })

  it('stops polling a pending chat once you switch away from it', async () => {
    const seen = renderWithSam(OVERVIEW, {
      threads: [
        thread({
          id: 'th-busy',
          title: 'Busy',
          messages: [message({ id: 'q', text: 'Earlier' }), message({ id: 'a', role: 'assistant', status: 'pending' })],
        }),
        thread({
          id: 'th-old',
          title: 'Settled',
          messages: [message({ id: 'q1', text: 'Before' }), message({ id: 'a1', role: 'assistant', text: 'Done.' })],
        }),
      ],
      pendingReads: 99,
    })
    const { user, drawer } = await openFromControlBar()
    await user.click(within(drawer).getByRole('button', { name: 'Recent chats' }))
    await user.click(await screen.findByRole('menuitem', { name: /Busy/ }))
    await within(drawer).findByText('SAM is looking into it')
    const busyReads = () => seen.threadGetIds.filter((id) => id === 'th-busy').length
    await waitFor(() => expect(busyReads()).toBeGreaterThanOrEqual(2), POLL)
    await user.click(within(drawer).getByRole('button', { name: 'Recent chats' }))
    await user.click(await screen.findByRole('menuitem', { name: /Settled/ }))
    expect(await within(drawer).findByText('Done.')).toBeTruthy()
    const reads = busyReads()
    await sleep(1800)
    expect(busyReads()).toBe(reads)
  })

  it('stays open beside the page when Escape is pressed outside it', async () => {
    renderWithSam()
    const { user, drawer } = await openFromControlBar()
    const bar = screen.getByRole('toolbar', { name: 'Scorecard controls' })
    act(() => within(bar).getByRole('button', { name: 'Ask SAM' }).focus())
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Ask SAM' })).toBe(drawer)
    act(() => within(drawer).getByRole('textbox', { name: 'Ask SAM a question' }).focus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
  })

  it('uses Shift+Enter for a new line and starters to ask', async () => {
    const seen = renderWithSam()
    const { user, drawer } = await openFromControlBar()
    const box = await composer(drawer)
    await user.type(box, 'Line one{Shift>}{Enter}{/Shift}Line two')
    expect(box.value).toBe('Line one\nLine two')
    expect(seen.posts).toHaveLength(0)
    await user.clear(box)
    await user.click(within(drawer).getByRole('button', { name: 'Summarize Oct 2026' }))
    await waitFor(() => expect(seen.posts.map((p) => (p.body as { text: string }).text)).toEqual(['Summarize Oct 2026']))
  })

  it('does not send a second question while SAM is answering', async () => {
    const seen = renderWithSam(OVERVIEW, { pendingReads: 99 })
    const { user, drawer } = await openFromControlBar()
    const box = await composer(drawer)
    await user.type(box, 'First{Enter}')
    await within(drawer).findByText('SAM is looking into it')
    await user.type(box, 'Second{Enter}')
    expect((within(drawer).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(box.value).toBe('Second')
    expect(seen.posts).toHaveLength(1)
    expect(within(drawer).getAllByText('SAM is looking into it')).toHaveLength(1)
  })

  it('shows an error answer with a retry that asks again', async () => {
    const seen = renderWithSam(OVERVIEW, {
      replies: [{ error: 'Claude is rate limiting your key. Try again in a minute.' }, { text: 'Second time lucky.' }],
    })
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Why?{Enter}')
    expect(await within(drawer).findByText('Claude is rate limiting your key. Try again in a minute.', {}, POLL)).toBeTruthy()
    expect(within(drawer).getByTestId('sam-live').textContent).toBe(
      'SAM couldn’t answer. Claude is rate limiting your key. Try again in a minute.',
    )
    await user.click(within(drawer).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(seen.posts).toHaveLength(2))
    expect((seen.posts[1]!.body as { text: string }).text).toBe('Why?')
    expect(await within(drawer).findByText('Second time lucky.', {}, POLL)).toBeTruthy()
  })

  it('shows why a question was refused', async () => {
    renderWithSam()
    server.use(
      http.post(`${API}/v1/assistant/threads/:id/messages`, () =>
        HttpResponse.json({ error: { code: 'conflict', message: 'This chat is full. Start a new chat.' } }, { status: 409 }),
      ),
    )
    const { user, drawer } = await openFromControlBar()
    const box = await composer(drawer)
    await user.type(box, 'One more{Enter}')
    expect((await within(drawer).findByRole('alert')).textContent).toContain('This chat is full. Start a new chat.')
    expect(box.value).toBe('One more')
  })

  it('resumes a chat whose answer is still pending, with Send disabled', async () => {
    renderWithSam(OVERVIEW, {
      threads: [
        thread({
          id: 'th-busy',
          title: 'Busy',
          messages: [message({ id: 'q', text: 'Earlier' }), message({ id: 'a', role: 'assistant', status: 'pending' })],
        }),
      ],
      pendingReads: 99,
    })
    const { user, drawer } = await openFromControlBar()
    await user.click(within(drawer).getByRole('button', { name: 'Recent chats' }))
    await user.click(await screen.findByRole('menuitem', { name: /Busy/ }))
    await within(drawer).findByText('SAM is looking into it')
    expect((within(drawer).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('links replies safely', async () => {
    renderWithSam(OVERVIEW, { replies: [{ text: 'Read [statuses and bands](https://example.test/help).' }] })
    const { user, drawer } = await openFromControlBar()
    await user.type(await composer(drawer), 'Help{Enter}')
    const link = await within(drawer).findByRole('link', { name: /statuses and bands/ }, POLL)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('without a key, shows the setup card with the privacy line', async () => {
    renderWithSam(OVERVIEW, { last4: '' })
    const { drawer } = await openFromControlBar()
    expect(await within(drawer).findByRole('heading', { name: 'Add your Claude API key to use SAM' })).toBeTruthy()
    expect(
      within(drawer).getByText('Your questions and the data SAM reads are sent to the model provider using your key.'),
    ).toBeTruthy()
    expect(within(drawer).getByRole('link', { name: 'Set up Ask SAM' }).getAttribute('href')).toBe('/settings/ask-sam')
    expect(within(drawer).queryByRole('textbox', { name: 'Ask SAM a question' })).toBeNull()
    expect((await axe(drawer)).violations).toEqual([])
  })

  it('says so when an admin has turned Ask SAM off', async () => {
    renderWithSam(OVERVIEW, { settings: { enabled: false, model: 'claude-haiku-5-5' } })
    const { drawer } = await openFromControlBar()
    expect(await within(drawer).findByText('Ask SAM is turned off for this organization.')).toBeTruthy()
    expect(within(drawer).queryByRole('textbox', { name: 'Ask SAM a question' })).toBeNull()
  })

  it('switches between recent chats and starts a new one', async () => {
    const seen = renderWithSam(OVERVIEW, {
      threads: [
        thread({
          id: 'th-old',
          title: 'Why did defects rise?',
          messages: [
            message({ id: 'q1', text: 'Why did defects rise?' }),
            message({ id: 'a1', role: 'assistant', text: 'Two releases slipped.' }),
          ],
        }),
      ],
    })
    const { user, drawer } = await openFromControlBar()
    await user.click(within(drawer).getByRole('button', { name: 'Recent chats' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'New chat' })).toBeTruthy()
    await user.click(await within(menu).findByRole('menuitem', { name: /Why did defects rise\?/ }))
    expect(await within(drawer).findByText('Two releases slipped.')).toBeTruthy()
    expect(within(drawer).queryByRole('button', { name: 'Summarize Oct 2026' })).toBeNull()

    await user.type(await composer(drawer), 'And now?{Enter}')
    await waitFor(() => expect(seen.posts.map((p) => p.threadId)).toEqual(['th-old']))
    await within(drawer).findByText('84.3%', {}, POLL)

    await user.click(within(drawer).getByRole('button', { name: 'Recent chats' }))
    await user.click(await screen.findByRole('menuitem', { name: 'New chat' }))
    expect(await within(drawer).findByRole('button', { name: 'Summarize Oct 2026' })).toBeTruthy()
    expect(within(drawer).queryByText('Two releases slipped.')).toBeNull()
  })

  it('sits beside the page on wide screens and leaves the page usable', async () => {
    renderWithSam()
    const { user, drawer } = await openFromControlBar()
    expect(drawer.getAttribute('aria-modal')).toBeNull()
    expect(screen.getByRole('main').closest('[aria-hidden="true"]')).toBeNull()
    // Clicking the page keeps the drawer open.
    await user.click(screen.getByRole('heading', { name: 'Overview', level: 1 }))
    expect(screen.getByRole('dialog', { name: 'Ask SAM' })).toBeTruthy()
  })

  it('is a modal full-screen sheet on narrow screens', async () => {
    window.matchMedia = ((query: string) => ({
      matches: !query.includes('min-width: 1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    renderWithSam()
    const { drawer } = await openFromControlBar()
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.className).toContain('inset-0')
  })

  it('opens from the left navigation and the header on any page', async () => {
    renderWithSam('/entry?period=2026-M10')
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await user.click(within(nav).getByRole('button', { name: 'Ask SAM' }))
    const drawer = await screen.findByRole('dialog', { name: 'Ask SAM' })
    expect(await within(drawer).findByText('Oct 2026')).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'How do statuses and bands work?' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask SAM' })).toBeNull())
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Ask SAM' }))
    expect(await screen.findByRole('dialog', { name: 'Ask SAM' })).toBeTruthy()
  })
})
