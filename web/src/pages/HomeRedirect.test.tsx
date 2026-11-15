import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { orgUnits } from '../test/fixtures'
import { API, server } from '../test/server'
import { renderApp } from '../test/utils'
import { HomeRedirect } from './HomeRedirect'

function LocationProbe() {
  const l = useLocation()
  return <p data-testid="location">{l.pathname + l.search}</p>
}

function home(route: string) {
  renderApp(
    <Routes>
      <Route index element={<HomeRedirect />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { route },
  )
}

const location = () => screen.getByTestId('location').textContent ?? ''

describe('HomeRedirect', () => {
  it('opens the first scorecard at the company when no default is saved', async () => {
    home('/?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main?period=2026-M10'))
  })

  it('opens the first scorecard at my saved default scope', async () => {
    server.use(http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: 'unit-b' })))
    home('/?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main?period=2026-M10&scope=unit-b'))
  })

  it('keeps a scope already in the link', async () => {
    server.use(http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: 'unit-b' })))
    home('/?scope=unit-a')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main?scope=unit-a'))
  })

  it('opens at the company when the saved default unit no longer exists', async () => {
    server.use(http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: 'unit-gone' })))
    home('/?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main?period=2026-M10'))
  })

  it('opens at the company when the saved default unit is retired for the period', async () => {
    server.use(
      http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: 'unit-b' })),
      http.get(`${API}/v1/org/units`, () =>
        HttpResponse.json({ units: orgUnits.map((u) => (u.id === 'unit-b' ? { ...u, retiredFrom: '2026-M08' } : u)) }),
      ),
    )
    home('/?period=2026-M10')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main?period=2026-M10'))
  })

  it('still opens the scorecard when the preferences cannot load', async () => {
    server.use(
      http.get(`${API}/v1/me/preferences`, () =>
        HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 }),
      ),
    )
    home('/')
    await waitFor(() => expect(location()).toBe('/scorecards/sc-main'))
  })
})
