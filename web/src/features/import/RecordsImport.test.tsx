import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../api/schema'
import {
  CSV_TYPE,
  RECORDS_UPLOAD_ORIGIN,
  XLSX_TYPE,
  emptyPreview,
  epicsPreview,
  newRecordsFake,
  recordTemplate,
  recordsHandlers,
  requestsTo,
  type RecordsFake,
} from '../../test/recordsFixtures'
import { server, state } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { ImportPage } from '../admin/ImportPage'
import { ScorecardPage } from '../scorecard/ScorecardPage'
import { RecordsImport } from './RecordsImport'
import { todayISO } from './recordsModel'

type PreviewBody = components['schemas']['RecordsPreviewRequest']
type ApplyBody = components['schemas']['ApplyImportRequest']

let fake: RecordsFake

beforeEach(() => {
  fake = newRecordsFake()
  server.use(...recordsHandlers(fake))
})

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

function csv(name: string) {
  return new File(['Issue key,Product\nCHK-1,Checkout\n'], name, { type: CSV_TYPE })
}

function xlsx(name: string) {
  return new File([new Uint8Array([80, 75, 3, 4])], name, { type: XLSX_TYPE })
}

async function renderImportPage() {
  const user = userEvent.setup()
  const view = renderApp(
    <>
      <Routes>
        <Route path="/admin/import" element={<ImportPage />} />
        <Route path="/admin/import/setup" element={<h1>Setup</h1>} />
      </Routes>
      <Probe />
    </>,
    { route: '/admin/import' },
  )
  await screen.findByRole('group', { name: 'Drop files to upload' })
  return { user, ...view }
}

