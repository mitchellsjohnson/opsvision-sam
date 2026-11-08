import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../../api/schema'
import { CSV_TYPE } from '../../../test/recordsFixtures'
import { server } from '../../../test/server'
import { renderApp } from '../../../test/utils'
import { newWizardFake, wizardHandlers, wizardRequests, type WizardFake } from '../../../test/wizardFixtures'
import { SetupWizard } from './SetupWizard'

type PreviewBody = components['schemas']['RecordsPreviewRequest']
type ApplyBody = components['schemas']['ApplyImportRequest']
type MethodologyVersion = components['schemas']['MethodologyVersion']
type RecordType = components['schemas']['RecordType']
type ImportTemplate = components['schemas']['ImportTemplate']

let fake: WizardFake

beforeEach(() => {
  fake = newWizardFake()
  server.use(...wizardHandlers(fake))
})

function Probe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

const HEADINGS = {
  type: 'What is this file?',
  columns: 'Which column is which?',
  values: 'What do the values mean?',
  products: 'Products and teams',
  calculate: 'What should we calculate?',
  preview: 'Check the preview',
} as const

type Step = keyof typeof HEADINGS

async function renderWizard(route = '/admin/import/setup?upload=imp-1') {
  const user = userEvent.setup()
  const view = renderApp(
    <>
      <Routes>
        <Route path="/admin/import/setup" element={<SetupWizard />} />
        <Route path="/admin/import" element={<h1>Import</h1>} />
        <Route path="/admin/templates" element={<h1>Templates</h1>} />
      </Routes>
      <Link to="/admin/org">Somewhere else</Link>
      <Probe />
    </>,
    { route },
  )
  return { user, ...view }
}

async function onStep(step: Step) {
  return screen.findByRole('heading', { level: 2, name: HEADINGS[step] })
}

async function next(user: ReturnType<typeof userEvent.setup>, to: Step) {
  await user.click(screen.getByRole('button', { name: 'Next' }))
  return onStep(to)
}

async function walkTo(user: ReturnType<typeof userEvent.setup>, to: Step, { answerDates = true } = {}) {
  const order: Step[] = ['type', 'columns', 'values', 'products', 'calculate', 'preview']
  await onStep('type')
  for (const step of order.slice(1, order.indexOf(to) + 1)) {
    if (step === 'products' && answerDates && screen.queryByRole('group', { name: /March 4 or April 3/ })) {
      await user.click(screen.getByRole('radio', { name: 'March 4 (month first)' }))
    }
    await next(user, step)
  }
}

function fieldRow(label: string) {
  return screen.getByRole('combobox', { name: label }).closest('li') as HTMLElement
}

function previews(importId = 'imp-1'): PreviewBody[] {
  return wizardRequests(fake, 'POST', `/imports/${importId}/records-preview`).map((r) => r.body as PreviewBody)
}

const forbidden = /subject|source key|revision|snapshot/i

