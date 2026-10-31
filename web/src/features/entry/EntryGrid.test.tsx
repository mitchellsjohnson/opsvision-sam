import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Link, useLocation } from 'react-router'
import { axe } from 'vitest-axe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { EntryGrid, PREVIEW_DEBOUNCE_MS } from './EntryGrid'

type EntryRow = components['schemas']['EntryRow']
type DataWrite = components['schemas']['DataWrite']
type Cell = components['schemas']['Cell']

const PERIOD = '2026-M10'

// All data is synthetic.
function row(
  measureKey: string,
  subjectId: string,
  extra: Partial<EntryRow> = {},
): EntryRow {
  const names: Record<string, string> = { closed: 'Closed items', total: 'Total items', defects: 'Defects' }
  const subjects: Record<string, string> = {
    'unit-a': 'Unit A',
    'unit-b': 'Unit B',
    'unit-c': 'Unit C',
    'unit-d': 'Unit D',
  }
  return {
    measureKey,
    measureName: names[measureKey] ?? measureKey,
    metricKeys: measureKey === 'defects' ? ['defect_rate'] : ['on_time_pct'],
    subjectId,
    subjectName: subjects[subjectId] ?? subjectId,
    period: PERIOD,
    naReason: '',
    revision: 0,
    canEdit: true,
    ...extra,
  }
}

/** Unit D is read-only and sits between editable rows. */
const baseRows = (): EntryRow[] => [
  row('closed', 'unit-a', { value: 40, revision: 3 }),
  row('total', 'unit-a', { value: 50, revision: 3 }),
  row('closed', 'unit-d', { value: 5, revision: 1, canEdit: false }),
  row('closed', 'unit-b'),
  row('total', 'unit-b'),
  row('defects', 'unit-c', { value: 2, revision: 1 }),
]

const rowId = (r: Pick<EntryRow, 'measureKey' | 'subjectId'>) => `${r.measureKey}|${r.subjectId}`

const previewCell: Cell = {
  metricKey: 'on_time_pct',
  subjectId: 'unit-a',
  period: PERIOD,
  ytd: false,
  value: 90,
  display: '90.0%',
  status: 'G',
  naReason: '',
  components: { closed: 45, total: 50 },
  coverage: [1, 1],
  change: null,
  changeKind: '',
  target: null,
  versionId: 'ver-1',
}

interface Harness {
  /** The server's rows: edit them to simulate someone else saving. */
  rows: EntryRow[]
  counts: { entry: number; view: number }
  previews: DataWrite[][]
  saves: DataWrite[][]
  /** Makes the next save fail with this response (once). */
  failNextSave?: () => Response
  externalChange(measureKey: string, subjectId: string, value: number): void
}

function LocationProbe() {
  const l = useLocation()
  return (
    <>
      <p data-testid="location">{l.pathname + l.search}</p>
      <Link to="/elsewhere">Go elsewhere</Link>
    </>
  )
}

