import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { newRulesFake, rulesHandlers, type RulesFake } from '../../test/rulesFixtures'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { TemplatesPage } from './TemplatesPage'

let fake: RulesFake

beforeEach(() => {
  fake = newRulesFake()
  server.use(...rulesHandlers(fake))
})

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<TemplatesPage />, { route: '/admin/templates' })
  await screen.findByRole('table', { name: 'Saved templates' })
  return { user, ...view }
}

function puts(id: string) {
  return fake.requests.filter((r) => r.method === 'PUT' && r.path === `/import-templates/${id}`)
}

describe('TemplatesPage', () => {
  it('lists saved records templates with when they were last used', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Templates' })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Saved templates' })
    const defects = within(table).getByRole('row', { name: /Defects export/ })
    expect(within(defects).getByText('Defect')).toBeTruthy()
    expect(within(defects).getByText('tracker')).toBeTruthy()
    expect(within(defects).getByText('Oct 31, 2026')).toBeTruthy()
    const epics = within(table).getByRole('row', { name: /Epics export/ })
    expect(within(epics).getByText('Not used yet')).toBeTruthy()
    expect(within(table).queryByText('Legacy workbook')).toBeNull()
  })

  it('opens the setup wizard at the columns step to edit a mapping', async () => {
    await setup()
    const link = screen.getByRole('link', { name: 'Edit mapping for Defects export' })
    expect(link.getAttribute('href')).toBe('/admin/import/setup?template=defects-export&step=columns')
  })

  it('edits the template JSON under Advanced', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Advanced JSON for Defects export' }))
    const json = screen.getByLabelText('Template JSON for Defects export')
    const body = JSON.parse((json as HTMLTextAreaElement).value) as Record<string, unknown>
    expect(body.recordType).toBe('defect')

    await user.clear(json)
    await user.click(json)
    await user.paste('{ not json')
    await user.click(screen.getByRole('button', { name: 'Save Defects export' }))
    expect(json.getAttribute('aria-invalid')).toBe('true')
    expect(puts('defects-export')).toHaveLength(0)

    await user.clear(json)
    await user.paste(JSON.stringify({ ...body, fullExport: true }))
    await user.click(screen.getByRole('button', { name: 'Save Defects export' }))
    await waitFor(() => expect(puts('defects-export')).toHaveLength(1))
    expect(puts('defects-export')[0]?.body).toEqual({
      id: 'defects-export',
      name: 'Defects export',
      profile: 'records',
      body: { ...body, fullExport: true },
    })
    expect(await screen.findByText('Saved Defects export.')).toBeTruthy()
  })

  it('shows the server error under the JSON', async () => {
    const { user } = await setup()
    fake.failNext.set('PUT /import-templates/defects-export', {
      status: 400,
      code: 'invalid',
      message: 'invalid request',
      details: [{ path: 'body.fields.externalId', message: 'externalId is required' }],
    })
    await user.click(screen.getByRole('button', { name: 'Advanced JSON for Defects export' }))
    await user.click(screen.getByRole('button', { name: 'Save Defects export' }))
    const json = screen.getByLabelText('Template JSON for Defects export')
    await waitFor(() => expect(json.getAttribute('aria-invalid')).toBe('true'))
    const described = (json.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(described).toContain('body.fields.externalId: externalId is required')
  })

  it('has no axe violations', async () => {
    const { user, container } = await setup()
    await user.click(screen.getByRole('button', { name: 'Advanced JSON for Defects export' }))
    expect((await axe(container)).violations).toEqual([])
  })
})
