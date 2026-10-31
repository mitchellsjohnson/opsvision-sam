import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { viewHandlers } from '../../test/viewFixtures'
import { PeriodPicker } from '../../shell/PeriodPicker'
import { EntryPage } from './EntryPage'

function Search() {
  const { search } = useLocation()
  return <output data-testid="search">{search}</output>
}

function entryRows(period: string, subjectName: string) {
  return [
    {
      measureKey: 'closed',
      measureName: 'Closed items',
      metricKeys: ['on_time_pct'],
      subjectId: 'unit-a',
      subjectName,
      period,
      value: 40,
      naReason: '',
      revision: 1,
      canEdit: true,
    },
  ]
}

function setup(route: string, scorecards = [{ id: 'sc-main', name: 'Main scorecard' }]) {
  const requested: string[] = []
  server.use(
    ...viewHandlers(),
    http.get(`${API}/v1/scorecards`, () => HttpResponse.json({ scorecards })),
    http.get(`${API}/v1/scorecards/:sc/entry`, ({ params, request }) => {
      const period = new URL(request.url).searchParams.get('period') ?? ''
      requested.push(`${params.sc}:${period}`)
      return HttpResponse.json({
        period,
        rows: entryRows(period, params.sc === 'sc-two' ? 'Unit Z' : 'Unit A'),
      })
    }),
  )
  renderApp(
    <>
      <PeriodPicker monthOnly />
      <EntryPage />
      <Search />
    </>,
    { route },
  )
  return { requested, user: userEvent.setup() }
}

describe('EntryPage', () => {
  it('loads the first scorecard and the month from the URL', async () => {
    const { requested } = setup('/entry?period=2026-M10')
    expect(screen.getByRole('heading', { level: 1, name: 'Enter data' })).toBeTruthy()
    await screen.findByRole('table', { name: 'Main scorecard, Oct 2026' })
    expect(screen.getByText(/^Entering/).textContent).toContain('Oct 2026')
    expect(requested).toEqual(['sc-main:2026-M10'])
  })

  it('shows the last month of a quarter in the URL', async () => {
    const { requested } = setup('/entry?period=2026-Q3')
    await screen.findByRole('table', { name: 'Main scorecard, Sep 2026' })
    expect(requested).toEqual(['sc-main:2026-M09'])
  })

  it('switches scorecard and month, keeping the choice in the URL', async () => {
    const { requested, user } = setup('/entry?period=2026-M10', [
      { id: 'sc-main', name: 'Main scorecard' },
      { id: 'sc-two', name: 'Second scorecard' },
    ])
    await screen.findByRole('table', { name: 'Main scorecard, Oct 2026' })
    await user.selectOptions(screen.getByLabelText('Scorecard'), 'sc-two')
    await screen.findByRole('table', { name: 'Second scorecard, Oct 2026' })
    expect(new URLSearchParams(screen.getByTestId('search').textContent ?? '').get('scorecard')).toBe('sc-two')

    await user.selectOptions(screen.getByLabelText('Month'), '3')
    await screen.findByRole('table', { name: 'Second scorecard, Mar 2026' })
    await waitFor(() => expect(requested).toContain('sc-two:2026-M03'))
  })

  it('says so when there are no scorecards', async () => {
    setup('/entry?period=2026-M10', [])
    expect(await screen.findByText(/no scorecards to enter data for/i)).toBeTruthy()
  })
})