function setup(rows: EntryRow[] = baseRows()) {
  const h: Harness = {
    rows,
    counts: { entry: 0, view: 0 },
    previews: [],
    saves: [],
    externalChange(measureKey, subjectId, value) {
      const r = h.rows.find((x) => rowId(x) === `${measureKey}|${subjectId}`) as EntryRow
      r.value = value
      r.revision += 1
    },
  }
  server.use(
    ...viewHandlers({ onView: () => (h.counts.view += 1) }),
    http.get(`${API}/v1/scorecards/sc-main/entry`, () => {
      h.counts.entry += 1
      return HttpResponse.json({ period: PERIOD, rows: h.rows })
    }),
    http.post(`${API}/v1/scorecards/sc-main/preview`, async ({ request }) => {
      const body = (await request.json()) as { writes: DataWrite[] }
      h.previews.push(body.writes)
      return HttpResponse.json({ cells: [previewCell] })
    }),
    http.post(`${API}/v1/scorecards/sc-main/data\\:batch`, async ({ request }) => {
      const body = (await request.json()) as { writes: DataWrite[] }
      h.saves.push(body.writes)
      if (h.failNextSave) {
        const fail = h.failNextSave
        h.failNextSave = undefined
        return fail()
      }
      const conflicts = body.writes.flatMap((w) => {
        const current = h.rows.find((r) => rowId(r) === `${w.measureKey}|${w.subjectId}`)
        return current && current.revision !== w.expectedRevision
          ? [
              {
                write: w,
                current: {
                  measureKey: current.measureKey,
                  subjectId: current.subjectId,
                  period: current.period,
                  value: current.value ?? null,
                  naReason: current.naReason,
                  source: 'grid',
                  enteredBy: 'other@example.test',
                  enteredAt: '2026-10-05T12:00:00Z',
                  revision: current.revision,
                },
              },
            ]
          : []
      })
      if (conflicts.length > 0) return HttpResponse.json({ conflicts }, { status: 409 })
      const saved = body.writes.map((w) => {
        const current = h.rows.find((r) => rowId(r) === `${w.measureKey}|${w.subjectId}`) as EntryRow
        current.value = w.value ?? undefined
        current.naReason = w.naReason ?? ''
        current.revision += 1
        return {
          measureKey: w.measureKey,
          subjectId: w.subjectId,
          period: w.period,
          value: w.value ?? null,
          naReason: w.naReason ?? '',
          source: 'grid',
          enteredBy: 'me@example.test',
          enteredAt: '2026-10-06T12:00:00Z',
          revision: current.revision,
        }
      })
      return HttpResponse.json({ saved })
    }),
  )
  const view = renderApp(
    <>
      <EntryGrid scorecardId="sc-main" scorecardName="Main scorecard" period={PERIOD} periodLabel="Oct 2026" />
      <LocationProbe />
    </>,
    { route: '/entry' },
  )
  return { h, user: userEvent.setup(), ...view }
}

const value = (measure: string, subject: string) =>
  screen.getByRole('textbox', { name: `Value, ${measure}, ${subject}` }) as HTMLInputElement
const reason = (measure: string, subject: string) =>
  screen.getByRole('textbox', { name: `Not-applicable reason, ${measure}, ${subject}` }) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: /^Save changes/ }) as HTMLButtonElement

