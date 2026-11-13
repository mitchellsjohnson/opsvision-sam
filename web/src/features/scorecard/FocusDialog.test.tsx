import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addServiceUptime, buildView, viewHandlers } from '../../test/viewFixtures'

const OVERVIEW = '/scorecards/sc-main/overview?period=2026-M10'

function renderOverview(route = OVERVIEW) {
  server.use(...viewHandlers())
  renderApp(<App />, { route })
}

function metricCard(name: string): HTMLElement {
  return screen.getByRole('article', { name: new RegExp(name) })
}

describe('FocusDialog', () => {
  it('shows a dialog named with the metric when focus is set', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('closes on Escape and clears focus from the URL', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next metric' })).toBeNull()
  })

  it('Next moves to the following metric in layout order', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Next metric' }))
    expect(await screen.findByRole('dialog', { name: /Defect rate/i })).toBeTruthy()
  })

  it('View as table links to /table without focus in the query', async () => {
    renderOverview(`${OVERVIEW}&focus=on_time_pct`)
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    for (const link of within(dialog).getAllByRole('link', { name: 'View as table' })) {
      const href = link.getAttribute('href') ?? ''
      expect(href).toContain('/scorecards/sc-main/table')
      expect(href).not.toContain('focus=')
    }
  })

  it('does not open focus when a chart point is clicked; empty card space sets focus', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const card = metricCard('On-time delivery')
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: /Oct: 84\.3%/ }))
    expect(screen.queryByRole('dialog', { name: /On-time delivery/i })).toBeNull()
    await user.click(card)
    expect(await screen.findByRole('dialog', { name: /On-time delivery/i })).toBeTruthy()
  })

  it('24 asks for this metric only and keeps focus on the toggle while it loads', async () => {
    const seen: URL[] = []
    server.use(...viewHandlers({ onView: (u) => seen.push(u) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    const user = userEvent.setup()
    const toggle = within(dialog).getByRole('button', { name: '24' })
    await user.click(toggle)
    expect(document.activeElement).toBe(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    await waitFor(() => expect(within(dialog).getAllByRole('button', { name: /^Sep: / })).toHaveLength(2))
    const req = seen.find((u) => u.searchParams.has('metrics'))
    expect(req?.searchParams.getAll('metrics')).toEqual(['on_time_pct'])
    expect(req?.searchParams.getAll('periods')).toHaveLength(24)
    expect(document.activeElement).toBe(toggle)
  })

  it('a failed 24-month request says so and offers Try again', async () => {
    server.use(
      ...viewHandlers({
        respond: (u) =>
          u.searchParams.has('metrics')
            ? HttpResponse.json({ code: 'internal', message: 'The server had a problem.' }, { status: 500 })
            : undefined,
      }),
    )
    renderApp(<App />, { route: `${OVERVIEW}&focus=on_time_pct` })
    const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
    await within(dialog).findByRole('region', { name: 'Org breakdown' })
    await userEvent.setup().click(within(dialog).getByRole('button', { name: '24' }))
    const alert = await within(dialog).findByRole('alert', {}, { timeout: 4000 })
    expect(alert.textContent).toMatch(/couldn’t load this chart/)
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '24' })).toBeTruthy()
  })

  it('an item-only metric shows the worst of its services and lists them without scope buttons', async () => {
    server.use(...viewHandlers({ respond: (u) => HttpResponse.json(addServiceUptime(buildView(u.searchParams))) }))
    renderApp(<App />, { route: `${OVERVIEW}&focus=svc_uptime` })
    const dialog = await screen.findByRole('dialog', { name: /Service uptime/i })
    expect(await within(dialog).findByText('worst of 2 services')).toBeTruthy()
    const breakdown = within(dialog).getByRole('region', { name: 'Org breakdown' })
    expect(within(breakdown).getByText('Web service')).toBeTruthy()
    expect(within(breakdown).queryByRole('button')).toBeNull()
  })

  it('says so in plain words when the PNG cannot be made', async () => {
    class FailingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    vi.stubGlobal('Image', FailingImage)
    try {
      renderOverview(`${OVERVIEW}&focus=on_time_pct`)
      const dialog = await screen.findByRole('dialog', { name: /On-time delivery/i })
      await within(dialog).findByRole('region', { name: 'Org breakdown' })
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Export PNG' }))
      expect((await within(dialog).findByRole('alert')).textContent).toBe('We couldn’t make the image. Try SVG or CSV.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('closing after a card background click returns focus to that card’s Expand button', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    const user = userEvent.setup()
    await user.click(metricCard('On-time delivery'))
    await screen.findByRole('dialog', { name: /On-time delivery/i })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(within(metricCard('On-time delivery')).getByRole('button', { name: 'Expand' }))
  })
})