describe('SetupWizard: steps', () => {
  it('shows where you are: an ordered list with the current step, the step in the URL, one heading per step', async () => {
    const { user } = await renderWizard()
    await onStep('type')
    expect(screen.getByText('Step 1 of 6: File type')).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Setup steps' })
    const items = within(within(nav).getByRole('list')).getAllByRole('listitem')
    expect(within(nav).getByRole('list').tagName).toBe('OL')
    expect(items).toHaveLength(6)
    expect(items[0]?.getAttribute('aria-current')).toBe('step')
    expect(items[1]?.getAttribute('aria-current')).toBeNull()

    const heading = await next(user, 'columns')
    expect(screen.getByText('Step 2 of 6: Columns')).toBeTruthy()
    expect(within(nav).getAllByRole('listitem')[1]?.getAttribute('aria-current')).toBe('step')
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(document.activeElement).toBe(heading)
    expect(screen.getByTestId('location').textContent).toBe('/admin/import/setup?upload=imp-1&step=columns')

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(await onStep('type'))
  })

  it('preselects the suggested record type and says how big the file is', async () => {
    await renderWizard()
    await onStep('type')
    expect(screen.getByText('We read 1,204 rows and 9 columns.')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Defect/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('We think it’s this one.')).toBeTruthy()
  })

  it('keeps edits when going back and forward', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Title' }), 'Status')
    await next(user, 'values')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await onStep('columns')
    expect((screen.getByRole('combobox', { name: 'Title' }) as HTMLSelectElement).value).toBe('Status')
  })

  it('asks before leaving with progress, and stays when asked to', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    await user.click(screen.getByRole('link', { name: 'Somewhere else' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Leave the setup?' })
    expect((await axe(confirm)).violations).toEqual([])
    await user.click(within(confirm).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('location').textContent).toContain('/admin/import/setup')

    await user.click(screen.getByRole('link', { name: 'Cancel setup' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/import'))
  })
})

describe('SetupWizard: columns', () => {
  it('prefills each field with its guess, a confidence chip and three samples', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    expect((screen.getByRole('combobox', { name: 'ID' }) as HTMLSelectElement).value).toBe('Issue key')
    const id = fieldRow('ID')
    expect(within(id).getByText('We think this is “Issue key”.')).toBeTruthy()
    expect(within(id).getByText('Likely')).toBeTruthy()
    const samples = within(id).getByRole('list', { name: 'Sample values from Issue key' })
    expect(within(samples).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['CHK-101', 'CHK-102', 'BIL-7'])
    expect((screen.getByRole('combobox', { name: 'Product or team' }) as HTMLSelectElement).value).toBe('Product')
    expect(document.body.textContent).not.toMatch(forbidden)
  })

  it('says "Check this" for a guess below 0.7 confidence', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    expect(within(fieldRow('Due date')).getByText('Check this')).toBeTruthy()
    expect(within(fieldRow('Due date')).queryByText('Likely')).toBeNull()
    expect(within(fieldRow('Created')).getByText('Likely')).toBeTruthy()
  })

  it('updates the samples when a column changes', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    await user.selectOptions(screen.getByRole('combobox', { name: 'ID' }), 'Summary')
    const id = fieldRow('ID')
    const samples = within(id).getByRole('list', { name: 'Sample values from Summary' })
    expect(within(samples).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Refund total rounds',
      'Login loops forever',
      'Invoice PDF is blank',
    ])
    expect(within(id).getByText('Your choice')).toBeTruthy()
  })

  it('stops at a required field without a column, and says which', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'columns')
    const product = screen.getByRole('combobox', { name: 'Product or team' })
    await user.selectOptions(product, '')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { level: 2, name: HEADINGS.columns })).toBeTruthy()
    expect(product.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(product)
    expect(screen.getByText(/Choose the column with the product or team/)).toBeTruthy()
  })
})

describe('SetupWizard: values', () => {
  it('shows each value with its row count and suggested meaning', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'values')
    const meaning = (name: RegExp) => (screen.getByRole('combobox', { name }) as HTMLSelectElement).value
    expect(meaning(/“High” · 40 rows/)).toBe('P2')
    expect(meaning(/“Highest” · 12 rows/)).toBe('P1')
    expect(meaning(/“Medium” · 30 rows/)).toBe('P3')
    expect(meaning(/“Low” · 9 rows/)).toBe('P4')
    expect(meaning(/Blank · 3 rows/)).toBe('none')
    expect(meaning(/“Won’t Do” · 4 rows/)).toBe('cancelled')
    expect(meaning(/“In Review” · 10 rows/)).toBe('open')
  })

  it('asks the ambiguous date question once and sends the answer as the date order', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'values')
    expect(screen.getAllByRole('group', { name: /March 4 or April 3/ })).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'Is 03/04/2026 March 4 or April 3?' })).toBeTruthy()

    // Required: Next stops here until it is answered.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { level: 2, name: HEADINGS.values })).toBeTruthy()
    expect(screen.getByText('Choose how to read these dates.')).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: 'April 3 (day first)' }))
    await walkToPreviewFrom(user, 'products')
    await waitFor(() => expect(previews().length).toBeGreaterThan(0))
    const body = previews().at(-1)!
    expect(body.answers?.dateOrder).toBe('dmy')
    expect(body.template?.fields.createdAt).toEqual({ column: 'Created', dateFormats: ['02/01/2006'] })
    // Asked once: not again in the preview.
    expect(screen.queryByRole('group', { name: /March 4 or April 3/ })).toBeNull()
  })
})

async function walkToPreviewFrom(user: ReturnType<typeof userEvent.setup>, first: Step) {
  const order: Step[] = ['products', 'calculate', 'preview']
  for (const step of order.slice(order.indexOf(first))) await next(user, step)
}

