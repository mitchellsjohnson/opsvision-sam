import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { AuthContext } from '../auth/context'
import {
  deploymentMissing,
  epicsMissing,
  securityMissing,
  uptimeCardSummary,
  uptimeSummary,
  webhooksAttribution,
} from '../test/rcaFixtures'
import { API, server } from '../test/server'
import { newQueryClient, testAuth } from '../test/utils'
import {
  mergeAttribution,
  PublishBlockedError,
  useApplyImport,
  useCellAttribution,
  useDeleteMetricSummary,
  useEntry,
  useMetricSummaries,
  useMetricSummary,
  useMetricSummaryCounts,
  useMetricSummaryDraft,
  usePublishReport,
  usePublishVersion,
  usePutMetricSummary,
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

  describe('Exec summaries and attribution', () => {
    const ref = { metric: 'uptime', subject: 'webhooks', period: '2026-M10' }
    const SUMMARY = `${API}/v1/scorecards/sc/metric-summaries/uptime/2026-M10`

    it('useCellAttribution reads the first page, idles without a cell, and pages incidents by cursor', async () => {
      const { wrapper } = setup()
      const bus = { ...ref, subject: 'event-bus' }
      const { result } = renderHook(() => ({ none: useCellAttribution('sc', null), cell: useCellAttribution('sc', bus) }), { wrapper })
      await waitFor(() => expect(result.current.cell.isSuccess).toBe(true))
      expect(result.current.none.fetchStatus).toBe('idle')
      expect(mergeAttribution(result.current.cell.data)?.incidents).toHaveLength(5)
      expect(result.current.cell.hasNextPage).toBe(true)
      await result.current.cell.fetchNextPage()
      await waitFor(() => expect(result.current.cell.data?.pages).toHaveLength(2))
      const merged = mergeAttribution(result.current.cell.data)!
      expect(merged.incidents).toHaveLength(37)
      expect(merged.incidents.at(-1)?.externalId).toBe('INC-3037')
      expect(merged.incidentsCursor).toBeUndefined()
      expect(merged.incidentsTotal).toBe(37)
      expect(result.current.cell.hasNextPage).toBe(false)
    })

    it('usePutMetricSummary invalidates the summary, the list, the counts, the attribution and the views of the period', async () => {
      const { client, wrapper } = setup()
      let path = ''
      server.use(
        http.put(SUMMARY, async ({ request }) => {
          path = new URL(request.url).pathname
          const body = (await request.json()) as { text: string; links: unknown[]; expectedRevision: number }
          return HttpResponse.json({ ...uptimeSummary, text: body.text, revision: body.expectedRevision + 1 })
        }),
      )
      const board = { periods: ['2026-M09', '2026-M10'], ytd: ['2026-M10'] }
      const other = { periods: ['2026-M09'] }
      const company = { ...ref, subject: 'acme' }
      const elsewhere = { metric: 'epics_on_time', subject: 'acme', period: '2026-M10' }
      const september = { ...ref, period: '2026-M09' }
      const page = (summary: unknown) => ({ pages: [{ ...webhooksAttribution, summary }], pageParams: [{}] })
      client.setQueryData(['metric-summary', 'sc', 'uptime', '2026-M10', 'live'], uptimeSummary)
      client.setQueryData(['metric-summaries', 'sc', '2026-M10', { state: 'missing', full: false, revision: 0 }], { pages: [] })
      client.setQueryData(['metric-summary-counts', 'sc', '2026-M10'], { counts: {} })
      client.setQueryData(['attribution', 'sc', ref], page(uptimeCardSummary))
      client.setQueryData(['attribution', 'sc', company], page(uptimeCardSummary))
      client.setQueryData(['attribution', 'sc', elsewhere], page(null))
      client.setQueryData(['attribution', 'sc', september], page(null))
      client.setQueryData(['view', 'sc', req], {})
      client.setQueryData(['view', 'sc', board], {})
      client.setQueryData(['view', 'sc', other], {})
      client.setQueryData(['report', 'sc', '2026-M10', ''], {})
      client.setQueryData(['metric-summary-counts', 'sc', '2026-M09'], { counts: {} })

      const { result } = renderHook(() => usePutMetricSummary('sc'), { wrapper })
      result.current.mutate({ metric: 'uptime', period: '2026-M10', text: 'Saved.', links: [], expectedRevision: 1 })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(path).toBe('/v1/scorecards/sc/metric-summaries/uptime/2026-M10')
      const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
      expect(invalidated(['metric-summary', 'sc', 'uptime', '2026-M10', 'live'])).toBe(true)
      expect(invalidated(['metric-summaries', 'sc', '2026-M10', { state: 'missing', full: false, revision: 0 }])).toBe(true)
      expect(invalidated(['metric-summary-counts', 'sc', '2026-M10'])).toBe(true)
      expect(invalidated(['attribution', 'sc', ref])).toBe(true)
      expect(invalidated(['attribution', 'sc', company])).toBe(true)
      expect(invalidated(['view', 'sc', req])).toBe(true)
      expect(invalidated(['view', 'sc', board])).toBe(true)
      expect(invalidated(['report', 'sc', '2026-M10', ''])).toBe(true)
      expect(invalidated(['attribution', 'sc', elsewhere])).toBe(false)
      expect(invalidated(['attribution', 'sc', september])).toBe(false)
      expect(invalidated(['view', 'sc', other])).toBe(false)
      expect(invalidated(['metric-summary-counts', 'sc', '2026-M09'])).toBe(false)
      // Cards show the saved summary at once.
      const card = client.getQueryData<{ pages: { summary: { text: string; revision: number } }[] }>(['attribution', 'sc', ref])
      expect(card?.pages[0]?.summary).toMatchObject({ text: 'Saved.', revision: 2 })
    })

    it('useDeleteMetricSummary sends the revision and leaves a missing slot on the cards', async () => {
      const { client, wrapper } = setup()
      let url = ''
      server.use(
        http.delete(SUMMARY, ({ request }) => {
          url = request.url
          return new HttpResponse(null, { status: 204 })
        }),
      )
      client.setQueryData(['metric-summary-counts', 'sc', '2026-M10'], { counts: {} })
      client.setQueryData(['attribution', 'sc', ref], { pages: [{ ...webhooksAttribution, summary: uptimeCardSummary }], pageParams: [{}] })
      const { result } = renderHook(() => useDeleteMetricSummary('sc'), { wrapper })
      result.current.mutate({ metric: 'uptime', period: '2026-M10', expectedRevision: 3 })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(new URL(url).searchParams.get('expectedRevision')).toBe('3')
      expect(client.getQueryState(['metric-summary-counts', 'sc', '2026-M10'])?.isInvalidated).toBe(true)
      const card = client.getQueryData<{ pages: { summary: { state: string; text?: string; links: unknown[] } }[] }>(['attribution', 'sc', ref])
      expect(card?.pages[0]?.summary).toMatchObject({ state: 'missing', links: [], linksTotal: 0 })
      expect(card?.pages[0]?.summary.text).toBeUndefined()
    })

    it('useMetricSummary reads one summary, live or of a published revision, and idles without a metric', async () => {
      const { wrapper } = setup()
      const seen: string[] = []
      server.use(
        http.get(SUMMARY, ({ request }) => {
          seen.push(new URL(request.url).search)
          return HttpResponse.json(uptimeSummary)
        }),
      )
      const { result } = renderHook(
        () => ({
          live: useMetricSummary('sc', 'uptime', '2026-M10'),
          published: useMetricSummary('sc', 'uptime', '2026-M10', 2),
          none: useMetricSummary('sc', null, '2026-M10'),
        }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.live.isSuccess && result.current.published.isSuccess).toBe(true))
      expect(result.current.live.data?.links).toHaveLength(12)
      expect(seen.sort()).toEqual(['', '?revision=2'])
      expect(result.current.none.fetchStatus).toBe('idle')
    })

    it('useMetricSummaries pages a month; useMetricSummaryCounts asks for counts only and keeps them a minute', async () => {
      const { client, wrapper } = setup()
      const seen: URLSearchParams[] = []
      server.use(
        http.get(`${API}/v1/scorecards/sc/metric-summaries`, ({ request }) => {
          const q = new URL(request.url).searchParams
          seen.push(q)
          return HttpResponse.json({ period: '2026-M10', counts: { required: 5, missing: 3, stale: 1, written: 1, optional: 1 }, items: [] })
        }),
      )
      const { result } = renderHook(
        () => ({
          list: useMetricSummaries('sc', { period: '2026-M10', state: 'all', full: true, revision: 3 }),
          counts: useMetricSummaryCounts('sc', '2026-M10'),
        }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.list.isSuccess && result.current.counts.isSuccess).toBe(true))
      const counts = seen.find((q) => q.get('countsOnly') === 'true')
      const list = seen.find((q) => q.get('countsOnly') === null)
      expect(counts?.get('period')).toBe('2026-M10')
      expect(list?.get('state')).toBe('all')
      expect(list?.get('full')).toBe('true')
      expect(list?.get('revision')).toBe('3')
      expect(result.current.counts.data?.counts.missing).toBe(3)
      expect(result.current.list.data?.pages[0]?.counts.required).toBe(5)
      expect(client.getQueryCache().find({ queryKey: ['metric-summary-counts', 'sc', '2026-M10'] })?.isStale()).toBe(false)
    })

    it('useMetricSummaryDraft polls until SAM has written the draft', async () => {
      const { wrapper } = setup()
      let polls = 0
      server.use(
        http.get(`${SUMMARY}/draft/draft-1`, () => {
          polls++
          return HttpResponse.json({ id: 'draft-1', pending: false, text: 'Drafted.', createdAt: '2026-11-20T12:00:00Z', warnings: ['INC-9999'] })
        }),
      )
      const { result } = renderHook(() => useMetricSummaryDraft('sc'), { wrapper })
      result.current.mutate({ metric: 'uptime', period: '2026-M10' })
      await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 4000 })
      expect(polls).toBe(1)
      expect(result.current.data?.warnings).toEqual(['INC-9999'])
    })

    it('usePublishReport turns a 409 summaries_missing into PublishBlockedError with the list', async () => {
      const { wrapper } = setup()
      server.use(
        http.post(`${API}/v1/scorecards/sc/reports/2026-M10/publish`, () =>
          HttpResponse.json(
            { code: 'summaries_missing', message: '3 exec summaries are missing for Oct 2026.', missing: [deploymentMissing, epicsMissing, securityMissing], stale: 1 },
            { status: 409 },
          ),
        ),
      )
      const { result } = renderHook(() => usePublishReport('sc', '2026-M10'), { wrapper })
      result.current.mutate()
      await waitFor(() => expect(result.current.isError).toBe(true))
      const err = result.current.error
      expect(err).toBeInstanceOf(PublishBlockedError)
      const blocked = err as PublishBlockedError
      expect(blocked.status).toBe(409)
      expect(blocked.code).toBe('summaries_missing')
      expect(blocked.message).toBe('3 exec summaries are missing for Oct 2026.')
      expect(blocked.missing.map((m) => m.metricKey)).toEqual(['deployment_uptime', 'epics_on_time', 'security_training'])
      expect(blocked.stale).toBe(1)
    })

    it('usePublishReport leaves other 409s as they are', async () => {
      const { wrapper } = setup()
      server.use(
        http.post(`${API}/v1/scorecards/sc/reports/2026-M10/publish`, () =>
          HttpResponse.json({ error: { code: 'conflict', message: 'Already publishing.' } }, { status: 409 }),
        ),
      )
      const { result } = renderHook(() => usePublishReport('sc', '2026-M10'), { wrapper })
      result.current.mutate()
      await waitFor(() => expect(result.current.isError).toBe(true))
      expect(result.current.error).not.toBeInstanceOf(PublishBlockedError)
      expect(result.current.error?.message).toBe('Already publishing.')
    })

    it('useReportDocument no longer asks for RCAs', async () => {
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
      expect(seen.query?.has('rcas')).toBe(false)
      expect(seen.query?.get('standing')).toBe('true')
    })
  })
})
