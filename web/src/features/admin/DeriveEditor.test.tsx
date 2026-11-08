import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { RecordType } from '../../api/queries'
import { currentMonth } from '../../lib/period'
import { adminHandlers, newAdminFake } from '../../test/adminFixtures'
import { meFor } from '../../test/fixtures'
import { methodologyHandlers, newMethodologyFake, type MethodologyFake } from '../../test/methodologyFixtures'
import { newRulesFake, rulesHandlers, sampleOf, type RulesFake } from '../../test/rulesFixtures'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addMonths } from './adminModel'
import { DeriveEditor, newPresetChoice, type PresetChoice } from './DeriveEditor'
import { MethodologyPage } from './MethodologyPage'

let rules: RulesFake

beforeEach(() => {
  rules = newRulesFake()
  server.use(...rulesHandlers(rules))
})

const SAMPLE = '/scorecards/sc-main/records/sample'
const lastMonth = () => addMonths(currentMonth(meFor('admin').tenant?.fiscalYearStartMonth ?? 1), -1)

function samples() {
  return rules.requests.filter((r) => r.method === 'POST' && r.path === SAMPLE)
}

function describedText(el: HTMLElement) {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function Harness({
  types,
  onValue,
  knownValues,
}: {
  types: RecordType[]
  onValue?: (v: PresetChoice) => void
  knownValues?: Record<string, string[]>
}) {
  const [value, setValue] = useState(() => newPresetChoice(types[0]!, 'weighted_open'))
  return (
    <DeriveEditor
      sc="sc-main"
      recordTypes={types}
      value={value}
      knownValues={knownValues}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
    />
  )
}

describe('DeriveEditor', () => {
  it('shows the live sample for the preset and the filter', async () => {
    const user = userEvent.setup()
    renderApp(<Harness types={rules.recordTypes} />)
    expect(
      await screen.findByText('Last month this matches 212 records (Checkout 41, Billing 18, Identity 12, …)'),
    ).toBeTruthy()
    expect(samples()[0]?.body).toEqual({ recordType: 'defect', bucketBy: 'createdAt', period: lastMonth() })

    rules.sample = sampleOf(1, [['billing', 'Billing', 1]])
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    await user.selectOptions(screen.getByLabelText('Condition 1 field'), 'customerTicket')
    expect((screen.getByLabelText('Condition 1 operator') as HTMLSelectElement).value).toBe('is')
    expect((screen.getByLabelText('Condition 1 value') as HTMLSelectElement).value).toBe('yes')
    expect(await screen.findByText('Last month this matches 1 record (Billing 1)')).toBeTruthy()
    expect(samples().at(-1)?.body).toMatchObject({ recordType: 'defect', where: 'customerTicket' })
  })

  it('offers the values stored records hold as checkboxes and suggestions', async () => {
    const user = userEvent.setup()
    renderApp(<Harness types={rules.recordTypes} />)
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    expect((screen.getByLabelText('Condition 1 field') as HTMLSelectElement).value).toBe('category')

    // "is": a text box suggesting the stored values.
    const input = screen.getByLabelText('Condition 1 value')
    await waitFor(() => expect(input.getAttribute('list')).not.toBeNull())
    const options = [...document.querySelectorAll(`#${input.getAttribute('list')} option`)].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['Bug', 'Defect', 'Sub-task'])
    expect(rules.requests.some((r) => r.path === '/record-types/defect/values?field=category')).toBe(true)

    // "is one of": the stored values as checkboxes, most common first, with others typed.
    await user.selectOptions(screen.getByLabelText('Condition 1 operator'), 'one_of')
    const group = screen.getByRole('group', { name: 'Condition 1 values' })
    expect(within(group).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Bug (7)',
      'Defect (1)',
      'Sub-task (1)',
    ])
    await user.click(within(group).getByRole('checkbox', { name: 'Bug (7)' }))
    await user.type(screen.getByLabelText('Condition 1 other values'), 'Story')
    await waitFor(() => expect(samples().at(-1)?.body).toMatchObject({ where: "category in ['Bug', 'Story']" }))
    await user.click(within(group).getByRole('checkbox', { name: 'Defect (1)' }))
    await waitFor(() => expect(samples().at(-1)?.body).toMatchObject({ where: "category in ['Bug', 'Defect', 'Story']" }))
  })

  it('falls back to the known values when stored records have none', async () => {
    const user = userEvent.setup()
    renderApp(<Harness types={rules.recordTypes} knownValues={{ subjectKey: ['Billing', 'Checkout'] }} />)
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    await user.selectOptions(screen.getByLabelText('Condition 1 field'), 'subjectKey')
    await user.selectOptions(screen.getByLabelText('Condition 1 operator'), 'one_of')
    const group = await screen.findByRole('group', { name: 'Condition 1 values' })
    expect(within(group).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Billing', 'Checkout'])
    expect(rules.requests.some((r) => r.path === '/record-types/defect/values?field=subjectKey')).toBe(true)
  })

  it('asks only for the blanks of the chosen preset, in plain language', async () => {
    const user = userEvent.setup()
    let latest: PresetChoice | undefined
    renderApp(<Harness types={rules.recordTypes} onValue={(v) => (latest = v)} />)
    const weights = screen.getByRole('group', { name: 'Weight per priority' })
    expect((within(weights).getByLabelText('Weight for P1') as HTMLInputElement).value).toBe('64')
    expect((within(weights).getByLabelText('Weight for no priority') as HTMLInputElement).value).toBe('1')

    await user.click(screen.getByRole('radio', { name: /Delivered within budget/ }))
    expect(screen.queryByRole('group', { name: 'Weight per priority' })).toBeNull()
    expect((screen.getByLabelText('Allowed overrun (%)') as HTMLInputElement).value).toBe('20')
    await user.selectOptions(screen.getByLabelText('Which date puts a record in a month'), 'completedAt')
    expect(latest?.preset).toBe('within_budget')
    expect(latest?.params).toMatchObject({ recordType: 'defect', tolerance: 20, bucketBy: 'completedAt' })
    expect(screen.queryByText(/derive|subject|revision/i)).toBeNull()
  })

  it('has no axe violations', async () => {
    const user = userEvent.setup()
    const { container } = renderApp(<Harness types={rules.recordTypes} />)
    await screen.findByText(/Last month this matches/)
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    await user.click(screen.getByRole('button', { name: 'Show advanced' }))
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('DeriveEditor in the draft editor', () => {
  let fake: MethodologyFake
  const V = '/scorecards/sc-main/versions'

  beforeEach(() => {
    fake = newMethodologyFake()
    fake.versions[0]!.content.measures.push({
      key: 'defect_points_sum',
      name: 'Defect points',
      unit: 'points',
      orgAgg: 'sum',
      timeAgg: 'sum',
      source: 'derived',
      derive: {
        recordType: 'defect',
        op: 'daily_open_weighted',
        where: "category in ['bug']",
        weights: { P1: 64, P2: 16, P3: 4, P4: 2, none: 1 },
      },
    })
    server.use(...methodologyHandlers(fake), ...adminHandlers(newAdminFake()), ...rulesHandlers(rules))
  })

  async function openDraft() {
    const user = userEvent.setup()
    renderApp(<MethodologyPage />, { route: '/admin/methodology' })
    await screen.findByRole('table', { name: /Methodology versions/ })
    await user.click(screen.getByRole('button', { name: 'Edit FY27 proposal' }))
    await screen.findByRole('table', { name: 'Measures' })
    return user
  }

  it('shows where each measure comes from', async () => {
    await openDraft()
    const table = screen.getByRole('table', { name: 'Measures' })
    expect((within(table).getByLabelText('Measure 1 source') as HTMLSelectElement).value).toBe('entered')
    expect((within(table).getByLabelText('Measure 3 source') as HTMLSelectElement).value).toBe('derived')
    expect(within(table).getByRole('button', { name: 'Edit rule for Defect points' })).toBeTruthy()
    expect(within(table).queryByRole('button', { name: 'Edit rule for Closed items' })).toBeNull()
  })

  it('adds measures and a metric from a preset and saves them', async () => {
    const user = await openDraft()
    await user.click(screen.getByRole('button', { name: 'Add measures from records' }))
    const panel = await screen.findByRole('region', { name: 'Add measures from records' })
    await user.selectOptions(within(panel).getByLabelText('Record type'), 'epic')
    await user.click(within(panel).getByRole('radio', { name: /On-time delivery/ }))
    await user.click(within(panel).getByRole('button', { name: 'Add to draft' }))
    expect(await screen.findByText('Added 2 measures and 1 metric to the draft.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(fake.requests.filter((r) => r.method === 'PUT' && r.path === `${V}/ver-2`)).toHaveLength(1))
    const body = fake.requests.find((r) => r.method === 'PUT')?.body as {
      content: { measures: { key: string; source?: string; derive?: unknown }[]; metrics: { key: string; formula: string }[] }
    }
    expect(body.content.measures.find((m) => m.key === 'epic_on_time')).toMatchObject({
      source: 'derived',
      derive: { recordType: 'epic', op: 'commitments', outcome: 'met' },
    })
    expect(body.content.metrics.find((m) => m.key === 'epic_on_time_pct')?.formula).toBe('epic_on_time / epic_committed * 100')
  })

  it('shows the server error for a bad Advanced expression under the field', async () => {
    const user = await openDraft()
    await user.click(screen.getByRole('button', { name: 'Edit rule for Defect points' }))
    const editor = await screen.findByRole('region', { name: 'Rule for Defect points' })
    // The builder shows the stored filter.
    expect((within(editor).getByLabelText('Condition 1 field') as HTMLSelectElement).value).toBe('category')
    expect((within(editor).getByLabelText('Condition 1 operator') as HTMLSelectElement).value).toBe('one_of')

    await user.click(within(editor).getByRole('button', { name: 'Show advanced' }))
    const where = within(editor).getByLabelText('Filter expression')
    expect((where as HTMLTextAreaElement).value).toBe("category in ['bug']")
    await user.clear(where)
    await user.type(where, "nope == 'x'")
    expect(within(editor).getByText(/The builder cannot show this filter/)).toBeTruthy()

    fake.validateErrors = [{ path: 'measures[2].derive.where', message: 'where: unknown field "nope" on record type "defect"' }]
    await user.click(within(editor).getByRole('button', { name: 'Check rule' }))
    await waitFor(() => expect(where.getAttribute('aria-invalid')).toBe('true'))
    expect(describedText(where)).toContain('unknown field "nope" on record type "defect"')
    const put = fake.requests.find((r) => r.method === 'PUT')?.body as { content: { measures: { derive?: { where?: string } }[] } }
    expect(put.content.measures[2]?.derive?.where).toBe("nope == 'x'")
  })

  it('switches a measure to derived from records and opens its rule', async () => {
    const user = await openDraft()
    await user.selectOptions(screen.getByLabelText('Measure 1 source'), 'derived')
    const editor = await screen.findByRole('region', { name: 'Rule for Closed items' })
    expect((within(editor).getByLabelText('Record type') as HTMLSelectElement).value).toBe('defect')
    expect(await within(editor).findByText(/Last month this matches/)).toBeTruthy()
  })
})
