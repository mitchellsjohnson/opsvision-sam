import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import {
  UPLOAD_ORIGIN,
  methodologyHandlers,
  newMethodologyFake,
  type MethodologyFake,
} from '../../test/methodologyFixtures'
import { server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { XLSX_TYPE } from './importModel'
import { ImportPage } from './ImportPage'

let fake: MethodologyFake

beforeEach(() => {
  fake = newMethodologyFake()
  server.use(...methodologyHandlers(fake))
})

function workbook(name = 'legacy.xlsx') {
  return new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3])], name, { type: XLSX_TYPE })
}

async function setup(options: { applyAccept?: boolean } = {}) {
  const user = userEvent.setup(options)
  const view = renderApp(<ImportPage />, { route: '/admin/import?kind=legacy' })
  await screen.findByRole('table', { name: 'Import templates' })
  await screen.findByRole('option', { name: 'Legacy workbook' })
  return { user, ...view }
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

async function upload(user: ReturnType<typeof userEvent.setup>, file = workbook()) {
  await user.upload(screen.getByLabelText('Workbook (.xlsx)'), file)
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await screen.findByText(/Uploaded legacy.xlsx/)
}

async function parse(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Template'), 'legacy-main')
  await user.click(screen.getByRole('button', { name: 'Parse' }))
  await screen.findByRole('heading', { level: 3, name: 'Preview' })
}

describe('ImportPage kinds', () => {
  it('offers Records first, then Legacy workbook, and keeps the choice in the URL', async () => {
    const user = userEvent.setup()
    renderApp(<ImportPage />, { route: '/admin/import' })
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Records', 'Legacy workbook'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('group', { name: 'Drop files to upload' })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'Legacy workbook' }))
    expect(await screen.findByRole('table', { name: 'Import templates' })).toBeTruthy()
  })

  it('lists only legacy templates on the Legacy workbook tab', async () => {
    fake.templates.push({ id: 'defects-export', name: 'Defects export', profile: 'records', body: {} })
    await setup()
    expect(screen.queryByRole('row', { name: /Defects export/ })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Defects export' })).toBeNull()
  })
})

describe('ImportPage templates', () => {
  it('lists the templates', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Import' })).toBeTruthy()
    const row = within(screen.getByRole('table', { name: 'Import templates' })).getByRole('row', {
      name: /Legacy workbook/,
    })
    expect(within(row).getByText('legacy-main')).toBeTruthy()
  })

  it('creates a template from a name, the profile and a JSON body', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New template' }))
    const dialog = await screen.findByRole('dialog', { name: 'New template' })
    await user.type(within(dialog).getByLabelText('Name'), 'Quarterly export')
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).value).toBe('quarterly-export')
    expect((within(dialog).getByLabelText('Profile') as HTMLSelectElement).value).toBe('legacy_workbook')
    const body = within(dialog).getByLabelText(/Mapping/)
    await user.click(body)
    await user.clear(body)
    await user.paste('{"sheets": [], "rows": [], "methodology": [], "scorecardId": "sc-main"}')
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(writes('PUT', '/import-templates/quarterly-export')).toHaveLength(1))
    expect(writes('PUT', '/import-templates/quarterly-export')[0]?.body).toEqual({
      id: 'quarterly-export',
      name: 'Quarterly export',
      profile: 'legacy_workbook',
      body: { sheets: [], rows: [], methodology: [], scorecardId: 'sc-main' },
    })
    expect(await screen.findByText('Saved the template Quarterly export.')).toBeTruthy()
    expect(await screen.findByRole('row', { name: /Quarterly export/ })).toBeTruthy()
  })

  it('edits a template: its ID stays', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Edit template Legacy workbook' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Legacy workbook' })
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).readOnly).toBe(true)
    const name = within(dialog).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Main workbook')
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).value).toBe('legacy-main')
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(writes('PUT', '/import-templates/legacy-main')).toHaveLength(1))
    expect(writes('PUT', '/import-templates/legacy-main')[0]?.body).toMatchObject({
      name: 'Main workbook',
      id: 'legacy-main',
    })
  })

  it('shows JSON errors at the body field without sending anything', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New template' }))
    const dialog = await screen.findByRole('dialog', { name: 'New template' })
    await user.type(within(dialog).getByLabelText('Name'), 'Broken')
    const body = within(dialog).getByLabelText(/Mapping/)
    await user.click(body)
    await user.clear(body)
    await user.paste('{ "sheets": ')
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }))
    expect(body.getAttribute('aria-invalid')).toBe('true')
    expect(describedText(body)).toMatch(/Not valid JSON/)
    expect(document.activeElement).toBe(body)
    expect(writes('PUT', '/import-templates/broken')).toHaveLength(0)
  })

  it('shows the details of a server rejection (400)', async () => {
    fake.failNext.set('PUT /import-templates/bad', {
      status: 400,
      code: 'invalid',
      message: 'template is not valid',
      details: [
        { path: 'body.sheets[0].labelColumn', message: 'must be a column letter' },
        { path: 'name', message: 'is already used' },
      ],
    })
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'New template' }))
    const dialog = await screen.findByRole('dialog', { name: 'New template' })
    await user.type(within(dialog).getByLabelText('Name'), 'Bad')
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('body.sheets[0].labelColumn: must be a column letter')
    expect(describedText(within(dialog).getByLabelText('Name'))).toContain('is already used')
    expect(screen.getByRole('dialog', { name: 'New template' })).toBeTruthy()
  })
})