async function ready() {
  await screen.findByRole('table')
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, input: HTMLInputElement, text: string) {
  await user.clear(input)
  await user.type(input, text)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('EntryGrid layout', () => {
  it('is a semantic table with a caption, grouped by metric, with named inputs', async () => {
    setup()
    await ready()
    expect(screen.getByRole('table', { name: 'Main scorecard, Oct 2026' })).toBeTruthy()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Subject',
      'Measure',
      'Value',
      'Not-applicable reason',
      'Preview',
    ])
    // Group headers use the metric's name once the view has loaded.
    expect(await screen.findByRole('rowheader', { name: 'On-time delivery' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Defect rate' })).toBeTruthy()
    expect(screen.getAllByRole('rowheader', { name: /^Unit A$/ })[0]?.getAttribute('scope')).toBe('row')
    expect(value('Closed items', 'Unit A').value).toBe('40')
    expect(value('Closed items', 'Unit A').getAttribute('inputmode')).toBe('decimal')
    expect(value('Closed items', 'Unit A').getAttribute('type')).toBe('text')
    expect(saveButton().disabled).toBe(true)
  })

  it('shows an empty state and an error state', async () => {
    setup([])
    expect(await screen.findByText(/nothing to enter/i)).toBeTruthy()
  })

  it('shows an error with a retry when the grid cannot load', async () => {
    server.use(
      ...viewHandlers(),
      http.get(`${API}/v1/scorecards/sc-main/entry`, () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'no such scorecard' } }, { status: 404 }),
      ),
    )
    renderApp(<EntryGrid scorecardId="sc-main" scorecardName="Main scorecard" period={PERIOD} periodLabel="Oct 2026" />)
    expect((await screen.findByRole('alert')).textContent).toContain('no such scorecard')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('keyboard', () => {
  it('typing then Enter commits and moves down; Shift+Enter moves up', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(value('Total items', 'Unit A'))
    expect(value('Closed items', 'Unit A').value).toBe('45')
    expect(saveButton().textContent).toBe('Save changes (1)')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(document.activeElement).toBe(value('Closed items', 'Unit A'))
  })

  it('ArrowDown and ArrowUp move to the same column and skip read-only rows', async () => {
    const { user } = setup()
    await ready()
    value('Total items', 'Unit A').focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(value('Closed items', 'Unit B')) // Unit D is read-only
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(value('Total items', 'Unit A'))

    reason('Total items', 'Unit A').focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(reason('Closed items', 'Unit B'))
  })

  it('ArrowLeft/ArrowRight move the caret in the text and change cell only at its edges', async () => {
    const { user } = setup()
    await ready()
    const input = value('Closed items', 'Unit A')
    await typeInto(user, input, '123')
    input.setSelectionRange(1, 1)

    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(2)
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(3)

    await user.keyboard('{ArrowRight}') // at the end: on to the reason
    expect(document.activeElement).toBe(reason('Closed items', 'Unit A'))
    await user.type(document.activeElement as HTMLElement, 'ab')
    ;(document.activeElement as HTMLInputElement).setSelectionRange(1, 1)
    await user.keyboard('{ArrowLeft}') // within the text
    expect(document.activeElement).toBe(reason('Closed items', 'Unit A'))
    await user.keyboard('{ArrowLeft}') // at the start: back to the value
    expect(document.activeElement).toBe(value('Closed items', 'Unit A'))
  })

  it('Escape reverts the row to its saved value', async () => {
    const { user } = setup()
    await ready()
    const input = value('Closed items', 'Unit A')
    await typeInto(user, input, '99')
    expect(saveButton().textContent).toBe('Save changes (1)')
    await user.keyboard('{Escape}')
    expect(input.value).toBe('40')
    expect(saveButton().textContent).toBe('Save changes (0)')
    expect(saveButton().disabled).toBe(true)
  })
})

describe('typing and errors', () => {
  it('normalizes a typed value when it is committed', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit B'), '$1.2k')
    await user.tab()
    expect(value('Closed items', 'Unit B').value).toBe('1200')
    expect(saveButton().textContent).toBe('Save changes (1)')
  })

  it('an unreadable value blocks Save, with a message and a link to the input', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit B'), 'abc')
    expect(screen.queryByRole('alert')).toBeNull() // not while still typing in it
    await user.tab()
    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain('1 entry needs fixing')
    expect(summary.textContent).toContain('"abc" is not a number')
    expect(saveButton().disabled).toBe(true)
    expect(value('Closed items', 'Unit B').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('"abc" is not a number', { selector: 'p' })).toBeTruthy()

    await user.click(within(summary).getByRole('link', { name: 'Closed items, Unit B' }))
    expect(document.activeElement).toBe(value('Closed items', 'Unit B'))

    await typeInto(user, value('Closed items', 'Unit B'), '12')
    await user.tab()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('never stores 0 for unreadable text', async () => {
    const { h, user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit B'), '1.2.3')
    await user.tab()
    expect(saveButton().disabled).toBe(true)
    expect(h.saves).toEqual([])
  })

  it('n/a moves to the reason, which is required', async () => {
    const { h, user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit B'), 'n/a')
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(reason('Closed items', 'Unit B'))
    expect(value('Closed items', 'Unit B').value).toBe('')

    await user.tab()
    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain('Add a reason this is not applicable')
    expect(saveButton().disabled).toBe(true)

    await user.type(reason('Closed items', 'Unit B'), 'Not tracked')
    await user.tab()
    expect(saveButton().disabled).toBe(false)
    await user.click(saveButton())
    await waitFor(() => expect(h.saves).toHaveLength(1))
    expect(h.saves[0]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-b', period: PERIOD, naReason: 'Not tracked', expectedRevision: 0 },
    ])
  })

  it('a value and a reason together is an error', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit B'), '5')
    await user.type(reason('Closed items', 'Unit B'), 'oops')
    await user.tab()
    expect((await screen.findByRole('alert')).textContent).toContain('cannot have both')
    expect(saveButton().disabled).toBe(true)
  })

  it('saved data cannot be cleared to blank', async () => {
    const { user } = setup()
    await ready()
    await user.clear(value('Closed items', 'Unit A'))
    await user.tab()
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be cleared')
    expect(saveButton().disabled).toBe(true)
  })

  it('marks edited rows with an icon and text, not only color', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit A'), '41')
    const header = screen.getAllByRole('rowheader', { name: /^Unit A/ })[0] as HTMLElement
    expect(header.textContent).toContain('edited')
    expect(header.closest('tr')?.getAttribute('data-dirty')).toBe('true')
    expect(header.querySelector('svg')).toBeTruthy()
  })
})

describe('paste', () => {
  it('a 2x1 block fills this row and the next', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Closed items', 'Unit A'))
    await user.paste('10\n20\n')
    expect(value('Closed items', 'Unit A').value).toBe('10')
    expect(value('Total items', 'Unit A').value).toBe('20')
    expect(saveButton().textContent).toBe('Save changes (2)')
    expect(screen.getByRole('status').textContent).toBe('Pasted 2 rows.')
  })

  it('a single value pastes like typing', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Closed items', 'Unit B'))
    await user.paste('84%')
    await user.tab()
    expect(value('Closed items', 'Unit B').value).toBe('84')
  })

  it('skips read-only rows without using up a line of the block', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Total items', 'Unit A'))
    await user.paste('1\n2\n3\n')
    expect(value('Total items', 'Unit A').value).toBe('1')
    expect(value('Closed items', 'Unit D').value).toBe('5') // read-only, untouched
    expect(value('Closed items', 'Unit B').value).toBe('2')
    expect(value('Total items', 'Unit B').value).toBe('3')
  })

  it('ignores lines that run past the last row and says so', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Total items', 'Unit B'))
    await user.paste('1\n2\n3\n')
    expect(value('Total items', 'Unit B').value).toBe('1')
    expect(value('Defects', 'Unit C').value).toBe('2') // a different group, untouched
    expect(screen.getByRole('status').textContent).toMatch(/Pasted 2 rows; 1 more row did not fit/)
  })

  it('a two-column block fills the not-applicable reasons', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Closed items', 'Unit B'))
    await user.paste('n/a\tNo data this month\n12\t\n')
    expect(value('Closed items', 'Unit B').value).toBe('')
    expect(reason('Closed items', 'Unit B').value).toBe('No data this month')
    expect(value('Total items', 'Unit B').value).toBe('12')
    expect(reason('Total items', 'Unit B').value).toBe('')
    expect(saveButton().textContent).toBe('Save changes (2)')
  })

  it('a block pasted into the reason fills reasons only', async () => {
    const { user } = setup()
    await ready()
    await user.click(reason('Closed items', 'Unit B'))
    await user.paste('Why one\nWhy two\n')
    expect(reason('Closed items', 'Unit B').value).toBe('Why one')
    expect(reason('Total items', 'Unit B').value).toBe('Why two')
    expect(value('Closed items', 'Unit B').value).toBe('')
  })

  it('cells that fail to parse are flagged and not counted as changes', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Closed items', 'Unit B'))
    await user.paste('abc\n7\n')
    expect(value('Closed items', 'Unit B').value).toBe('abc')
    expect(value('Total items', 'Unit B').value).toBe('7')
    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain('"abc" is not a number')
    expect(saveButton().textContent).toBe('Save changes (1)')
    expect(saveButton().disabled).toBe(true)
  })

  it('does not paste into read-only rows', async () => {
    const { user } = setup()
    await ready()
    await user.click(value('Closed items', 'Unit D'))
    await user.paste('9\n9\n')
    expect(value('Closed items', 'Unit D').value).toBe('5')
    expect(saveButton().textContent).toBe('Save changes (0)')
  })
})

