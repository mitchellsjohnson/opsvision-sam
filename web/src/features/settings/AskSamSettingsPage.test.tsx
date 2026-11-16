import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import { assistantHandlers, newAssistantSeen, type AssistantFakeOptions } from '../../test/assistantFixtures'
import { server, state } from '../../test/server'
import { renderApp } from '../../test/utils'

function renderPage(options: AssistantFakeOptions = {}) {
  const seen = options.seen ?? newAssistantSeen()
  server.use(...assistantHandlers({ ...options, seen }))
  const view = renderApp(<App />, { route: '/settings/ask-sam' })
  return { seen, ...view }
}

const keyField = () => screen.findByLabelText('Claude API key') as Promise<HTMLInputElement>

describe('AskSamSettingsPage', () => {
  it('explains SAM, the privacy line and the model in use, with no axe violations', async () => {
    const { container } = renderPage()
    expect(await screen.findByRole('heading', { name: 'Ask SAM', level: 1 })).toBeTruthy()
    expect(screen.getByText('Your questions and the data SAM reads are sent to the model provider using your key.')).toBeTruthy()
    expect(await screen.findByText('claude-haiku-5-5')).toBeTruthy()
    expect(await screen.findByText('No key saved.')).toBeTruthy()
    expect((await keyField()).type).toBe('password')
    expect((await axe(container)).violations).toEqual([])
  })

  it('works for a viewer too', async () => {
    state.role = 'viewer'
    renderPage()
    expect(await keyField()).toBeTruthy()
  })

  it('saves a key and shows only its last 4 characters', async () => {
    const { seen } = renderPage()
    const user = userEvent.setup()
    await user.type(await keyField(), '  sk-example-0123456789abcd  ')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('•••• abcd')).toBeTruthy()
    expect(seen.credentialPuts).toEqual([{ apiKey: 'sk-example-0123456789abcd' }])
    expect(screen.getByRole('status').textContent).toBe('Key saved. SAM is ready.')
    expect(screen.queryByLabelText('Claude API key')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-example-0123456789abcd')
  })

  it('asks for a key before saving', async () => {
    const { seen } = renderPage()
    const user = userEvent.setup()
    await keyField()
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('Paste your Claude API key.')).toBeTruthy()
    expect(document.activeElement).toBe(await keyField())
    expect(seen.credentialPuts).toEqual([])
  })

  it('shows the provider’s rejection and keeps nothing', async () => {
    renderPage()
    const user = userEvent.setup()
    await user.type(await keyField(), 'sk-example-bad-0000000000')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That key was rejected by the provider.')
    expect(screen.getByText('No key saved.')).toBeTruthy()
  })

  it('replaces a saved key', async () => {
    const { seen } = renderPage({ last4: 'x9Q2' })
    const user = userEvent.setup()
    expect(await screen.findByText('•••• x9Q2')).toBeTruthy()
    expect(screen.queryByLabelText('Claude API key')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    await user.type(await keyField(), 'sk-example-new-key-00009876')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('•••• 9876')).toBeTruthy()
    expect(seen.credentialPuts).toEqual([{ apiKey: 'sk-example-new-key-00009876' }])
  })

  it('cancels a replacement', async () => {
    renderPage({ last4: 'x9Q2' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Replace key' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Claude API key')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace key' }))
  })

  it('removes a saved key', async () => {
    const { seen } = renderPage({ last4: 'x9Q2' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Remove key' }))
    expect(await screen.findByText('No key saved.')).toBeTruthy()
    expect(seen.credentialDeletes).toBe(1)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Key removed.'))
  })

  it('says when an admin has turned Ask SAM off', async () => {
    renderPage({ settings: { enabled: false, model: 'claude-sonnet-5-5' } })
    expect(await screen.findByText(/An admin has turned Ask SAM off/)).toBeTruthy()
    expect(screen.getByText('claude-sonnet-5-5')).toBeTruthy()
  })

  it('is in the account menu under My settings', async () => {
    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Test admin/ }))
    const group = await screen.findByRole('group', { name: 'My settings' })
    const item = await screen.findByRole('menuitem', { name: 'Ask SAM' })
    expect(group.contains(item)).toBe(true)
    expect(item.getAttribute('href')).toBe('/settings/ask-sam')
  })
})
