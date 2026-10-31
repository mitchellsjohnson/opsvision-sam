import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meFor, tenant } from '../test/fixtures'
import { API, server } from '../test/server'
import { renderApp } from '../test/utils'
import { PeriodPicker } from './PeriodPicker'

function Search() {
  const { search } = useLocation()
  return <output data-testid="search">{search}</output>
}

function picker(route: string) {
  renderApp(
    <>
      <PeriodPicker />
      <Search />
    </>,
    { route },
  )
  return userEvent.setup()
}

const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '')

describe('PeriodPicker', () => {
  it('reflects the period in the URL', () => {
    picker('/?period=2026-Q3')
    expect((screen.getByLabelText('View by') as HTMLSelectElement).value).toBe('quarter')
    expect((screen.getByLabelText('Fiscal year') as HTMLSelectElement).value).toBe('2026')
    expect((screen.getByLabelText('Quarter') as HTMLSelectElement).value).toBe('3')
  })

  it('changing the grain updates the URL and keeps other params', async () => {
    const user = picker('/?period=2026-M10&subject=unit-a')
    await user.selectOptions(screen.getByLabelText('View by'), 'quarter')
    expect(search().get('period')).toBe('2026-Q4')
    expect(search().get('subject')).toBe('unit-a')
  })

  it('changing the month updates the URL', async () => {
    const user = picker('/?period=2026-M10')
    await user.selectOptions(screen.getByLabelText('Month'), '3')
    expect(search().get('period')).toBe('2026-M03')
  })

  it('changing the year updates the URL', async () => {
    const user = picker('/?period=2026-H2')
    await user.click(screen.getByRole('button', { name: 'Previous fiscal year' }))
    expect(search().get('period')).toBe('2025-H2')
    await user.click(screen.getByRole('button', { name: 'Next fiscal year' }))
    expect(search().get('period')).toBe('2026-H2')
  })

  it('toggles YTD in the URL', async () => {
    const user = picker('/?period=2026-M10')
    const toggle = screen.getByRole('checkbox', { name: 'Year to date' })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    await user.click(toggle)
    expect(search().get('ytd')).toBe('1')
    expect((toggle as HTMLInputElement).checked).toBe(true)
    await user.click(toggle)
    expect(search().has('ytd')).toBe(false)
  })

  it('hides the unit select for a fiscal year', () => {
    picker('/?period=2026-FY')
    expect(screen.queryByLabelText('Month')).toBeNull()
    expect(screen.queryByLabelText('Quarter')).toBeNull()
  })

  it('shows the label of the period', () => {
    picker('/?period=2026-M10')
    expect(screen.getByText('Oct 2026')).toBeTruthy()
  })
})

function julyFiscalYear() {
  server.use(
    http.get(`${API}/v1/me`, () =>
      HttpResponse.json({ ...meFor('admin'), tenant: { ...tenant, fiscalYearStartMonth: 7 } }),
    ),
  )
}

describe('PeriodPicker with a July fiscal year', () => {
  afterEach(() => vi.useRealTimers())

  it('lists months from July and labels the fiscal month with its calendar month', async () => {
    julyFiscalYear()
    picker('/?period=2027-M01')
    // FY2027 month 1 is July 2026.
    expect(await screen.findByText('Jul 2026')).toBeTruthy()
    const month = screen.getByLabelText('Month') as HTMLSelectElement
    expect([...month.options].map((o) => o.text)).toEqual([
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    ])
    expect(month.value).toBe('1')
    expect((screen.getByLabelText('Fiscal year') as HTMLSelectElement).value).toBe('2027')
  })

  it('picks a fiscal month by its calendar name', async () => {
    julyFiscalYear()
    const user = picker('/?period=2027-M01')
    await screen.findByText('Jul 2026')
    await user.selectOptions(screen.getByLabelText('Month'), 'Jan')
    expect(search().get('period')).toBe('2027-M07')
    expect(screen.getByText('Jan 2027')).toBeTruthy()
  })

  it('converts to a fiscal quarter and labels its months', async () => {
    julyFiscalYear()
    const user = picker('/?period=2027-M07')
    await screen.findByText('Jan 2027')
    await user.selectOptions(screen.getByLabelText('View by'), 'quarter')
    expect(search().get('period')).toBe('2027-Q3')
    const quarter = screen.getByLabelText('Quarter') as HTMLSelectElement
    expect([...quarter.options].map((o) => o.text)).toEqual([
      'Q1 (Jul–Sep)', 'Q2 (Oct–Dec)', 'Q3 (Jan–Mar)', 'Q4 (Apr–Jun)',
    ])
    expect(screen.getByText('Q3 FY2027')).toBeTruthy()
  })

  it('defaults to the current fiscal month', async () => {
    julyFiscalYear()
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 6, 15) })
    picker('/')
    // July 2026 is the first month of FY2027.
    expect(await screen.findByDisplayValue('FY2027')).toBeTruthy()
    expect((screen.getByLabelText('Month') as HTMLSelectElement).value).toBe('1')
    expect(screen.getByText('Jul 2026')).toBeTruthy()
  })
})
