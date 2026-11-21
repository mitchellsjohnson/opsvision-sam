import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { components } from '../api/schema'
import { devUsers, meFor, orgUnits, scorecards } from './fixtures'
import {
  attributionByCell,
  attributionPages,
  companyUnits,
  summaryByMetric,
  summaryDraftDone,
  summaryDraftPending,
  summaryList,
  unwritten,
} from './rcaFixtures'

type MetricSummary = components['schemas']['MetricSummary']

export const API = 'http://127.0.0.1:8080'

/** The role the default /v1/me handler answers with; tests set it per case. */
export const state = { role: 'admin' as 'admin' | 'contributor' | 'viewer' }

/** A summary as the caller gets it: only admins may edit. */
function asCaller(s: MetricSummary): MetricSummary {
  return { ...s, canEdit: state.role === 'admin' }
}

const notFound = (message: string) => HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 })

/** `/v1/org/units` with a single company root (`acme`), for cards that name the company's summary. */
export const companyUnitsHandler = http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: companyUnits }))

/** The attribution and exec summary operations over `rcaFixtures`; tests override them per case. */
export const rcaHandlers = [
  http.get(`${API}/v1/scorecards/:sc/attribution`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const cursor = q.get('incidentsCursor') ?? q.get('recordsCursor')
    const found = cursor ? attributionPages[cursor] : attributionByCell[`${q.get('metric')}|${q.get('subject')}|${q.get('period')}`]
    if (!found) return notFound('No such cell.')
    return HttpResponse.json({ ...found, summary: found.summary ? asCaller(found.summary) : found.summary })
  }),
  http.get(`${API}/v1/scorecards/:sc/metric-summaries`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const period = q.get('period') ?? summaryList.period
    const items = q.get('countsOnly') === 'true' ? [] : summaryList.items.map(asCaller)
    return HttpResponse.json({ ...summaryList, period, items })
  }),
  http.get(`${API}/v1/scorecards/:sc/metric-summaries/:metric/:period`, ({ params }) => {
    const found = summaryByMetric[`${String(params.metric)}|${String(params.period)}`]
    return found ? HttpResponse.json(asCaller(found)) : notFound('No such metric.')
  }),
  http.put(`${API}/v1/scorecards/:sc/metric-summaries/:metric/:period`, async ({ params, request }) => {
    const body = (await request.json()) as components['schemas']['PutMetricSummaryRequest']
    const metric = String(params.metric)
    const period = String(params.period)
    const was = summaryByMetric[`${metric}|${period}`] ?? unwritten({ ...summaryList.items[0]!, metricKey: metric, metricName: metric, period })
    const saved: MetricSummary = {
      ...was,
      state: 'written',
      text: body.text,
      links: body.links,
      linksTotal: body.links.length,
      authorName: `Test ${state.role}`,
      channel: 'web',
      updatedAt: '2026-11-20T12:00:00Z',
      revision: body.expectedRevision + 1,
      stale: false,
      staleReasons: [],
      canEdit: true,
    }
    return HttpResponse.json(saved)
  }),
  http.delete(`${API}/v1/scorecards/:sc/metric-summaries/:metric/:period`, () => new HttpResponse(null, { status: 204 })),
  http.post(`${API}/v1/scorecards/:sc/metric-summaries/:metric/:period/draft`, () =>
    HttpResponse.json(summaryDraftPending, { status: 202 }),
  ),
  http.get(`${API}/v1/scorecards/:sc/metric-summaries/:metric/:period/draft/:id`, () => HttpResponse.json(summaryDraftDone)),
  // The Why card asks whether SAM is on before offering `Draft with SAM`.
  http.get(`${API}/v1/assistant/settings`, () => HttpResponse.json({ enabled: true, model: 'test-model' })),
]

export const handlers = [
  http.get(`${API}/dev/users`, () => HttpResponse.json(devUsers)),
  http.post(`${API}/dev/login`, async ({ request }) => {
    const body = (await request.json()) as { userId: string }
    return HttpResponse.json({ token: `token-for-${body.userId}` })
  }),
  http.get(`${API}/v1/me`, () => HttpResponse.json(meFor(state.role))),
  http.get(`${API}/v1/scorecards`, () => HttpResponse.json({ scorecards })),
  http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: orgUnits })),
  http.get(`${API}/v1/items`, () => HttpResponse.json({ items: [] })),
  http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ levels: [] })),
  http.get(`${API}/v1/me/preferences`, () => HttpResponse.json({ defaultScope: '' })),
  http.get(`${API}/v1/me/layouts/:sc`, () =>
    HttpResponse.json({ items: [], revision: 0, source: 'empty', defaultRevision: 0 }),
  ),
  http.put(`${API}/v1/me/layouts/:sc`, async ({ request }) => {
    const body = (await request.json()) as { items: unknown[]; expectedRevision: number }
    return HttpResponse.json({
      items: body.items,
      revision: body.expectedRevision + 1,
      source: 'user',
      defaultRevision: 0,
    })
  }),
  ...rcaHandlers,
]

export const server = setupServer(...handlers)