describe('SetupWizard: products and teams', () => {
  it('preselects close matches, lists linked values, and offers ignore and a shared team', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'products')
    const checkout = screen.getByRole('combobox', { name: /“Checkout Svc” · 14 rows/ }) as HTMLSelectElement
    expect(checkout.value).toBe('to:checkout')
    expect(checkout.selectedOptions[0]?.textContent).toBe('Checkout')
    expect(screen.getByText(/Already linked: Billing/)).toBeTruthy()
    const commerce = screen.getByRole('combobox', { name: /“Commerce” · 2 rows/ })
    expect(within(commerce).getByRole('option', { name: 'Create “Commerce (shared)”' })).toBeTruthy()
    await user.selectOptions(screen.getByRole('combobox', { name: /“Pmt Gateway” · 3 rows/ }), 'ignore')
    await user.selectOptions(commerce, 'shared:commerce')

    await walkToPreviewFrom(user, 'calculate')
    await waitFor(() => expect(previews().length).toBeGreaterThan(0))
    expect(previews().at(-1)?.answers).toMatchObject({
      sourceKeys: { 'Checkout Svc': 'checkout', Identity: 'identity', Commerce: 'commerce' },
      ignoreValues: ['Pmt Gateway'],
      createShared: ['commerce'],
    })
  })
})

describe('SetupWizard: calculate', () => {
  it('preselects On-time delivery when the methodology has epics_committed, and previews it in a draft', async () => {
    const { user } = await renderWizard('/admin/import/setup?upload=imp-2')
    await walkTo(user, 'calculate')
    const onTime = screen.getByRole('checkbox', { name: 'On-time delivery' }) as HTMLInputElement
    expect(onTime.checked).toBe(true)
    expect(screen.getByText('Each due date is a commitment; a slip counts as a miss in that month.')).toBeTruthy()
    expect(screen.getByText('Uses your measures Epics committed and Epics delivered on time.')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: 'Average age' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: 'Weighted open items' })).toBeNull()

    await next(user, 'preview')
    await waitFor(() => expect(previews('imp-2').length).toBeGreaterThan(0))
    expect(wizardRequests(fake, 'POST', '/scorecards/sc-main/versions')[0]?.body).toEqual({
      name: 'Epics from records',
      cloneFrom: 'ver-1',
    })
    const put = wizardRequests(fake, 'PUT', '/scorecards/sc-main/versions/ver-11')[0]?.body as {
      revision: number
      content: MethodologyVersion['content']
    }
    expect(put.revision).toBe(1)
    expect(put.content.measures.find((m) => m.key === 'epics_committed')).toMatchObject({
      source: 'derived',
      derive: { recordType: 'epic', op: 'commitments', outcome: 'resolved' },
    })
    expect(previews('imp-2').at(-1)).toMatchObject({ scorecardId: 'sc-main', draftVersionId: 'ver-11' })
  })

  it('previews without a draft when nothing is chosen', async () => {
    const { user } = await renderWizard('/admin/import/setup?upload=imp-2')
    await walkTo(user, 'calculate')
    await user.click(screen.getByRole('checkbox', { name: 'On-time delivery' }))
    await next(user, 'preview')
    await waitFor(() => expect(previews('imp-2').length).toBeGreaterThan(0))
    expect(previews('imp-2').at(-1)?.draftVersionId).toBeUndefined()
    expect(wizardRequests(fake, 'POST', '/scorecards/sc-main/versions')).toHaveLength(0)
  })
})