describe('read-only rows', () => {
  it('are read-only and styled differently, and reject typing', async () => {
    const { user } = setup()
    await ready()
    const input = value('Closed items', 'Unit D')
    expect(input.readOnly).toBe(true)
    expect(input.getAttribute('aria-readonly')).toBe('true')
    expect(input.className).toContain('border-dashed')
    expect(value('Closed items', 'Unit A').readOnly).toBe(false)
    await user.type(input, '999')
    expect(input.value).toBe('5')
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0)
  })
})

describe('preview', () => {
  it('waits 400 ms after the last edit, then shows the derived value and status', async () => {
    const { h } = setup()
    await ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Testing Library drains microtasks with setTimeout(0) and only advances a fake
    // clock it recognizes as Jest's; tell it how to advance vitest's.
    vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
    // No inter-key delay, so typing does not wait on the fake clock.
    const fake = userEvent.setup({ delay: null })

    await fake.clear(value('Closed items', 'Unit A'))
    await fake.type(value('Closed items', 'Unit A'), '4')
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1))
    expect(h.previews).toHaveLength(0)
    await fake.type(value('Closed items', 'Unit A'), '5') // restarts the wait
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1))
    expect(h.previews).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(1))
    await vi.waitFor(() => expect(h.previews).toHaveLength(1))
    expect(h.previews[0]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-a', period: PERIOD, value: 45, expectedRevision: 3 },
    ])
    // Fake timers: vi.waitFor advances them while it polls (Testing Library's does not).
    await vi.waitFor(() => expect(screen.getAllByText('90.0%').length).toBeGreaterThan(0))
    const cell = screen.getAllByText('90.0%')[0]?.closest('td') as HTMLElement
    expect(within(cell).getByRole('img', { name: 'Status: Green' })).toBeTruthy()
  })

  it('clears the preview when the edit is reverted, without another request', async () => {
    const { h, user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    expect((await screen.findAllByText('90.0%', undefined, { timeout: 2000 })).length).toBe(2) // both Unit A rows
    expect(h.previews).toHaveLength(1)

    await user.keyboard('{Escape}')
    expect(screen.queryAllByText('90.0%')).toHaveLength(0)
    await new Promise((r) => setTimeout(r, PREVIEW_DEBOUNCE_MS + 100))
    expect(h.previews).toHaveLength(1)
  })

  it('sends only valid, changed rows', async () => {
    const { h, user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit A'), '40') // same as saved
    await typeInto(user, value('Closed items', 'Unit B'), '12')
    await user.tab()
    await waitFor(() => expect(h.previews).toHaveLength(1), { timeout: 2000 })
    expect(h.previews[0]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-b', period: PERIOD, value: 12, expectedRevision: 0 },
    ])
  })
})

