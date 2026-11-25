import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { RecordType } from '../../api/queries'
import { newRulesFake, rulesHandlers, type RulesFake } from '../../test/rulesFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { versions } from '../../test/viewFixtures'
import { incidentPreset, standardRecordTypes } from './adminModel'
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
    // The key follows the name, and is shown only under Advanced.
    expect(within(editor).queryByLabelText('Custom field 1 key')).toBeNull()
    await user.click(within(editor).getByRole('button', { name: 'Show advanced' }))
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

  it('moves focus into the editor on Edit, and to a neighbor when a row is removed', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Defect')
    expect(document.activeElement).toBe(within(editor).getByRole('heading', { name: 'Edit Defect' }))

    await user.click(within(editor).getByRole('button', { name: 'Add custom field' }))
    await user.type(within(editor).getByLabelText('Custom field 2 name'), 'Team')
    await user.click(within(editor).getByRole('button', { name: 'Remove custom field 1' }))
    expect(document.activeElement).toBe(within(editor).getByRole('button', { name: 'Remove custom field 1' }))
    expect((within(editor).getByLabelText('Custom field 1 name') as HTMLInputElement).value).toBe('Team')
    await user.click(within(editor).getByRole('button', { name: 'Remove custom field 1' }))
    expect(document.activeElement).toBe(within(editor).getByRole('heading', { name: 'Custom fields' }))

    await user.click(within(editor).getByRole('button', { name: 'Remove tracker' }))
    expect(document.activeElement).toBe(within(editor).getByRole('heading', { name: 'Tracked from' }))
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

  it('says which rule uses a priority it cannot remove', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Defect')
    const message = 'Defect points in 2026 uses priority P4. Change that rule before removing or renaming the priority.'
    fake.failNext.set('PUT /record-types/defect', { status: 409, code: 'conflict', message, details: [{ path: 'priorities', message }] })
    await user.click(within(editor).getByRole('button', { name: 'Remove P4' }))
    await user.click(within(editor).getByRole('button', { name: 'Save Defect' }))
    expect(await within(editor).findByText(message)).toBeTruthy()
    expect(within(editor).queryByText(/changed somewhere else/)).toBeNull()
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

  it('offers Date and time in the custom field type picker', async () => {
    const { user } = await setup()
    const editor = await openEditor(user, 'Epic')
    await user.click(within(editor).getByRole('button', { name: 'Add custom field' }))
    const type = within(editor).getByLabelText('Custom field 1 type')
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual(['Text', 'Number', 'Yes or no', 'Date', 'Date and time'])
    await user.selectOptions(type, 'datetime')
    await user.type(within(editor).getByLabelText('Custom field 1 name'), 'Started')
    await user.click(within(editor).getByRole('button', { name: 'Save Epic' }))
    await waitFor(() => expect(puts('epic')).toHaveLength(1))
    expect((puts('epic')[0]?.body as RecordType).attributes).toEqual([{ key: 'started', name: 'Started', type: 'datetime' }])
  })
})