function dropOn(target: Element, files: File[]) {
  const dataTransfer = { files, types: ['Files'], items: files.map(() => ({ kind: 'file' })) }
  fireEvent.dragEnter(target, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
}

function dropZone() {
  return screen.getByRole('group', { name: 'Drop files to upload' })
}

function card(filename: string) {
  return screen.getByRole('region', { name: filename })
}

async function previewed(filename: string) {
  const region = await screen.findByRole('region', { name: filename })
  await within(region).findByRole('heading', { name: 'What changes on the scorecard' })
  return region
}

function previews(importId: string): PreviewBody[] {
  return requestsTo(fake, 'POST', `/imports/${importId}/records-preview`).map((r) => r.body as PreviewBody)
}

/** The import ID the fake gave a file, from the upload requests. */
function importIdOf(filename: string) {
  const i = requestsTo(fake, 'POST', '/imports/uploads').findIndex((r) => (r.body as { filename: string }).filename === filename)
  return `imp-${i + 1}`
}

function lineText(text: string) {
  return (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === text
}

const forbidden = /subject|source key|revision|snapshot/i

describe('RecordsImport: drop and preview', () => {
  it('previews two dropped files separately, each recognized by its template', async () => {
    await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv'), xlsx('epics.xlsx')])

    const defects = await previewed('defects.csv')
    const epics = await previewed('epics.xlsx')
    expect(within(defects).getByText(lineText('Looks like your Defects export: 1,204 rows, 37 changed since your October 31 upload.'))).toBeTruthy()
    expect(within(defects).getByText('Defects export').tagName).toBe('EM')
    expect(within(epics).getByText(lineText('Looks like your Epics export: 316 rows, 12 changed since your last upload.'))).toBeTruthy()

    // Each file goes to its pre-signed URL as its own type, without the API token.
    expect(fake.uploads.map((u) => [u.contentType, u.authorization]).sort()).toEqual([
      [XLSX_TYPE, null],
      [CSV_TYPE, null],
    ])
    expect(fake.uploads.every((u) => u.url.startsWith(`${RECORDS_UPLOAD_ORIGIN}/put/`))).toBe(true)
    expect(previews(importIdOf('defects.csv'))[0]).toEqual({
      scorecardId: 'sc-main',
      asOf: todayISO(),
      templateId: 'defects-export',
      answers: {},
    } satisfies PreviewBody)
  })

  it('names the year of a last upload from another year', async () => {
    const year = new Date().getFullYear() - 1
    fake.inspections['defects.csv']!.inspection.lastUploadAsOf = `${year}-12-30`
    await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    const defects = await previewed('defects.csv')
    expect(within(defects).getByText(lineText(`Looks like your Defects export: 1,204 rows, 37 changed since your December 30, ${year} upload.`))).toBeTruthy()
  })

  it('first previews without answers, then with the preselected product match', async () => {
    await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    await previewed('defects.csv')
    await waitFor(() => expect(previews('imp-1')).toHaveLength(2))
    expect(previews('imp-1')[0]?.answers).toEqual({})
    expect(previews('imp-1')[1]?.answers).toEqual({ sourceKeys: { 'Checkout Svc': 'checkout' } })
  })

  it('rejects files that are not .csv or .xlsx, with a message', async () => {
    await renderImportPage()
    dropOn(dropZone(), [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })])
    expect((await screen.findByRole('alert')).textContent).toContain('“notes.pdf” isn’t a .csv or .xlsx file.')
    expect(requestsTo(fake, 'POST', '/imports/uploads')).toHaveLength(0)
  })

  it('opens "Choose files" from the keyboard', async () => {
    const { user, container } = await renderImportPage()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('.csv,.xlsx')
    expect(input.multiple).toBe(true)
    const click = vi.spyOn(input, 'click')
    const choose = screen.getByRole('button', { name: 'Choose files' })
    for (let i = 0; i < 20 && document.activeElement !== choose; i++) await user.tab()
    expect(document.activeElement).toBe(choose)
    await user.keyboard('{Enter}')
    expect(click).toHaveBeenCalled()
    await user.upload(input, csv('defects.csv'))
    expect(await previewed('defects.csv')).toBeTruthy()
  })

  it('removes a file and returns focus to "Choose files"', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv'), xlsx('epics.xlsx')])
    await previewed('epics.xlsx')
    await user.click(screen.getByRole('button', { name: 'Remove epics.xlsx' }))
    expect(screen.queryByRole('region', { name: 'epics.xlsx' })).toBeNull()
    expect(screen.getByRole('region', { name: 'defects.csv' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose files' }))
  })

  it('hands an unrecognized file to the setup', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('mystery.csv')])
    const region = await screen.findByRole('region', { name: 'mystery.csv' })
    expect(await within(region).findByText('We haven’t seen this file before')).toBeTruthy()
    expect(requestsTo(fake, 'POST', '/imports/imp-1/records-preview')).toHaveLength(0)
    await user.click(within(region).getByRole('button', { name: 'Set up this file' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/import/setup?upload=imp-1'))
  })
})

describe('RecordsImport: the story', () => {
  it('expands a story line to the slipped epics, linked to the tracker', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [xlsx('epics.xlsx')])
    const region = await previewed('epics.xlsx')
    const line = within(region).getByRole('button', { name: /On-time delivery/ })
    expect(line.textContent).toContain('Oct 2026 · Billing · On-time delivery')
    expect(line.textContent).toContain('3 epics slipped: BIL-12, BIL-40, BIL-77')
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(within(region).queryByRole('link', { name: /BIL-12/ })).toBeNull()

    await user.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    for (const id of ['BIL-12', 'BIL-40', 'BIL-77']) {
      const link = within(region).getByRole('link', { name: new RegExp(id) })
      expect(link.getAttribute('href')).toBe(`https://tracker.example/browse/${id}`)
      expect(link.closest('li')?.textContent).toContain('slipped')
    }
  })

  it('explains columns, row problems, missing records and counts in plain words', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv'), xlsx('epics.xlsx')])
    const defects = await previewed('defects.csv')
    const epics = await previewed('epics.xlsx')

    expect(within(defects).getByText('This file has 2 new columns and is missing “Linked tickets”. We used what we could.')).toBeTruthy()
    const problems = within(defects).getByRole('table', { name: 'Rows we couldn’t read' })
    const row = within(problems).getByRole('row', { name: /12/ })
    expect(within(row).getByText('Created')).toBeTruthy()
    expect(within(row).getByText('Couldn’t read “31/02/2026” as Created')).toBeTruthy()
    // Unmapped values are asked, not listed as problems.
    expect(within(problems).getAllByRole('row')).toHaveLength(2)

    expect(within(epics).getByText('2 open records weren’t in this file')).toBeTruthy()
    const counts = within(defects).getByRole('heading', { name: 'Row counts' }).parentElement!
    expect(within(counts).getByText('New').nextElementSibling?.textContent).toBe('7')
    expect(within(counts).getByText('Changed').nextElementSibling?.textContent).toBe('30')

    await user.click(within(epics).getByRole('button', { name: /On-time delivery/ }))
    expect(document.body.textContent).not.toMatch(forbidden)

    await user.click(within(epics).getByRole('checkbox', { name: 'Mark them cancelled' }))
    await waitFor(() => expect(previews(importIdOf('epics.xlsx')).at(-1)?.answers).toEqual({ markMissingCancelled: true }))
  })

  it('says when nothing changed, in place of Apply', async () => {
    fake.previews['defects.csv'] = emptyPreview({
      counts: { new: 0, changed: 0, unchanged: 1204, skipped: 0, missing: 0, unmatched: 0, errors: 0 },
      story: { nothingChanged: true, lines: [], more: 0, typed: [], lockedWaiting: [] },
    })
    await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    await previewed('defects.csv')
    expect((await screen.findAllByText('Nothing changed since your last upload')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('re-runs the preview when the as-of date changes', async () => {
    await renderImportPage()
    dropOn(dropZone(), [xlsx('epics.xlsx')])
    const region = await previewed('epics.xlsx')
    const asOf = within(region).getByLabelText('As of') as HTMLInputElement
    expect(asOf.value).toBe(todayISO())
    fireEvent.change(asOf, { target: { value: '2026-10-31' } })
    await waitFor(() => expect(previews('imp-1').at(-1)?.asOf).toBe('2026-10-31'))
  })
})

describe('RecordsImport: needs your input', () => {
  it('re-previews with the product picked for an unmatched value', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    const region = await previewed('defects.csv')
    const checkout = within(region).getByLabelText(/Checkout Svc/) as HTMLSelectElement
    expect(checkout.value).toBe('to:checkout')
    const pmt = within(region).getByLabelText(/Pmt Gateway/) as HTMLSelectElement
    expect(pmt.value).toBe('')
    expect(within(pmt).getByRole('option', { name: 'Ignore these rows' })).toBeTruthy()
    await user.selectOptions(pmt, 'to:billing')
    await waitFor(() =>
      expect(previews('imp-1').at(-1)?.answers?.sourceKeys).toEqual({ 'Checkout Svc': 'checkout', 'Pmt Gateway': 'billing' }),
    )
    // The answered question stays on screen once the preview no longer asks it.
    expect((within(region).getByLabelText(/Pmt Gateway/) as HTMLSelectElement).value).toBe('to:billing')
  })

  it('offers a shared unit for a value that matches a parent', async () => {
    fake.previews['defects.csv'] = { ...fake.previews['defects.csv'] as components['schemas']['RecordsPreview'], parents: [{ value: 'Commerce', rows: 2, unitId: 'commerce' }] }
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    const region = await previewed('defects.csv')
    const commerce = within(region).getByLabelText(/“Commerce”/) as HTMLSelectElement
    await user.selectOptions(commerce, 'shared:commerce')
    expect(within(commerce).getByRole('option', { name: 'Create “Commerce (shared)”' })).toBeTruthy()
    await waitFor(() => expect(previews('imp-1').at(-1)?.answers?.createShared).toEqual(['commerce']))
  })

  it('maps a new value, and saves the answer to the template on apply', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv')])
    const region = await previewed('defects.csv')
    const urgent = within(region).getByLabelText(/New priority “Urgent”/) as HTMLSelectElement
    await user.selectOptions(urgent, 'P1')
    await waitFor(() => expect(previews('imp-1').at(-1)?.answers?.valueMaps).toEqual({ priority: { Urgent: 'P1' } }))
    const apply = screen.getByRole('button', { name: 'Apply' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    await user.click(apply)
    await waitFor(() => expect(requestsTo(fake, 'POST', '/imports/imp-1/apply')).toHaveLength(1))
    expect(requestsTo(fake, 'POST', '/imports/imp-1/apply')[0]?.body).toEqual({
      answers: { sourceKeys: { 'Checkout Svc': 'checkout' }, valueMaps: { priority: { Urgent: 'P1' } } },
      saveTemplate: { id: 'defects-export', name: 'Defects export' },
    } satisfies ApplyBody)
  })

  it('adds "Use records for this month" to the answers', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [xlsx('epics.xlsx')])
    const region = await previewed('epics.xlsx')
    expect(within(region).getByText(lineText('You typed 48 for Billing in Oct 2026 (Epics delivered on time); records give 47.'))).toBeTruthy()
    await user.click(within(region).getByRole('checkbox', { name: /Use records for this month/ }))
    await waitFor(() =>
      expect(previews('imp-1').at(-1)?.answers?.useRecords).toEqual([
        { measureKey: 'epics_on_time', subjectId: 'billing', period: '2026-M10' },
      ]),
    )
  })
})

describe('RecordsImport: apply', () => {
  it('applies every ready file in order with its answers and says what happened', async () => {
    const { user } = await renderImportPage()
    dropOn(dropZone(), [csv('defects.csv'), xlsx('epics.xlsx')])
    await previewed('defects.csv')
    const epics = await previewed('epics.xlsx')
    await user.click(within(epics).getByRole('checkbox', { name: /Use records for this month/ }))
    const apply = screen.getByRole('button', { name: 'Apply' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    await user.click(apply)

    await waitFor(() => expect(requestsTo(fake, 'POST', `/imports/${importIdOf('epics.xlsx')}/apply`)).toHaveLength(1))
    const applies = fake.requests.filter((r) => r.path.endsWith('/apply'))
    expect(applies.map((r) => r.path)).toEqual([`/imports/${importIdOf('defects.csv')}/apply`, `/imports/${importIdOf('epics.xlsx')}/apply`])
    expect(applies[0]?.body).toEqual({ answers: { sourceKeys: { 'Checkout Svc': 'checkout' } } })
    expect(applies[1]?.body).toEqual({
      answers: { useRecords: [{ measureKey: 'epics_on_time', subjectId: 'billing', period: '2026-M10' }] },
    })
    const result = await screen.findByRole('status', { name: 'Import result' })
    await waitFor(() => expect(result.textContent).toContain('Applied 2 files. The scorecard now shows the new numbers.'))
    await waitFor(() => expect(document.activeElement).toBe(result))
    expect(within(card('defects.csv')).getByText('Applied: 7 new and 30 changed records.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('previews a newly set-up file with its template and saves the template on apply', async () => {
    fake.previews['imp-setup'] = epicsPreview()
    const user = userEvent.setup()
    renderApp(
      <RecordsImport
        scorecardId="sc-main"
        prepared={[
          {
            importId: 'imp-setup',
            filename: 'tickets.csv',
            template: recordTemplate({ name: 'Support tickets', recordType: 'epic' }),
            saveAs: { id: 'support-tickets', name: 'Support tickets' },
          },
        ]}
      />,
    )
    await previewed('tickets.csv')
    expect(previews('imp-setup')[0]?.template?.name).toBe('Support tickets')
    expect(previews('imp-setup')[0]?.templateId).toBeUndefined()
    const apply = screen.getByRole('button', { name: 'Apply' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    await user.click(apply)
    await waitFor(() => expect(requestsTo(fake, 'POST', '/imports/imp-setup/apply')).toHaveLength(1))
    expect(requestsTo(fake, 'POST', '/imports/imp-setup/apply')[0]?.body).toEqual({
      answers: {},
      saveTemplate: { id: 'support-tickets', name: 'Support tickets' },
    } satisfies ApplyBody)
  })

  it('refreshes an out-of-date preview instead of applying it', async () => {
    fake.failNext.set('POST /imports/imp-1/apply', { status: 409, code: 'conflict', message: 'preview is out of date' })
    const { user } = await renderImportPage()
    dropOn(dropZone(), [xlsx('epics.xlsx')])
    await previewed('epics.xlsx')
    const apply = screen.getByRole('button', { name: 'Apply' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    const before = previews('imp-1').length
    await user.click(apply)
    expect(await within(card('epics.xlsx')).findByText(/This preview was out of date/)).toBeTruthy()
    await waitFor(() => expect(previews('imp-1').length).toBeGreaterThan(before))
  })
})

describe('Scorecard page: upload records', () => {
  function renderScorecard() {
    server.use(...recordsHandlers(fake, { withVersions: false }), ...viewHandlers())
    const user = userEvent.setup()
    renderApp(
      <Routes>
        <Route path="/scorecards/:sc" element={<ScorecardPage />} />
      </Routes>,
      { route: '/scorecards/sc-main?period=2026-M10' },
    )
    return user
  }

  it('offers "Upload records" to admins and opens the import in a dialog', async () => {
    const user = renderScorecard()
    const button = await screen.findByRole('button', { name: 'Upload records' })
    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Upload records' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(within(dialog).getByRole('group', { name: 'Drop files to upload' })).toBeTruthy()
    expect((await axe(dialog)).violations).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(button)
  })

  it('opens the import with a file dropped anywhere on the page', async () => {
    renderScorecard()
    await screen.findByRole('button', { name: 'Upload records' })
    dropOn(screen.getByRole('heading', { level: 1, name: 'Main scorecard' }), [xlsx('epics.xlsx')])
    const dialog = await screen.findByRole('dialog', { name: 'Upload records' })
    expect(await within(dialog).findByRole('region', { name: 'epics.xlsx' })).toBeTruthy()
    await waitFor(() => expect(previews('imp-1')[0]?.scorecardId).toBe('sc-main'))
  })

  it('asks before discarding previews that are not applied', async () => {
    const user = renderScorecard()
    const button = await screen.findByRole('button', { name: 'Upload records' })
    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Upload records' })
    dropOn(within(dialog).getByRole('group', { name: 'Drop files to upload' }), [xlsx('epics.xlsx')])
    await within(dialog).findByRole('heading', { name: 'What changes on the scorecard' })

    await user.keyboard('{Escape}')
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard these uploads?' })
    expect(confirm.contains(document.activeElement)).toBe(true)
    expect((await axe(confirm)).violations).toEqual([])
    await user.click(within(confirm).getByRole('button', { name: 'Keep reviewing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Upload records' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'epics.xlsx' })).toBeTruthy()

    await user.click(within(screen.getByRole('dialog', { name: 'Upload records' })).getByRole('button', { name: 'Close' }))
    const again = await screen.findByRole('alertdialog', { name: 'Discard these uploads?' })
    await user.click(within(again).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(requestsTo(fake, 'POST', '/imports/imp-1/apply')).toHaveLength(0)
  })

  it('closes without asking once every file is applied', async () => {
    const user = renderScorecard()
    await user.click(await screen.findByRole('button', { name: 'Upload records' }))
    const dialog = await screen.findByRole('dialog', { name: 'Upload records' })
    dropOn(within(dialog).getByRole('group', { name: 'Drop files to upload' }), [xlsx('epics.xlsx')])
    const apply = await within(dialog).findByRole('button', { name: 'Apply' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    await user.click(apply)
    await within(dialog).findByText('Applied: 7 new and 30 changed records.')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows no "Upload records" to people who are not admins', async () => {
    state.role = 'viewer'
    renderScorecard()
    expect(await screen.findByRole('heading', { level: 1, name: 'Main scorecard' })).toBeTruthy()
    await screen.findByRole('table')
    expect(screen.queryByRole('button', { name: 'Upload records' })).toBeNull()
    dropOn(screen.getByRole('heading', { level: 1 }), [xlsx('epics.xlsx')])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestsTo(fake, 'POST', '/imports/uploads')).toHaveLength(0)
  })
})

describe('RecordsImport accessibility', () => {
  it('has no axe violations with previews, questions and an open story line', async () => {
    const { user, container } = await renderImportPage()
    expect((await axe(container)).violations).toEqual([])
    dropOn(dropZone(), [csv('defects.csv'), xlsx('epics.xlsx')])
    await previewed('defects.csv')
    const epics = await previewed('epics.xlsx')
    await user.click(within(epics).getByRole('button', { name: /On-time delivery/ }))
    expect((await axe(container)).violations).toEqual([])
  })
})