describe('saving', () => {
  it('sends one batch with each row\'s revision, clears dirty, refreshes, and announces it', async () => {
    const { h, user } = setup()
    await ready()
    await screen.findByRole('rowheader', { name: 'On-time delivery' })
    expect(h.counts).toEqual({ entry: 1, view: 1 })

    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await typeInto(user, value('Closed items', 'Unit B'), '12')
    await user.tab()
    expect(saveButton().textContent).toBe('Save changes (2)')
    await user.click(saveButton())

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 2 values.'))
    expect(h.saves).toHaveLength(1)
    expect(h.saves[0]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-a', period: PERIOD, value: 45, expectedRevision: 3 },
      { measureKey: 'closed', subjectId: 'unit-b', period: PERIOD, value: 12, expectedRevision: 0 },
    ])
    expect(saveButton().textContent).toBe('Save changes (0)')
    expect(saveButton().disabled).toBe(true)
    expect(value('Closed items', 'Unit A').value).toBe('45')
    // The entry grid and the scorecard view were both invalidated and fetched again.
    await waitFor(() => expect(h.counts).toEqual({ entry: 2, view: 2 }))
    expect(screen.getAllByRole('rowheader', { name: /^Unit A$/ })).toHaveLength(2)

    // A second save builds on the new revisions; typing clears the old confirmation.
    await typeInto(user, value('Closed items', 'Unit A'), '46')
    expect(screen.getByRole('status').textContent).toBe('')
    await user.click(saveButton())
    await waitFor(() => expect(h.saves).toHaveLength(2))
    expect(h.saves[1]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-a', period: PERIOD, value: 46, expectedRevision: 4 },
    ])
  })

  it('blocks a save of more than 500 changes', async () => {
    const many = Array.from({ length: 501 }, (_, i) => row('closed', `unit-${i}`, { subjectName: `Unit ${i}` }))
    setup(many)
    await ready()
    fireEvent.paste(screen.getAllByRole('textbox')[0] as HTMLElement, {
      clipboardData: { getData: () => Array.from({ length: 501 }, (_, i) => String(i + 1)).join('\n') },
    })
    await waitFor(() => expect(saveButton().textContent).toBe('Save changes (501)'))
    expect(saveButton().disabled).toBe(true)
    expect(screen.getByText(/Too many changes to save at once \(501\); the limit is 500/)).toBeTruthy()
  })
})

