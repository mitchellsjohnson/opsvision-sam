import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { adminHandlers, newAdminFake } from '../../test/adminFixtures'
import { methodologyHandlers, newMethodologyFake, type MethodologyFake } from '../../test/methodologyFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { currentMonth } from '../../lib/period'
import { addMonths } from './adminModel'
import { MethodologyPage } from './MethodologyPage'

let fake: MethodologyFake

beforeEach(() => {
  fake = newMethodologyFake()
  server.use(...methodologyHandlers(fake), ...adminHandlers(newAdminFake()))
})

const V = '/scorecards/sc-main/versions'

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<MethodologyPage />, { route: '/admin/methodology' })
  await screen.findByRole('table', { name: /Methodology versions/ })
  return { user, ...view }
}

async function openDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Edit FY27 proposal' }))
  await screen.findByRole('heading', { level: 2, name: /Editing FY27 proposal/ })
  await screen.findByRole('table', { name: 'Metrics' })
}

async function openMetric(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Edit ${name}` }))
  await screen.findByRole('heading', { level: 3, name: `Edit metric: ${name}` })
}

function writes(method: string, path: string) {
  return fake.requests.filter((r) => r.method === method && r.path === path)
}

function describedText(el: HTMLElement) {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

describe('MethodologyPage versions', () => {
  it('lists versions with status chips and effective months', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Methodology' })).toBeTruthy()
    const table = screen.getByRole('table', { name: /Methodology versions/ })
    const draft = within(table).getByRole('row', { name: /FY27 proposal/ })
    expect(within(draft).getByText('Draft')).toBeTruthy()
    expect(within(draft).getByText('Not published')).toBeTruthy()
    const published = within(table).getByRole('row', { name: /FY26 published/ })
    expect(within(published).getByText('Published')).toBeTruthy()
    expect(within(published).getByText('Jan 2026')).toBeTruthy()
    const old = within(table).getByRole('row', { name: /FY25 published/ })
    expect(within(old).getByText('Superseded')).toBeTruthy()
    expect(within(old).getByText('Jan 2025')).toBeTruthy()
    expect((screen.getByLabelText('Scorecard') as HTMLSelectElement).value).toBe('sc-main')
  })

  it('creates a draft cloned from the version in force and opens it', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New draft from…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New draft' })
    expect((within(dialog).getByLabelText('Start from') as HTMLSelectElement).value).toBe('ver-1')
    await user.type(within(dialog).getByLabelText('Draft name'), 'FY28 draft')
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(writes('POST', V)).toHaveLength(1))
    expect(writes('POST', V)[0]?.body).toEqual({ name: 'FY28 draft', cloneFrom: 'ver-1' })
    expect(await screen.findByRole('heading', { level: 2, name: /Editing FY28 draft/ })).toBeTruthy()
    const table = await screen.findByRole('table', { name: 'Metrics' })
    expect(within(table).getByText('On-time delivery')).toBeTruthy()
  })

  it('creates an empty draft or one cloned from another version', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New draft from…' }))
    let dialog = await screen.findByRole('dialog', { name: 'New draft' })
    await user.type(within(dialog).getByLabelText('Draft name'), 'From scratch')
    await user.selectOptions(within(dialog).getByLabelText('Start from'), '')
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(writes('POST', V)).toHaveLength(1))
    expect(writes('POST', V)[0]?.body).toEqual({ name: 'From scratch' })
    expect(await screen.findByText('No metrics yet.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'New draft from…' }))
    dialog = await screen.findByRole('dialog', { name: 'New draft' })
    await user.type(within(dialog).getByLabelText('Draft name'), 'From old')
    await user.selectOptions(within(dialog).getByLabelText('Start from'), 'ver-0')
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(writes('POST', V)).toHaveLength(2))
    expect(writes('POST', V)[1]?.body).toEqual({ name: 'From old', cloneFrom: 'ver-0' })
  })

  it('requires a name for a new draft and shows server errors', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New draft from…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New draft' })
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }))
    const name = within(dialog).getByLabelText('Draft name')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(describedText(name)).toContain('Enter a name')
    expect(document.activeElement).toBe(name)
    expect(writes('POST', V)).toHaveLength(0)
  })

  it('shows a published version read-only, with its changes', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'View FY26 published' }))
    expect(await screen.findByRole('heading', { level: 2, name: /Viewing FY26 published/ })).toBeTruthy()
    expect(screen.getByText(/cannot be edited/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull()
    const metrics = screen.getByRole('table', { name: 'Metrics' })
    expect(within(metrics).getByRole('row', { name: /Defect rate/ })).toBeTruthy()
    expect(within(metrics).getByText(/Change vs prior period/)).toBeTruthy()
    expect(await screen.findByText(/No differences from the version in force/)).toBeTruthy()
  })
})

describe('MethodologyPage draft editor', () => {
  it('edits a band threshold, saves with the revision, and shows it in the diff', async () => {
    const { user } = await setup()
    await openDraft(user)
    expect(await screen.findByText(/No differences from the version in force/)).toBeTruthy()
    await openMetric(user, 'On-time delivery')
    const value = screen.getByLabelText('Band 1 value')
    await user.clear(value)
    await user.type(value, '95')
    expect(screen.getByText(/You have unsaved changes/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const body = writes('PUT', `${V}/ver-2`)[0]?.body as {
      revision: number
      name: string
      content: { metrics: { rule: { bands: { value: number }[] } }[] }
    }
    expect(body.revision).toBe(1)
    expect(body.name).toBe('FY27 proposal')
    expect(body.content.metrics[0]?.rule.bands[0]?.value).toBe(95)
    expect(await screen.findByText('Draft saved.')).toBeTruthy()

    const changed = await screen.findByRole('table', { name: 'On-time delivery (on_time_pct)' })
    const rule = within(changed).getByRole('row', { name: /rule/ })
    const [before, after] = within(rule).getAllByRole('cell')
    expect(before?.textContent).toContain('"value": 90')
    expect(after?.textContent).toContain('"value": 95')
    expect(screen.getByText(/1 metric differs from the version in force/)).toBeTruthy()
  })

  it('edits categories and measures in tables and saves them', async () => {
    const { user } = await setup()
    await openDraft(user)
    await user.type(screen.getByLabelText('Category 1 name'), ' Work')
    await user.selectOptions(screen.getByLabelText('Measure 2 time aggregation'), 'latest')
    await user.click(screen.getByRole('button', { name: 'Add category' }))
    await user.type(screen.getByLabelText('Category 3 ID'), 'cost')
    await user.click(screen.getByRole('button', { name: 'Add measure' }))
    await user.type(screen.getByLabelText('Measure 3 key'), 'spend')
    await user.selectOptions(screen.getByLabelText('Measure 3 org aggregation'), 'average')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const content = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { categories: unknown[]; measures: unknown[] } })
      .content
    expect(content.categories[0]).toMatchObject({ id: 'delivery', name: 'Delivery Work', order: 1 })
    expect(content.categories[2]).toMatchObject({ id: 'cost', order: 3 })
    expect(content.measures[1]).toMatchObject({ key: 'total', timeAgg: 'latest' })
    expect(content.measures[2]).toMatchObject({ key: 'spend', orgAgg: 'average', timeAgg: 'sum' })
  })

  it('lets the key change only for a metric that has not been saved', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    expect((screen.getByLabelText('Key') as HTMLInputElement).readOnly).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Add metric' }))
    await screen.findByRole('heading', { level: 3, name: 'Edit metric: Metric 3' })
    const key = screen.getByLabelText('Key') as HTMLInputElement
    expect(key.readOnly).toBe(false)
    await user.type(key, 'cycle_time')
    await user.type(screen.getByLabelText('Name'), 'Cycle time')
    await user.type(screen.getByLabelText('Formula'), 'total')
    await user.click(screen.getByLabelText('Org level: Company'))
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const added = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { metrics: Record<string, unknown>[] } }).content.metrics[2]
    expect(added).toMatchObject({
      key: 'cycle_time',
      name: 'Cycle time',
      formula: 'total',
      categoryId: 'delivery',
      reportedAt: [{ kind: 'level', id: 'company' }],
    })
    // Saved, so the key is fixed now.
    await waitFor(() => expect((screen.getByLabelText('Key') as HTMLInputElement).readOnly).toBe(true))
  })

  it('edits reported-at levels and kinds', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    const company = screen.getByLabelText('Org level: Company') as HTMLInputElement
    expect(company.checked).toBe(true)
    await user.click(company)
    await user.click(screen.getByLabelText('Item kind: Service'))
    await user.click(screen.getByLabelText('Roll item values up to their org unit'))
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const m = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { metrics: Record<string, unknown>[] } }).content.metrics[0]
    expect(m).toMatchObject({ reportedAt: [{ kind: 'item_kind', id: 'service' }], rollItemsToOrg: true })
  })

  it('edits bands with an else row, adding and removing condition rows', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    const bands = screen.getByRole('group', { name: 'Bands' })
    expect((within(bands).getByLabelText('Else status') as HTMLSelectElement).value).toBe('R')
    expect(within(bands).getByText('Otherwise (no other row matches)')).toBeTruthy()
    expect(within(bands).queryByLabelText('Band 3 status')).toBeNull()
    await user.selectOptions(within(bands).getByLabelText('Else status'), 'Y')
    await user.click(within(bands).getByRole('button', { name: 'Add band' }))
    await user.selectOptions(within(bands).getByLabelText('Band 3 status'), 'R')
    await user.selectOptions(within(bands).getByLabelText('Band 3 operator'), '<')
    await user.clear(within(bands).getByLabelText('Band 3 value'))
    await user.type(within(bands).getByLabelText('Band 3 value'), '-4.5')
    await user.click(within(bands).getByRole('button', { name: 'Remove band 1' }))
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const m = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { metrics: { rule: unknown }[] } }).content.metrics[0]
    expect(m?.rule).toEqual({
      type: 'bands',
      bands: [
        { status: 'Y', op: '>=', value: 75 },
        { status: 'R', op: '<', value: -4.5 },
        { status: 'Y', op: '', value: 0 },
      ],
    })
  })

  it('switches rule types: compare select for change rules, scale steps for scale rules', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'Defect rate')
    expect((screen.getByLabelText('Change is measured against') as HTMLSelectElement).value).toBe('prior_period')
    await user.selectOptions(screen.getByLabelText('Change is measured against'), 'baseline')
    await user.selectOptions(screen.getByLabelText('Rule type'), 'scale')
    expect(screen.queryByLabelText('Change is measured against')).toBeNull()
    const scale = screen.getByRole('group', { name: 'Scale steps' })
    await user.selectOptions(within(scale).getByLabelText('Step 1 status'), 'Y')
    await user.clear(within(scale).getByLabelText('Step 1 minimum'))
    await user.type(within(scale).getByLabelText('Step 1 minimum'), '50')
    await user.click(within(scale).getByRole('button', { name: 'Add step' }))
    await user.selectOptions(within(scale).getByLabelText('Step 2 status'), 'G')
    await user.clear(within(scale).getByLabelText('Step 2 minimum'))
    await user.type(within(scale).getByLabelText('Step 2 minimum'), '90')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const m = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { metrics: { rule: { type: string; scale: unknown; compare?: string } }[] } }).content.metrics[1]
    expect(m?.rule.type).toBe('scale')
    expect(m?.rule.scale).toEqual([
      { status: 'Y', min: 50 },
      { status: 'G', min: 90 },
    ])
  })

  it('shows a JSON parse error inline in the Advanced panel and holds publishing', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    const advanced = screen.getByLabelText(/Advanced \(JSON\)/)
    await user.click(advanced)
    await user.clear(advanced)
    await user.paste('{ "targets": [')
    expect(advanced.getAttribute('aria-invalid')).toBe('true')
    expect(describedText(advanced)).toMatch(/Not valid JSON/)
    expect((screen.getByRole('button', { name: 'Publish…' }) as HTMLButtonElement).disabled).toBe(true)

    await user.clear(advanced)
    await user.paste(
      '{"targets":[{"label":"FY27","from":"","to":"","value":95,"subjectId":""}],"perSubject":[{"subjectId":"north","bands":[{"status":"G","op":">=","value":80},{"status":"R","op":"","value":0}]}]}',
    )
    expect(advanced.getAttribute('aria-invalid')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1))
    const m = (writes('PUT', `${V}/ver-2`)[0]?.body as { content: { metrics: { targets: unknown; rule: { perSubject: unknown } }[] } }).content.metrics[0]
    expect(m?.targets).toEqual([{ label: 'FY27', from: '', to: '', value: 95, subjectId: '' }])
    expect(m?.rule.perSubject).toEqual([
      { subjectId: 'north', bands: [{ status: 'G', op: '>=', value: 80 }, { status: 'R', op: '', value: 0 }] },
    ])
  })

  it('rejects JSON of the wrong shape', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    const advanced = screen.getByLabelText(/Advanced \(JSON\)/)
    await user.click(advanced)
    await user.clear(advanced)
    await user.paste('{"targets": 3}')
    expect(describedText(advanced)).toMatch(/"targets" must be a list/)
  })

  it('shows a formula error from validation under the formula field', async () => {
    fake.validateErrors = [{ path: 'metrics[0].formula', message: 'unknown measure "closd"' }]
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    await user.click(screen.getByRole('button', { name: 'Validate' }))
    const formula = screen.getByLabelText('Formula')
    await waitFor(() => expect(formula.getAttribute('aria-invalid')).toBe('true'))
    expect(describedText(formula)).toContain('unknown measure "closd"')
    expect(document.activeElement).toBe(formula)
    expect(writes('POST', `${V}/ver-2/validate`)).toHaveLength(1)
    // Nothing was changed, so nothing was saved first.
    expect(writes('PUT', `${V}/ver-2`)).toHaveLength(0)
    expect(screen.getByText(/Validated: 1 problem found/)).toBeTruthy()
  })

  it('saves unsaved edits before validating them', async () => {
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    const formula = screen.getByLabelText('Formula')
    await user.clear(formula)
    await user.type(formula, 'closed')
    expect(writes('POST', `${V}/ver-2/validate`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Check formula' }))
    await waitFor(() => expect(writes('POST', `${V}/ver-2/validate`)).toHaveLength(1))
    expect(writes('PUT', `${V}/ver-2`)).toHaveLength(1)
    expect(await screen.findByText(/Validated: no problems found/)).toBeTruthy()
  })

  it('lists every problem: at fields, at other metrics, and with no field', async () => {
    fake.validateErrors = [
      { path: 'metrics[0].rule.bands[1].status', message: 'status Q is not in the status scale' },
      { path: 'metrics[1].formula', message: 'formula is empty' },
      { path: 'categories[0].id', message: 'id is not unique' },
      { path: 'measures[0].name', message: 'name is empty' },
      { path: '', message: 'methodology has no metrics in use' },
    ]
    const { user } = await setup()
    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    await user.click(screen.getByRole('button', { name: 'Validate' }))
    const bands = await screen.findByRole('group', { name: 'Bands' })
    expect(within(bands).getByText(/\[1\]\.status: status Q is not in the status scale/)).toBeTruthy()
    const cat = screen.getByLabelText('Category 1 ID')
    expect(describedText(cat)).toContain('id is not unique')
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent ?? '')
    const text = alerts.join('\n')
    expect(text).toContain('Defect rate: formula: formula is empty')
    expect(text).toContain('measures[0].name: name is empty')
    expect(text).toContain('methodology has no metrics in use')
    const metrics = screen.getByRole('table', { name: 'Metrics' })
    expect(within(metrics).getByRole('row', { name: /Defect rate.*1 problem/ })).toBeTruthy()
  })

  it('offers to reload when the draft changed since it was opened (409)', async () => {
    const { user } = await setup()
    await openDraft(user)
    // Someone else saves the draft.
    const stored = fake.versions.find((v) => v.id === 'ver-2')!
    stored.name = 'Renamed elsewhere'
    stored.revision = 4
    await user.type(screen.getByLabelText('Draft name'), ' mine')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const alert = await screen.findByText(/This draft was changed somewhere else/)
    expect(alert.closest('[role="alert"]')).toBeTruthy()
    expect(writes('PUT', `${V}/ver-2`)[0]?.body).toMatchObject({ revision: 1 })
    expect(screen.getByText(/You have unsaved changes/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Reload draft' }))
    await waitFor(() => expect((screen.getByLabelText('Draft name') as HTMLInputElement).value).toBe('Renamed elsewhere'))
    expect(screen.queryByText(/This draft was changed somewhere else/)).toBeNull()
    expect(screen.getByText('All changes are saved.')).toBeTruthy()

    // The next save uses the reloaded revision.
    await user.type(screen.getByLabelText('Draft name'), '!')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(writes('PUT', `${V}/ver-2`)).toHaveLength(2))
    expect(writes('PUT', `${V}/ver-2`)[1]?.body).toMatchObject({ revision: 4, name: 'Renamed elsewhere!' })
  })

  it('compares against a chosen version: added, removed and changed metrics', async () => {
    const { user } = await setup()
    await openDraft(user)
    await screen.findByText(/No differences from the version in force/)
    await user.selectOptions(screen.getByLabelText('Compare against'), 'ver-0')
    expect(await screen.findByText(/2 metrics differ from FY25 published/)).toBeTruthy()
    const added = screen.getByRole('region', { name: 'Added metrics' })
    expect(within(added).getByText('Defect rate (defect_rate)')).toBeTruthy()
    // Pretty JSON for a rule.
    expect(added.textContent).toContain('"type": "change"')
    const changed = screen.getByRole('table', { name: 'On-time delivery (on_time_pct)' })
    const formula = within(changed).getByRole('row', { name: /formula/ })
    expect(within(formula).getByText('closed / total')).toBeTruthy()
    expect(within(formula).getByText('closed / total * 100')).toBeTruthy()
  })

  it('shows removed metrics and field changes against the older version', async () => {
    const { user } = await setup()
    // Compare the older version with the one in force: its formula differs and the newer has an extra metric.
    await user.click(screen.getByRole('button', { name: 'View FY25 published' }))
    await screen.findByRole('heading', { level: 2, name: /Viewing FY25 published/ })
    expect(await screen.findByText(/2 metrics differ from the version in force/)).toBeTruthy()
    const removed = screen.getByRole('region', { name: 'Removed metrics' })
    expect(within(removed).getByText('Defect rate (defect_rate)')).toBeTruthy()
    const changed = screen.getByRole('table', { name: 'On-time delivery (on_time_pct)' })
    expect(within(changed).queryByRole('row', { name: /formula/ })).toBeTruthy()
  })

  it('shows a version in review read-only', async () => {
    fake.versions[0]!.status = 'in_review'
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'View FY27 proposal' }))
    expect(await screen.findByText(/cannot be edited/)).toBeTruthy()
    expect(screen.getAllByText('In review')).toHaveLength(2)
  })
})

describe('MethodologyPage publishing', () => {
  const when = () => addMonths(currentMonth(1), 3)

  it('publishes from the chosen month and refreshes the version list', async () => {
    const { user } = await setup()
    await openDraft(user)
    await user.click(screen.getByRole('button', { name: 'Publish…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Publish FY27 proposal' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await user.selectOptions(within(dialog).getByLabelText('Effective month'), when())
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(writes('POST', `${V}/ver-2/publish`)).toHaveLength(1))
    expect(writes('POST', `${V}/ver-2/publish`)[0]?.body).toEqual({ effectiveFrom: when() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText(/Published FY27 proposal, effective/)).toBeTruthy()
    const table = screen.getByRole('table', { name: /Methodology versions/ })
    await waitFor(() => expect(within(within(table).getByRole('row', { name: /FY27 proposal/ })).getByText('Published')).toBeTruthy())
    expect(await screen.findByText(/cannot be edited/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull()
  })

  it('says plainly when the version published but the numbers from records were not updated', async () => {
    const { user } = await setup()
    server.use(
      http.post(`${API}/v1/scorecards/sc-main/versions/ver-2/publish`, () =>
        HttpResponse.json({
          ...fake.versions.find((v) => v.id === 'ver-2')!,
          status: 'published',
          effectiveFrom: when(),
          recalculated: 0,
          recalculationError: 'derived values could not be recalculated; they update with the next records upload or publish',
        }),
      ),
    )
    await openDraft(user)
    await user.click(screen.getByRole('button', { name: 'Publish…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Publish FY27 proposal' })
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const notice = await screen.findByText(/but the numbers that come from records couldn’t be updated yet/)
    expect(notice.textContent).toMatch(/^Published FY27 proposal, effective .*\. They update with your next records upload or publish\.$/)
    expect(notice.className).not.toContain('text-status-g')
  })

  it('lists the details when the server refuses (400) and keeps the dialog open', async () => {
    fake.failNext.set(`POST ${V}/ver-2/publish`, {
      status: 400,
      code: 'invalid',
      message: 'methodology is invalid',
      details: [
        { path: 'metrics[0].formula', message: 'unknown measure "closd"' },
        { path: 'categories[1].id', message: 'id is not unique' },
      ],
    })
    const { user } = await setup()
    await openDraft(user)
    await user.click(screen.getByRole('button', { name: 'Publish…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Publish FY27 proposal' })
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    const list = await within(dialog).findByRole('alert')
    expect(list.textContent).toContain('metrics[0].formula: unknown measure "closd"')
    expect(list.textContent).toContain('categories[1].id: id is not unique')
    expect(document.activeElement).toBe(list)
    expect(screen.getByRole('dialog', { name: 'Publish FY27 proposal' })).toBeTruthy()
  })

  it('shows a conflict (409)', async () => {
    fake.failNext.set(`POST ${V}/ver-2/publish`, {
      status: 409,
      code: 'conflict',
      message: 'version ver-1 is already effective from 2027-M02',
    })
    const { user } = await setup()
    await openDraft(user)
    await user.click(screen.getByRole('button', { name: 'Publish…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Publish FY27 proposal' })
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('already effective from 2027-M02')
  })

  it('cannot publish while there are unsaved changes', async () => {
    const { user } = await setup()
    await openDraft(user)
    await user.type(screen.getByLabelText('Draft name'), ' v2')
    expect((screen.getByRole('button', { name: 'Publish…' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish…' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('MethodologyPage accessibility', () => {
  it('has no axe violations on the page, the editor, the metric form and its dialogs', async () => {
    const { user, container } = await setup()
    expect((await axe(container)).violations).toEqual([])

    await user.click(screen.getByRole('button', { name: 'New draft from…' }))
    const newDraft = await screen.findByRole('dialog', { name: 'New draft' })
    expect(newDraft.contains(document.activeElement)).toBe(true)
    expect((await axe(newDraft)).violations).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await openDraft(user)
    await openMetric(user, 'On-time delivery')
    fake.validateErrors = [
      { path: 'metrics[0].formula', message: 'unknown measure "closd"' },
      { path: 'metrics[1].formula', message: 'formula is empty' },
    ]
    await user.click(screen.getByRole('button', { name: 'Validate' }))
    await screen.findByText(/Validated: 2 problems found/)
    expect((await axe(container)).violations).toEqual([])

    const trigger = screen.getByRole('button', { name: 'Publish…' })
    await user.click(trigger)
    const publish = await screen.findByRole('dialog', { name: 'Publish FY27 proposal' })
    expect((await axe(publish)).violations).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('has no axe violations in the read-only view', async () => {
    const { user, container } = await setup()
    await user.click(screen.getByRole('button', { name: 'View FY26 published' }))
    await screen.findByText(/No differences from the version in force/)
    expect((await axe(container)).violations).toEqual([])
  })
})
