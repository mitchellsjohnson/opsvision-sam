import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
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
    expect((screen.getByLabelText('Year') as HTMLInputElement).value).toBe('2026')
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
    await user.click(screen.getByRole('button', { name: 'Previous year' }))
    expect(search().get('period')).toBe('2025-H2')
    await user.click(screen.getByRole('button', { name: 'Next year' }))
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
})
