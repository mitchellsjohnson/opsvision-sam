import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
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