describe('RecordTypesPage: standard types', () => {
  const standard = (id: string) => standardRecordTypes().find((t) => t.id === id)!
  const addButton = () => screen.getByRole('button', { name: 'Add standard types' }) as HTMLButtonElement

  it('Add standard types creates only the missing ones, then is disabled', async () => {
    const { user, container } = await setup()
    expect(addButton().disabled).toBe(false)
    await user.click(addButton())
    await waitFor(() => expect(puts('concept')).toHaveLength(1))
    expect(puts('concept')[0]?.body).toEqual(standard('concept'))
    expect(puts('defect')).toHaveLength(0)
    expect(puts('epic')).toHaveLength(0)
    expect((await screen.findByText('Added Concept.')).getAttribute('role')).toBe('status')
    await waitFor(() => expect(addButton().disabled).toBe(true))
    const hint = screen.getByText('The standard types exist.')
    expect(addButton().getAttribute('aria-describedby')).toBe(hint.id)
    expect((await axe(container)).violations).toEqual([])
  })

  it('creates all three for a tenant with none', async () => {
    fake.recordTypes = []
    const user = userEvent.setup()
    renderApp(<RecordTypesPage />, { route: '/admin/record-types' })
    await user.click(await screen.findByRole('button', { name: 'Add standard types' }))
    expect(await screen.findByText('Added Defect, Epic and Concept.')).toBeTruthy()
    for (const id of ['defect', 'epic', 'concept']) expect(puts(id)[0]?.body).toEqual(standard(id))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('treats a type that appeared meanwhile as added, not as an error', async () => {
    fake.recordTypes = fake.recordTypes.filter((t) => t.id !== 'epic')
    const { user } = await setup()
    fake.recordTypes.push({ ...standard('epic'), revision: 1 })
    await user.click(addButton())
    expect(await screen.findByText('Added Concept.')).toBeTruthy()
    expect(puts('epic')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a type it could not add', async () => {
    server.use(
      http.put(`${API}/v1/record-types/concept`, () =>
        HttpResponse.json({ error: { code: 'internal', message: 'store unavailable' } }, { status: 500 }),
      ),
    )
    const { user } = await setup()
    await user.click(addButton())
    expect((await screen.findByRole('alert')).textContent).toBe('Could not add every standard type. Concept: store unavailable')
    expect(addButton().disabled).toBe(false)
  })
})

describe('RecordTypesPage: incidents', () => {
  beforeEach(() => {
    const version = structuredClone(versions.find((v) => v.status === 'published')!)
    version.content.metrics.push({ ...version.content.metrics[0]!, key: 'uptime', name: 'Uptime' })
    server.use(http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: [version] })))
  })

  it('Add incident type creates the preset, then is disabled', async () => {
    const { user } = await setup()
    const add = screen.getByRole('button', { name: 'Add incident type' }) as HTMLButtonElement
    expect(add.disabled).toBe(false)
    await user.click(add)
    await waitFor(() => expect(puts('incident')).toHaveLength(1))
    expect(puts('incident')[0]?.body).toEqual(incidentPreset())
    expect(await screen.findByText('Added Incident.')).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Edit Incident' })).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add incident type' }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText('An incident type exists.')).toBeTruthy()
  })

  async function openIncident() {
    fake.recordTypes.push({ ...incidentPreset(), revision: 4 })
    const { user, container } = await setup()
    const editor = await openEditor(user, 'Incident')
    return { user, editor, container }
  }

  it('lists the attribute types in words, date-times as date and time', async () => {
    fake.recordTypes.push({ ...incidentPreset(), revision: 4 })
    await setup()
    const row = within(screen.getByRole('table', { name: 'Record types' })).getByRole('row', { name: /Incident/ })
    expect(within(row).getByText(/Started \(date and time\), Ended \(date and time\)/)).toBeTruthy()
  })

  it('an Explains row saves the link with the loaded revision', async () => {
    const { user, editor } = await openIncident()
    const explains = within(editor).getByRole('group', { name: 'Explains' })
    expect(within(explains).getByText('These records explain no metric yet.')).toBeTruthy()
    await user.click(within(explains).getByRole('button', { name: 'Add a metric' }))
    const form = within(explains).getByRole('group', { name: 'Metric these records explain' })
    await user.selectOptions(within(form).getByLabelText('Metric'), 'Uptime')
    const mode = within(form).getByRole('radiogroup', { name: 'Mode' })
    expect((within(mode).getByRole('radio', { name: 'Downtime' }) as HTMLInputElement).checked).toBe(true)
    await user.click(within(form).getByRole('button', { name: 'Add condition' }))
    await user.selectOptions(within(form).getByLabelText('Condition 1 field'), 'category')
    await user.selectOptions(within(form).getByLabelText('Condition 1 operator'), 'is_not')
    await user.type(within(form).getByLabelText('Condition 1 value'), 'maintenance')
    await user.click(within(form).getByRole('button', { name: 'Add' }))
    const rows = within(explains).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('[data-explain]')!.textContent)).toEqual(["Uptime · Downtime · category != 'maintenance'"])
    await user.click(within(editor).getByRole('button', { name: 'Save Incident' }))
    await waitFor(() => expect(puts('incident')).toHaveLength(1))
    const body = puts('incident')[0]?.body as RecordType
    expect(body.revision).toBe(4)
    expect(body.explains).toEqual([{ scorecardId: 'sc-main', metricKey: 'uptime', mode: 'downtime', where: "category != 'maintenance'" }])
  })

  it('edits and removes an Explains row; List has no downtime measure', async () => {
    fake.recordTypes.push({
      ...incidentPreset(),
      revision: 4,
      explains: [{ scorecardId: 'sc-main', metricKey: 'uptime', mode: 'downtime', downMeasure: 'seconds_down', where: '' }],
    })
    const { user } = await setup()
    const editor = await openEditor(user, 'Incident')
    const explains = within(editor).getByRole('group', { name: 'Explains' })
    expect(within(explains).getByText('Uptime · Downtime · every record')).toBeTruthy()
    await user.click(within(explains).getByRole('button', { name: 'Edit the Uptime link' }))
    const form = within(explains).getByRole('group', { name: 'Metric these records explain' })
    expect((within(form).getByLabelText('Downtime measure (optional)') as HTMLInputElement).value).toBe('seconds_down')
    await user.click(within(form).getByRole('radio', { name: 'List' }))
    expect(within(form).queryByLabelText('Downtime measure (optional)')).toBeNull()
    await user.click(within(form).getByRole('button', { name: 'Update' }))
    expect(within(explains).getByText('Uptime · List · every record')).toBeTruthy()
    await user.click(within(editor).getByRole('button', { name: 'Save Incident' }))
    await waitFor(() => expect(puts('incident')).toHaveLength(1))
    expect((puts('incident')[0]?.body as RecordType).explains).toEqual([{ scorecardId: 'sc-main', metricKey: 'uptime', mode: 'list', where: '' }])

    await user.click(within(explains).getByRole('button', { name: 'Remove the Uptime link' }))
    expect(within(explains).getByText('These records explain no metric yet.')).toBeTruthy()
    await user.click(within(editor).getByRole('button', { name: 'Save Incident' }))
    await waitFor(() => expect(puts('incident')).toHaveLength(2))
    expect((puts('incident')[1]?.body as RecordType).explains).toEqual([])
  })

  it('a 409 on save shows the conflict message', async () => {
    const { user, editor } = await openIncident()
    fake.recordTypes.find((t) => t.id === 'incident')!.revision = 9
    const explains = within(editor).getByRole('group', { name: 'Explains' })
    await user.click(within(explains).getByRole('button', { name: 'Add a metric' }))
    const form = within(explains).getByRole('group', { name: 'Metric these records explain' })
    await user.selectOptions(within(form).getByLabelText('Metric'), 'Uptime')
    await user.click(within(form).getByRole('button', { name: 'Add' }))
    await user.click(within(editor).getByRole('button', { name: 'Save Incident' }))
    expect(
      await within(editor).findByText(
        'This record type was changed somewhere else since you opened it, so your changes could not be saved.',
      ),
    ).toBeTruthy()
  })

  it('shows a where problem the server reports at the link', async () => {
    const { user, editor } = await openIncident()
    fake.failNext.set('PUT /record-types/incident', {
      status: 400,
      code: 'invalid',
      message: 'invalid request',
      details: [{ path: 'explains[0].where', message: 'unknown field "nope" on record type "incident"' }],
    })
    const explains = within(editor).getByRole('group', { name: 'Explains' })
    await user.click(within(explains).getByRole('button', { name: 'Add a metric' }))
    const form = within(explains).getByRole('group', { name: 'Metric these records explain' })
    await user.selectOptions(within(form).getByLabelText('Metric'), 'Uptime')
    await user.click(within(form).getByRole('button', { name: 'Add' }))
    await user.click(within(editor).getByRole('button', { name: 'Save Incident' }))
    expect(await within(explains).findByText('unknown field "nope" on record type "incident"')).toBeTruthy()
  })

  it('has no axe violations with the Explains form open', async () => {
    const { user, editor, container } = await openIncident()
    await user.click(within(within(editor).getByRole('group', { name: 'Explains' })).getByRole('button', { name: 'Add a metric' }))
    expect((await axe(container)).violations).toEqual([])
  })
})