describe('conflicts', () => {
  async function conflictOnUnitA() {
    const ctx = setup()
    await ready()
    await typeInto(ctx.user, value('Closed items', 'Unit A'), '45')
    await typeInto(ctx.user, value('Closed items', 'Unit B'), '12')
    await ctx.user.tab()
    ctx.h.externalChange('closed', 'unit-a', 77) // someone else saves first (revision 3 -> 4)
    await ctx.user.click(saveButton())
    await screen.findByText(/Changed by someone else: now 77/)
    return ctx
  }

  it('marks the conflicting row and offers both choices; nothing was saved', async () => {
    const { h } = await conflictOnUnitA()
    expect(screen.getByRole('button', { name: /^Use theirs/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Keep mine/ })).toBeTruthy()
    expect(screen.getAllByText(/Changed by someone else/)).toHaveLength(1)
    expect(saveButton().disabled).toBe(true)
    expect(screen.getByText(/Resolve the conflicts before saving/)).toBeTruthy()
    expect(h.rows.find((r) => r.subjectId === 'unit-b' && r.measureKey === 'closed')?.value).toBeUndefined()
    expect(value('Closed items', 'Unit B').value).toBe('12') // other edits are kept
  })

  it('Use theirs adopts the current value and clears that row\'s edit', async () => {
    const { h, user } = await conflictOnUnitA()
    await user.click(screen.getByRole('button', { name: /^Use theirs/ }))
    expect(value('Closed items', 'Unit A').value).toBe('77')
    expect(screen.queryByText(/Changed by someone else/)).toBeNull()
    expect(saveButton().textContent).toBe('Save changes (1)') // Unit B still pending
    await user.click(saveButton())
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 1 value.'))
    expect(h.saves[1]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-b', period: PERIOD, value: 12, expectedRevision: 0 },
    ])
  })

  it('Keep mine keeps the value and resubmits with the new revision', async () => {
    const { h, user } = await conflictOnUnitA()
    await user.click(screen.getByRole('button', { name: /^Keep mine/ }))
    expect(value('Closed items', 'Unit A').value).toBe('45')
    expect(screen.queryByText(/Changed by someone else/)).toBeNull()
    expect(saveButton().textContent).toBe('Save changes (2)')
    await user.click(saveButton())
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 2 values.'))
    expect(h.saves[1]).toEqual([
      { measureKey: 'closed', subjectId: 'unit-a', period: PERIOD, value: 45, expectedRevision: 4 },
      { measureKey: 'closed', subjectId: 'unit-b', period: PERIOD, value: 12, expectedRevision: 0 },
    ])
    expect(h.rows.find((r) => r.subjectId === 'unit-a' && r.measureKey === 'closed')?.value).toBe(45)
  })
})