describe('ImportPage upload and parse', () => {
  it('uploads the workbook to the pre-signed URL without the API token', async () => {
    const { user } = await setup()
    const input = screen.getByLabelText('Workbook (.xlsx)') as HTMLInputElement
    expect(input.accept).toBe('.xlsx')
    expect((screen.getByLabelText('Template') as HTMLSelectElement).closest('fieldset')?.disabled).toBe(true)
    await user.upload(input, workbook())
    expect(screen.getByText(/legacy.xlsx \(1 KB\)/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText('Uploaded legacy.xlsx. Choose a template and parse it.')).toBeTruthy()
    expect(writes('POST', '/imports/uploads')[0]?.body).toEqual({ filename: 'legacy.xlsx', contentType: XLSX_TYPE })
    expect(fake.uploads).toHaveLength(1)
    expect(fake.uploads[0]).toEqual({
      url: `${UPLOAD_ORIGIN}/put/imp-1?sig=abc`,
      contentType: XLSX_TYPE,
      authorization: null,
      bytes: 7,
    })
    expect((screen.getByLabelText('Template') as HTMLSelectElement).closest('fieldset')?.disabled).toBe(false)
  })

  it('reports an upload the storage refuses, and allows trying again', async () => {
    fake.failNext.set('PUT upload', { status: 403, code: 'forbidden', message: 'expired' })
    const { user } = await setup()
    await user.upload(screen.getByLabelText('Workbook (.xlsx)'), workbook())
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The upload was refused (status 403)')
    expect((screen.getByLabelText('Template') as HTMLSelectElement).closest('fieldset')?.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/Uploaded legacy.xlsx/)).toBeTruthy()
    expect(fake.uploads).toHaveLength(2)
  })

  it('needs a .xlsx file', async () => {
    const { user } = await setup({ applyAccept: false })
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    const input = screen.getByLabelText('Workbook (.xlsx)')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(describedText(input)).toContain('Choose a .xlsx workbook first.')
    await user.upload(input, new File(['a,b'], 'data.csv', { type: 'text/csv' }))
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    expect(describedText(screen.getByLabelText('Workbook (.xlsx)'))).toContain('Only .xlsx workbooks can be imported.')
    expect(writes('POST', '/imports/uploads')).toHaveLength(0)
  })

  it('parses to a preview with counts, findings with cell references, and a sample', async () => {
    const { user } = await setup()
    await upload(user)
    await user.click(screen.getByRole('button', { name: 'Parse' }))
    expect(describedText(screen.getByLabelText('Template'))).toContain('Choose a template.')
    expect(writes('POST', '/imports/imp-1/parse')).toHaveLength(0)
    await parse(user)
    expect(writes('POST', '/imports/imp-1/parse')[0]?.body).toEqual({
      profile: 'legacy_workbook',
      templateId: 'legacy-main',
    })

    expect(within(screen.getByText('Data points').closest('div')!).getByText('12')).toBeTruthy()
    expect(within(screen.getByText('Overrides').closest('div')!).getByText('1')).toBeTruthy()
    expect(within(screen.getByText('Methodology text changes').closest('div')!).getByText('3')).toBeTruthy()
    expect(within(screen.getByText('Legacy notes').closest('div')!).getByText('2')).toBeTruthy()

    const findings = screen.getByRole('table', { name: /Findings/ })
    const warn = within(findings).getByRole('row', { name: /Warning/ })
    expect(within(warn).getByText('Scorecard')).toBeTruthy()
    expect(within(warn).getByText('F7')).toBeTruthy()
    expect(within(warn).getByText('Cell text "n/a" was skipped')).toBeTruthy()

    const sample = screen.getByRole('table', { name: /Sample of the changes/ })
    expect(within(sample).getByRole('row', { name: /Data point.*closed.*north.*2025-M01.*40/ })).toBeTruthy()
    expect(within(sample).getByText('Not applicable: Not measured')).toBeTruthy()
    expect(within(sample).getByRole('row', { name: /Override.*on_time_pct.*71, status Y/ })).toBeTruthy()
    expect(
      within(sample).getByRole('row', { name: /Methodology text.*definition: Share of epics done on time/ }),
    ).toBeTruthy()
    expect(screen.getByText('Showing 4 of 16 changes.')).toBeTruthy()
  })

  it('filters findings by severity', async () => {
    fake.preview.findings = [
      { severity: 'error', sheet: 'Scorecard', cell: 'B3', message: 'Unknown subject' },
      { severity: 'warn', sheet: 'Scorecard', cell: 'F7', message: 'Skipped a cell' },
      { severity: 'warn', sheet: 'Scorecard', cell: 'F8', message: 'Skipped another cell' },
      { severity: 'info', sheet: 'Methodology', cell: 'C2', message: 'Definition replaced' },
    ]
    const { user } = await setup()
    await upload(user)
    await parse(user)
    const rows = () => within(screen.getByRole('table', { name: /Findings/ })).getAllByRole('row').length - 1
    expect(rows()).toBe(4)
    const filter = screen.getByLabelText('Show')
    expect(within(filter).getByRole('option', { name: 'Warnings (2)' })).toBeTruthy()
    await user.selectOptions(filter, 'warn')
    expect(rows()).toBe(2)
    expect(screen.getByText('Showing 2 of 4 findings.')).toBeTruthy()
    expect(screen.queryByText('Unknown subject')).toBeNull()
    await user.selectOptions(filter, 'error')
    expect(rows()).toBe(1)
    // Severity is text and an icon, not color.
    expect(within(screen.getByRole('table', { name: /Findings/ })).getByText('Error')).toBeTruthy()
    await user.selectOptions(filter, 'info')
    expect(screen.getByText('Definition replaced')).toBeTruthy()
    await user.selectOptions(filter, 'all')
    expect(rows()).toBe(4)
  })

  it('says so when there are no findings or nothing to change', async () => {
    fake.preview.findings = []
    fake.preview.sample = []
    fake.preview.counts = { dataPoints: 0, overrides: 0, versionText: 0, legacyNotes: 0 }
    const { user } = await setup()
    await upload(user)
    await parse(user)
    expect(screen.getByText('No findings.')).toBeTruthy()
    expect(screen.getByText('The import would not change anything.')).toBeTruthy()
  })

  it('allows parsing again, with another template', async () => {
    fake.templates.push({ id: 'second', name: 'Second layout', profile: 'legacy_workbook', body: {} })
    const { user } = await setup()
    await upload(user)
    await parse(user)
    fake.preview = { ...fake.preview, counts: { ...fake.preview.counts, dataPoints: 20 } }
    await user.selectOptions(screen.getByLabelText('Template'), 'second')
    await user.click(screen.getByRole('button', { name: 'Parse again' }))
    await waitFor(() => expect(writes('POST', '/imports/imp-1/parse')).toHaveLength(2))
    expect(writes('POST', '/imports/imp-1/parse')[1]?.body).toEqual({
      profile: 'legacy_workbook',
      templateId: 'second',
    })
    expect(await screen.findByText('20')).toBeTruthy()
    expect(screen.getByText(/Parsed with the template Second layout/)).toBeTruthy()
  })

  it('shows a parse failure (400 with details)', async () => {
    fake.failNext.set('POST /imports/imp-1/parse', {
      status: 400,
      code: 'invalid',
      message: 'template is not valid',
      details: [{ path: 'body.rows[2].convert', message: 'unknown converter "frob"' }],
    })
    const { user } = await setup()
    await upload(user)
    await user.selectOptions(screen.getByLabelText('Template'), 'legacy-main')
    await user.click(screen.getByRole('button', { name: 'Parse' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('body.rows[2].convert: unknown converter "frob"')
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })
})

describe('ImportPage apply', () => {
  it('confirms with the counts, then applies and says what happened', async () => {
    const { user } = await setup()
    await upload(user)
    await parse(user)
    await user.click(screen.getByRole('button', { name: 'Apply…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply this import?' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(dialog.textContent).toContain('12 data points, 1 override, 3 methodology text changes, 2 legacy notes')
    expect(writes('POST', '/imports/imp-1/apply')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))
    await waitFor(() => expect(writes('POST', '/imports/imp-1/apply')).toHaveLength(1))
    expect(await screen.findByText(/Applied: 12 data points, 1 override/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Import another workbook' })).toBeTruthy()
  })

  it('can be cancelled without applying', async () => {
    const { user } = await setup()
    await upload(user)
    await parse(user)
    const trigger = screen.getByRole('button', { name: 'Apply…' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Apply this import?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(writes('POST', '/imports/imp-1/apply')).toHaveLength(0)
  })

  it('is disabled for a contributor, with the reason', async () => {
    state.role = 'contributor'
    const { user } = await setup()
    await upload(user)
    await parse(user)
    expect((screen.getByRole('button', { name: 'Apply…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Only admins can apply an import.')).toBeTruthy()
  })

  it('is disabled while the preview has errors, and says how many', async () => {
    fake.preview.findings = [
      { severity: 'error', sheet: 'Scorecard', cell: 'B3', message: 'Unknown subject' },
      { severity: 'error', sheet: 'Scorecard', cell: 'B4', message: 'Unknown metric' },
    ]
    const { user } = await setup()
    await upload(user)
    await parse(user)
    expect((screen.getByRole('button', { name: 'Apply…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/2 errors must be fixed before this import can be applied/)).toBeTruthy()
  })

  it('shows a rejection with findings (400)', async () => {
    fake.failNext.set('POST /imports/imp-1/apply', {
      status: 400,
      code: 'invalid',
      message: 'the change set has errors',
      details: [{ path: 'findings[0]', message: 'Scorecard!B3: unknown subject' }],
    })
    const { user } = await setup()
    await upload(user)
    await parse(user)
    await user.click(screen.getByRole('button', { name: 'Apply…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply this import?' })
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('findings[0]: Scorecard!B3: unknown subject')
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByText(/Applied:/)).toBeNull()
  })

  it('shows a conflict (409) when the import was already applied', async () => {
    fake.failNext.set('POST /imports/imp-1/apply', {
      status: 409,
      code: 'conflict',
      message: 'import is applied; only a parsed import can be applied',
    })
    const { user } = await setup()
    await upload(user)
    await parse(user)
    await user.click(screen.getByRole('button', { name: 'Apply…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply this import?' })
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('only a parsed import can be applied')
  })

  it('starts over with another workbook', async () => {
    const { user } = await setup()
    await upload(user)
    await parse(user)
    await user.click(screen.getByRole('button', { name: 'Apply…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply this import?' })
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))
    await user.click(await screen.findByRole('button', { name: 'Import another workbook' }))
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    expect((screen.getByLabelText('Template') as HTMLSelectElement).closest('fieldset')?.disabled).toBe(true)
  })
})

describe('ImportPage accessibility', () => {
  it('has no axe violations on the page, the preview and the dialogs', async () => {
    const { user, container } = await setup()
    expect((await axe(container)).violations).toEqual([])

    for (const [open, title] of [
      ['New template', 'New template'],
      ['Edit template Legacy workbook', 'Edit Legacy workbook'],
    ] as const) {
      const trigger = screen.getByRole('button', { name: open })
      await user.click(trigger)
      const dialog = await screen.findByRole('dialog', { name: title })
      expect(dialog.contains(document.activeElement)).toBe(true)
      expect((await axe(dialog)).violations).toEqual([])
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(trigger)
    }

    await upload(user)
    await parse(user)
    expect((await axe(container)).violations).toEqual([])

    const trigger = screen.getByRole('button', { name: 'Apply…' })
    await user.click(trigger)
    const apply = await screen.findByRole('dialog', { name: 'Apply this import?' })
    expect((await axe(apply)).violations).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