describe('SetupWizard: preview and apply', () => {
  it('previews the story, applies with the template saved, and celebrates', async () => {
    const { user } = await renderWizard()
    await walkTo(user, 'preview')
    await screen.findByRole('heading', { name: 'What changes on the scorecard' })
    expect(screen.getByRole('button', { name: /Billing · On-time delivery/ })).toBeTruthy()
    const name = screen.getByRole('textbox', { name: 'Save this setup as' }) as HTMLInputElement
    expect(name.value).toBe('Defects export 2')
    const body = previews().at(-1)!
    expect(body.template?.recordType).toBe('defect')
    expect(body.draftVersionId).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const done = await screen.findByText('Your defects are in. 12 metrics updated.')
    const apply = wizardRequests(fake, 'POST', '/imports/imp-1/apply')
    expect(apply).toHaveLength(1)
    expect(apply[0]?.body).toEqual({
      answers: previews().at(-1)?.answers,
      saveTemplate: { id: 'defects-export-2', name: 'Defects export 2' },
    } satisfies ApplyBody)
    expect(document.activeElement).toBe(done.closest('[tabindex="-1"]'))
    expect(screen.getByRole('link', { name: 'Back to Import' }).getAttribute('href')).toBe('/admin/import')
    // Nothing is left to lose: leaving does not ask.
    await user.click(screen.getByRole('link', { name: 'Somewhere else' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/org'))
  })

  it('opens "Publish now" with the tracked-from month, then publishes the draft', async () => {
    const { user } = await renderWizard('/admin/import/setup?upload=imp-2')
    await walkTo(user, 'preview')
    await screen.findByRole('heading', { name: 'What changes on the scorecard' })
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText('Your epics are in. 12 metrics update when you publish.')
    expect(screen.getByText(/start once you publish/)).toBeTruthy()
    expect(screen.getByText(/Epics committed and Epics delivered on time/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Publish now' }))
    const dialog = await screen.findByRole('dialog', { name: /Publish Epics from records/ })
    const month = within(dialog).getByRole('combobox', { name: 'Effective month' }) as HTMLSelectElement
    expect(month.value).toBe('2026-M11')
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(wizardRequests(fake, 'POST', '/scorecards/sc-main/versions/ver-11/publish')[0]?.body).toEqual({
      effectiveFrom: '2026-M11',
    })
    expect(await screen.findByText(/Published Epics from records/)).toBeTruthy()
  })

  it('creates a new record type in place before previewing', async () => {
    const { user } = await renderWizard()
    await onStep('type')
    await user.click(screen.getByRole('radio', { name: 'A new type' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Incident')
    expect((screen.getByRole('textbox', { name: 'Priorities, highest first' }) as HTMLInputElement).value).toBe('P1, P2, P3, P4')
    await walkTo(user, 'preview')
    await waitFor(() => expect(previews().length).toBeGreaterThan(0))
    expect(wizardRequests(fake, 'PUT', '/record-types/incident')[0]?.body).toEqual({
      id: 'incident',
      name: 'Incident',
      priorities: ['P1', 'P2', 'P3', 'P4'],
      attributes: [],
      trackedFrom: {},
      revision: 0,
    } satisfies RecordType)
    expect(previews().at(-1)?.template?.recordType).toBe('incident')
  })

  it('has no axe violations on any step, or after applying', async () => {
    const { user, container } = await renderWizard()
    for (const step of ['type', 'columns', 'values', 'products', 'calculate', 'preview'] as const) {
      await walkToStep(user, step)
      expect((await axe(container)).violations).toEqual([])
    }
    await screen.findByRole('heading', { name: 'What changes on the scorecard' })
    expect((await axe(container)).violations).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/Your defects are in/)
    expect((await axe(container)).violations).toEqual([])
  })
})

async function walkToStep(user: ReturnType<typeof userEvent.setup>, step: Step) {
  if (step === 'type') return onStep('type')
  if (step === 'products') await user.click(screen.getByRole('radio', { name: 'March 4 (month first)' }))
  return next(user, step)
}

describe('SetupWizard: edit a saved mapping', () => {
  it('asks for a recent export, then edits the columns and values and saves the template', async () => {
    const { user, container } = await renderWizard('/admin/import/setup?template=defects-export&step=columns')
    await onStep('columns')
    expect(screen.getByText('Step 1 of 2: Columns')).toBeTruthy()
    const zone = await screen.findByRole('group', { name: 'Drop files to upload' })
    expect(screen.getByRole('heading', { level: 1, name: 'Edit mapping: Defects export' })).toBeTruthy()
    expect(screen.getByText(/drop a recent export/i)).toBeTruthy()
    expect((await axe(container)).violations).toEqual([])

    const file = new File(['Issue key,Product\nCHK-1,Checkout\n'], 'defects.csv', { type: CSV_TYPE })
    const dataTransfer = { files: [file], types: ['Files'], items: [{ kind: 'file' }] }
    fireEvent.dragEnter(zone, { dataTransfer })
    fireEvent.drop(zone, { dataTransfer })

    const id = (await screen.findByRole('combobox', { name: 'ID' })) as HTMLSelectElement
    expect(id.value).toBe('Issue key')
    expect((screen.getByRole('combobox', { name: 'Title' }) as HTMLSelectElement).value).toBe('')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Title' }), 'Summary')
    await next(user, 'values')
    expect(screen.getByText('Step 2 of 2: Values')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'April 3 (day first)' }))
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))

    await screen.findByText('Saved the mapping for Defects export.')
    const put = wizardRequests(fake, 'PUT', '/import-templates/defects-export')[0]?.body as ImportTemplate
    expect(put).toMatchObject({ id: 'defects-export', name: 'Defects export', profile: 'records' })
    expect(put.body).toMatchObject({
      recordType: 'defect',
      fields: {
        title: { column: 'Summary' },
        createdAt: { column: 'Created', dateFormats: ['02/01/2006'] },
      },
    })
    expect(screen.getByRole('link', { name: 'Back to Templates' }).getAttribute('href')).toBe('/admin/templates')
  })
})