describe('save failures', () => {
  it('shows the API message on each row the server refuses', async () => {
    const { h, user } = setup()
    await ready()
    h.failNextSave = () =>
      HttpResponse.json(
        {
          error: {
            code: 'forbidden',
            message: 'you may not write one or more of these data points',
            details: [{ path: 'writes[1]', message: 'not permitted to write closed for unit-b' }],
          },
        },
        { status: 403 },
      )
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await typeInto(user, value('Closed items', 'Unit B'), '12')
    await user.tab()
    await user.click(saveButton())
    const message = await screen.findByText('not permitted to write closed for unit-b')
    expect(message.closest('tr')?.id).toBe(value('Closed items', 'Unit B').getAttribute('aria-describedby'))
    expect(screen.getAllByText('not permitted to write closed for unit-b')).toHaveLength(1)
    expect(screen.getByText(/Nothing was saved\. you may not write one or more/)).toBeTruthy()
    // Edits survive.
    expect(value('Closed items', 'Unit A').value).toBe('45')
    expect(saveButton().textContent).toBe('Save changes (2)')
  })

  it('shows a banner with Retry for other errors', async () => {
    const { h, user } = setup()
    await ready()
    h.failNextSave = () =>
      HttpResponse.json({ error: { code: 'invalid', message: 'service unavailable' } }, { status: 503 })
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await user.tab()
    await user.click(saveButton())
    const banner = await screen.findByText(/Nothing was saved\. service unavailable/)
    expect(banner).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 1 value.'))
    expect(h.saves).toHaveLength(2)
    expect(screen.queryByText(/Nothing was saved/)).toBeNull()
  })
})

describe('unsaved changes', () => {
  const location = () => screen.getByTestId('location').textContent

  it('asks before leaving the page with edits; Stay keeps them, Discard leaves', async () => {
    const { user } = setup()
    await ready()
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(location()).toBe('/entry')
    await user.click(within(dialog).getByRole('button', { name: 'Stay and keep editing' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(location()).toBe('/entry')
    expect(value('Closed items', 'Unit A').value).toBe('45')

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }))
    await waitFor(() => expect(location()).toBe('/elsewhere'))
  })

  it('does not ask when nothing is unsaved', async () => {
    const { user } = setup()
    await ready()
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))
    await waitFor(() => expect(location()).toBe('/elsewhere'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('warns the browser on reload only while edits are unsaved', async () => {
    const { user } = setup()
    await ready()
    const fire = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(fire()).toBe(false)
    await typeInto(user, value('Closed items', 'Unit A'), '45')
    expect(fire()).toBe(true)
    await user.click(saveButton())
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 1 value.'))
    expect(fire()).toBe(false)
  })
})

describe('accessibility', () => {
  it('has no axe violations, including with edits, errors and conflicts showing', async () => {
    const { user, container, h } = setup()
    await ready()
    await screen.findByRole('rowheader', { name: 'On-time delivery' })
    expect((await axe(container)).violations).toEqual([])

    await typeInto(user, value('Closed items', 'Unit A'), '45')
    await typeInto(user, value('Closed items', 'Unit B'), 'abc')
    await user.tab()
    await screen.findByRole('alert')
    expect((await axe(container)).violations).toEqual([])

    await typeInto(user, value('Closed items', 'Unit B'), '3')
    await user.tab()
    h.externalChange('closed', 'unit-a', 77)
    await user.click(saveButton())
    await screen.findByText(/Changed by someone else/)
    expect((await axe(container)).violations).toEqual([])
  })
})
