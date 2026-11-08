import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { RecordType } from '../../api/queries'
import { newRulesFake, rulesHandlers, type RulesFake } from '../../test/rulesFixtures'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { RecordTypesPage } from './RecordTypesPage'

let fake: RulesFake

beforeEach(() => {
  fake = newRulesFake()
  server.use(...rulesHandlers(fake))
})

function puts(id: string) {
  return fake.requests.filter((r) => r.method === 'PUT' && r.path === `/record-types/${id}`)
}

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<RecordTypesPage />, { route: '/admin/record-types' })
  await screen.findByRole('table', { name: 'Record types' })
  return { user, ...view }
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Edit ${name}` }))
  return screen.findByRole('region', { name: `Edit ${name}` })
}

describe('RecordTypesPage', () => {
  it('lists record types with priorities, custom fields and tracked-from months', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Record types' })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Record types' })
    const defect = within(table).getByRole('row', { name: /Defect/ })
    expect(within(defect).getByText('P1, P2, P3, P4')).toBeTruthy()
    expect(within(defect).getByText('Customer ticket (yes or no)')).toBeTruthy()
    expect(within(defect).getByText('tracker: from Nov 2026')).toBeTruthy()
    const epic = within(table).getByRole('row', { name: /Epic/ })
    expect(within(epic).getByText('None set')).toBeTruthy()
  })

  it('reorders priorities from the keyboard and saves with the loaded version', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Defect')
    const list = within(editor).getByRole('list', { name: 'Priorities, highest first' })
    expect(within(list).getAllByRole('textbox').map((i) => (i as HTMLInputElement).value)).toEqual(['P1', 'P2', 'P3', 'P4'])

    within(editor).getByRole('button', { name: 'Move P2 up' }).focus()
    await user.keyboard('{Enter}')
    expect(within(list).getAllByRole('textbox').map((i) => (i as HTMLInputElement).value)).toEqual(['P2', 'P1', 'P3', 'P4'])
    // P2 is now first: focus stays with it, on the button that can still move it.
    expect(document.activeElement).toBe(within(editor).getByRole('button', { name: 'Move P2 down' }))
    expect(within(editor).getByText('P2 moved to position 1 of 4.')).toBeTruthy()

    await user.click(within(editor).getByRole('button', { name: 'Save Defect' }))
    await waitFor(() => expect(puts('defect')).toHaveLength(1))
    expect(puts('defect')[0]?.body).toEqual({
      id: 'defect',
      name: 'Defect',
      priorities: ['P2', 'P1', 'P3', 'P4'],
      attributes: [{ key: 'customerTicket', name: 'Customer ticket', type: 'bool' }],
      trackedFrom: { tracker: '2026-M11' },
      revision: 1,
    })
    expect(await screen.findByText('Saved Defect.')).toBeTruthy()

    // The next save sends the version the server returned.
    await user.click(within(editor).getByRole('button', { name: 'Move P4 up' }))
    await user.click(within(editor).getByRole('button', { name: 'Save Defect' }))
    await waitFor(() => expect(puts('defect')).toHaveLength(2))
    expect((puts('defect')[1]?.body as RecordType).revision).toBe(2)
  })

  it('edits the name, priorities, custom fields and tracked-from months', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Epic')
    const name = within(editor).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Epics')
    await user.type(within(editor).getByLabelText('New priority'), 'Must have')
    await user.click(within(editor).getByRole('button', { name: 'Add priority' }))
    await user.click(within(editor).getByRole('button', { name: 'Add custom field' }))
    await user.type(within(editor).getByLabelText('Custom field 1 name'), 'Customer impact')
    expect((within(editor).getByLabelText('Custom field 1 key') as HTMLInputElement).value).toBe('customerImpact')
    await user.selectOptions(within(editor).getByLabelText('Custom field 1 type'), 'bool')
    await user.selectOptions(within(editor).getByLabelText('Tracked from for tracker'), '2026-M09')
    await user.click(within(editor).getByRole('button', { name: 'Save Epics' }))
    await waitFor(() => expect(puts('epic')).toHaveLength(1))
    expect(puts('epic')[0]?.body).toEqual({
      id: 'epic',
      name: 'Epics',
      priorities: ['Must have'],
      attributes: [{ key: 'customerImpact', name: 'Customer impact', type: 'bool' }],
      trackedFrom: { tracker: '2026-M09' },
      revision: 1,
    })
  })

  it('says when the record type changed somewhere else', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Defect')
    fake.recordTypes[0]!.revision = 5
    await user.click(within(editor).getByRole('button', { name: 'Remove P4' }))
    await user.click(within(editor).getByRole('button', { name: 'Save Defect' }))
    expect(await within(editor).findByText(/changed somewhere else/)).toBeTruthy()
    await user.click(within(editor).getByRole('button', { name: 'Reload Defect' }))
    await waitFor(() =>
      expect(within(editor).getAllByRole('textbox', { name: /^Priority \d/ }).map((i) => (i as HTMLInputElement).value)).toEqual([
        'P1',
        'P2',
        'P3',
        'P4',
      ]),
    )
  })

  it('shows server errors at the field they belong to', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Defect')
    fake.failNext.set('PUT /record-types/defect', {
      status: 400,
      code: 'invalid',
      message: 'invalid request',
      details: [{ path: 'priorities[1]', message: 'duplicate priority "P1"' }],
    })
    await user.click(within(editor).getByRole('button', { name: 'Save Defect' }))
    const p2 = await within(editor).findByLabelText('Priority 2')
    await waitFor(() => expect(p2.getAttribute('aria-invalid')).toBe('true'))
    const described = (p2.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(described).toContain('duplicate priority "P1"')
  })

  it('adds a record type', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add record type' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add record type' })
    await user.type(within(dialog).getByLabelText('Name'), 'Support incident')
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).value).toBe('support_incident')
    await user.click(within(dialog).getByRole('button', { name: 'Add record type' }))
    await waitFor(() => expect(puts('support_incident')).toHaveLength(1))
    expect(puts('support_incident')[0]?.body).toEqual({
      id: 'support_incident',
      name: 'Support incident',
      priorities: [],
      attributes: [],
      trackedFrom: {},
      revision: 0,
    })
    expect(await screen.findByRole('region', { name: 'Edit Support incident' })).toBeTruthy()
  })

  it('has no axe violations', async () => {
    const { user, container } = await setup()
    await openEditor(user, 'Defect')
    expect((await axe(container)).violations).toEqual([])
  })
})
