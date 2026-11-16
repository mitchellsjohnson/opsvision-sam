import { screen, waitFor, within } from '@testing-library/react'
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
  const view = renderApp(<App />, { route: '/admin/assistant' })
  return { seen, ...view }
}

describe('AssistantAdminPage', () => {
  it('shows the settings with the offered models, with no axe violations', async () => {
    const { container } = renderPage()
    expect(await screen.findByRole('heading', { name: 'Ask SAM', level: 1 })).toBeTruthy()
    const enabled = (await screen.findByRole('checkbox', { name: 'Let members use Ask SAM' })) as HTMLInputElement
    expect(enabled.checked).toBe(true)
    const group = screen.getByRole('radiogroup', { name: 'Model' })
    const haiku = within(group).getByRole('radio', { name: /claude-haiku-5-5/ }) as HTMLInputElement
    expect(haiku.checked).toBe(true)
    expect(within(group).getByRole('radio', { name: /claude-sonnet-5-5/ })).toBeTruthy()
    expect(within(group).getByRole('radio', { name: 'Another model' })).toBeTruthy()
    expect((await axe(container)).violations).toEqual([])
  })

  it('saves the stronger model', async () => {
    const { seen } = renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /claude-sonnet-5-5/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen.settingsPuts).toEqual([{ enabled: true, model: 'claude-sonnet-5-5' }]))
    expect((await screen.findByRole('status')).textContent).toBe('Saved. SAM answers with claude-sonnet-5-5.')
  })

  it('accepts any model id and turns SAM off', async () => {
    const { seen } = renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: 'Let members use Ask SAM' }))
    await user.click(screen.getByRole('radio', { name: 'Another model' }))
    await user.type(screen.getByRole('textbox', { name: 'Model id' }), 'claude-example-9')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen.settingsPuts).toEqual([{ enabled: false, model: 'claude-example-9' }]))
    expect((await screen.findByRole('status')).textContent).toBe('Saved. Ask SAM is off.')
  })

  it('shows a saved custom model as another model', async () => {
    renderPage({ settings: { enabled: true, model: 'claude-example-9' } })
    const other = (await screen.findByRole('radio', { name: 'Another model' })) as HTMLInputElement
    await waitFor(() => expect(other.checked).toBe(true))
    expect((screen.getByRole('textbox', { name: 'Model id' }) as HTMLInputElement).value).toBe('claude-example-9')
  })

  it('checks the model id before saving', async () => {
    const { seen } = renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Another model' }))
    await user.type(screen.getByRole('textbox', { name: 'Model id' }), 'Not A Model!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Use lowercase letters, digits, dots and dashes/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Model id' }))
    expect(seen.settingsPuts).toEqual([])
  })

  it('is in the admin navigation', async () => {
    renderPage()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const admin = await within(nav).findByRole('list', { name: 'Admin' })
    expect(within(admin).getByRole('link', { name: 'Ask SAM' }).getAttribute('href')).toBe('/admin/assistant')
  })

  it('is for admins only', async () => {
    state.role = 'viewer'
    renderPage()
    await screen.findByRole('button', { name: /Test viewer/ })
    expect(screen.queryByRole('heading', { name: 'Ask SAM', level: 1 })).toBeNull()
  })
})
