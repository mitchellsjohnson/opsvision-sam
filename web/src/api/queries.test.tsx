import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { AuthContext } from '../auth/context'
import { API, server } from '../test/server'
import { newQueryClient, testAuth } from '../test/utils'
import {
  useApplyImport,
  useCellRca,
  useCellRcaCounts,
  useCellRcaDraft,
  useCellRcas,
  useDeleteCellRca,
  useEntry,
  usePublishVersion,
  usePutCellRca,
  useReportDocument,
  useSaveData,
  useVersions,
  useView,
} from './queries'

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

  describe('RCAs', () => {
    const ref = { metric: 'uptime', subject: 'webhooks', period: '2026-M10' }

    it('useCellRca reads one cell, and waits while there is no cell', async () => {
      const { wrapper } = setup()
      const { result } = renderHook(() => ({ none: useCellRca('sc', null), cell: useCellRca('sc', ref) }), { wrapper })
      await waitFor(() => expect(result.current.cell.isSuccess).toBe(true))
      expect(result.current.cell.data?.subjectName).toBe('Webhooks')
      expect(result.current.none.fetchStatus).toBe('idle')
    })

    it('usePutCellRca invalidates the cell, the list, the counts and the views of that period', async () => {
      const { client, wrapper } = setup()
      const other = { periods: ['2026-M09'] }
      const board = { periods: ['2026-M09', '2026-M10'], ytd: ['2026-M10'] }
      client.setQueryData(['rca', 'sc', ref], { note: null })
      client.setQueryData(['rcas', 'sc', '2026-M10', { state: 'needed' }], { items: [] })
      client.setQueryData(['rca-counts', 'sc', '2026-M10'], { counts: {} })
      client.setQueryData(['view', 'sc', req], {})
      client.setQueryData(['view', 'sc', board], {})
      client.setQueryData(['view', 'sc', other], {})
      client.setQueryData(['rcas', 'sc', '2026-M09', { state: 'needed' }], { items: [] })
      const { result } = renderHook(() => usePutCellRca('sc'), { wrapper })
      result.current.mutate({ ...ref, text: 'Why', links: [], expectedRevision: 0 })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(client.getQueryState(['rca', 'sc', ref])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['rcas', 'sc', '2026-M10', { state: 'needed' }])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['rca-counts', 'sc', '2026-M10'])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['view', 'sc', req])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['view', 'sc', board])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['view', 'sc', other])?.isInvalidated).toBe(false)
      expect(client.getQueryState(['rcas', 'sc', '2026-M09', { state: 'needed' }])?.isInvalidated).toBe(false)
      // The card shows the saved note at once.
      expect(client.getQueryData<{ note: { revision: number } }>(['rca', 'sc', ref])?.note.revision).toBe(1)
    })

    it('useDeleteCellRca sends the revision and invalidates the same queries', async () => {
      const { client, wrapper } = setup()
      let query = ''
      server.use(
        http.delete(`${API}/v1/scorecards/sc/rca`, ({ request }) => {
          query = new URL(request.url).search
          return new HttpResponse(null, { status: 204 })
        }),
      )
      client.setQueryData(['rca-counts', 'sc', '2026-M10'], { counts: {} })
      const { result } = renderHook(() => useDeleteCellRca('sc'), { wrapper })
      result.current.mutate({ ...ref, expectedRevision: 3 })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(new URLSearchParams(query).get('expectedRevision')).toBe('3')
      expect(client.getQueryState(['rca-counts', 'sc', '2026-M10'])?.isInvalidated).toBe(true)
    })

    it('useCellRcas and useCellRcaCounts ask for the period; counts only, kept for a minute', async () => {
      const { client, wrapper } = setup()
      const seen: URLSearchParams[] = []
      server.use(
        http.get(`${API}/v1/scorecards/sc/rcas`, ({ request }) => {
          const q = new URL(request.url).searchParams
          seen.push(q)
          return HttpResponse.json({ period: '2026-M10', counts: { needed: 3, stale: 1, written: 1, available: 4, neededMine: 2 }, items: [] })
        }),
      )
      const { result } = renderHook(
        () => ({
          list: useCellRcas('sc', { period: '2026-M10', state: 'all', mine: true }),
          counts: useCellRcaCounts('sc', '2026-M10'),
        }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.list.isSuccess && result.current.counts.isSuccess).toBe(true))
      const counts = seen.find((q) => q.get('countsOnly') === 'true')
      const list = seen.find((q) => q.get('countsOnly') === null)
      expect(counts?.get('period')).toBe('2026-M10')
      expect(list?.get('state')).toBe('all')
      expect(list?.get('mine')).toBe('true')
      expect(result.current.counts.data?.counts.neededMine).toBe(2)
      expect(result.current.list.data?.pages[0]?.counts.needed).toBe(3)
      expect(client.getQueryCache().find({ queryKey: ['rca-counts', 'sc', '2026-M10'] })?.isStale()).toBe(false)
    })

    it('useCellRcaDraft polls until SAM has written the draft', async () => {
      const { wrapper } = setup()
      let polls = 0
      server.use(
        http.get(`${API}/v1/scorecards/sc/rca/draft/draft-1`, () => {
          polls++
          return HttpResponse.json({ id: 'draft-1', pending: false, text: 'Drafted.', createdAt: '2026-11-20T12:00:00Z', warnings: ['INC-9999'] })
        }),
      )
      const { result } = renderHook(() => useCellRcaDraft('sc'), { wrapper })
      result.current.mutate({ ref })
      await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 4000 })
      expect(polls).toBe(1)
      expect(result.current.data?.warnings).toEqual(['INC-9999'])
    })

    it('useReportDocument asks for the RCAs', async () => {
      const { wrapper } = setup()
      const seen: { query?: URLSearchParams } = {}
      server.use(
        http.get(`${API}/v1/scorecards/sc/reports/2026-M10`, ({ request }) => {
          seen.query = new URL(request.url).searchParams
          return HttpResponse.json({})
        }),
      )
      const { result } = renderHook(() => useReportDocument('sc', '2026-M10', ''), { wrapper })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(seen.query?.get('rcas')).toBe('true')
      expect(seen.query?.get('standing')).toBe('true')
    })
  })
})
