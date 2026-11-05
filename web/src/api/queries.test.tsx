import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { AuthContext } from '../auth/context'
import { API, server } from '../test/server'
import { newQueryClient, testAuth } from '../test/utils'
import { useApplyImport, useEntry, usePublishVersion, useSaveData, useVersions, useView } from './queries'

describe('queries', () => {
  it('useSaveData invalidates the scorecard view and entry queries', async () => {
    const client = newQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={testAuth()}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
    server.use(
      http.get(`${API}/v1/scorecards/sc/view`, () =>
        HttpResponse.json({ periods: ['2026-M10'], ytd: [], categories: [], rows: [], versionByPeriod: {} }),
      ),
      http.get(`${API}/v1/scorecards/sc/entry`, () =>
        HttpResponse.json({ period: '2026-M10', rows: [] }),
      ),
      http.post(`${API}/v1/scorecards/sc/data:batch`, () => HttpResponse.json({ saved: [] })),
    )
    const req = { periods: ['2026-M10'] }
    const { result } = renderHook(
      () => ({
        view: useView('sc', req),
        entry: useEntry('sc', '2026-M10'),
        save: useSaveData('sc'),
      }),
      { wrapper },
    )
    await waitFor(() => {
      expect(result.current.view.isSuccess).toBe(true)
      expect(result.current.entry.isSuccess).toBe(true)
    })
    expect(client.getQueryState(['view', 'sc', req])?.isInvalidated).toBe(false)

    result.current.save.mutate({ writes: [] })
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))
    // Refetch completes after invalidation; the query was refetched at least once more.
    await waitFor(() => expect(client.getQueryState(['view', 'sc', req])?.dataUpdateCount).toBe(2))
    await waitFor(() =>
      expect(client.getQueryState(['entry', 'sc', '2026-M10'])?.dataUpdateCount).toBe(2),
    )
  })

  function setup() {
    const client = newQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={testAuth()}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
    server.use(
      http.get(`${API}/v1/scorecards/sc/view`, () =>
        HttpResponse.json({ periods: ['2026-M10'], ytd: [], categories: [], rows: [], versionByPeriod: {} }),
      ),
      http.get(`${API}/v1/scorecards/sc/entry`, () => HttpResponse.json({ period: '2026-M10', rows: [] })),
      http.get(`${API}/v1/scorecards/sc/versions`, () => HttpResponse.json({ versions: [] })),
    )
    return { client, wrapper }
  }
  const req = { periods: ['2026-M10'] }

  it('usePublishVersion refreshes the version list, the view and the entry grid', async () => {
    const { client, wrapper } = setup()
    server.use(
      http.post(`${API}/v1/scorecards/sc/versions/v1/publish`, () =>
        HttpResponse.json({ id: 'v1', scorecardId: 'sc', name: 'V', status: 'published', effectiveFrom: '2026-M11', revision: 2, content: { categories: [], measures: [], metrics: [] } }),
      ),
    )
    const { result } = renderHook(
      () => ({
        view: useView('sc', req),
        entry: useEntry('sc', '2026-M10'),
        versions: useVersions('sc'),
        publish: usePublishVersion('sc'),
      }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.versions.isSuccess && result.current.view.isSuccess && result.current.entry.isSuccess).toBe(true))
    result.current.publish.mutate({ v: 'v1', effectiveFrom: '2026-M11' })
    await waitFor(() => expect(result.current.publish.isSuccess).toBe(true))
    await waitFor(() => expect(client.getQueryState(['view', 'sc', req])?.dataUpdateCount).toBe(2))
    await waitFor(() => expect(client.getQueryState(['entry', 'sc', '2026-M10'])?.dataUpdateCount).toBe(2))
    await waitFor(() => expect(client.getQueryState(['versions', 'sc'])?.dataUpdateCount).toBe(2))
  })

  it('useApplyImport refreshes the view and the entry grid', async () => {
    const { client, wrapper } = setup()
    server.use(
      http.post(`${API}/v1/imports/imp-1/apply`, () =>
        HttpResponse.json({ id: 'imp-1', status: 'applied', counts: { dataPoints: 0, overrides: 0, versionText: 0, legacyNotes: 0 }, findings: [], sample: [] }),
      ),
    )
    const { result } = renderHook(
      () => ({ view: useView('sc', req), entry: useEntry('sc', '2026-M10'), apply: useApplyImport() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.view.isSuccess && result.current.entry.isSuccess).toBe(true))
    result.current.apply.mutate('imp-1')
    await waitFor(() => expect(result.current.apply.isSuccess).toBe(true))
    await waitFor(() => expect(client.getQueryState(['view', 'sc', req])?.dataUpdateCount).toBe(2))
    await waitFor(() => expect(client.getQueryState(['entry', 'sc', '2026-M10'])?.dataUpdateCount).toBe(2))
  })
})
