import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { formatPeriod, parsePeriod, prev, type Period } from '../lib/period'
import { member } from './adminFixtures'
import { API } from './server'
import { buildView } from './viewFixtures'

type Schemas = components['schemas']
type ReportDocument = Schemas['ReportDocument']
type ReportMonth = Schemas['ReportMonth']
type ReportSummary = Schemas['ReportSummary']
type ScorecardView = Schemas['ScorecardView']
type Membership = Schemas['Membership']

// All data is synthetic.

/** The report's view: the month and the five before it, with year to date through the month. */
export function reportView(period = '2026-M10'): ScorecardView {
  const months: Period[] = [parsePeriod(period)!]
  for (let i = 0; i < 5; i++) months.unshift(prev(months[0]!))
  const q = new URLSearchParams()
  for (const m of months) q.append('periods', formatPeriod(m))
  q.append('ytd', period)
  return buildView(q)
}

export const REPORT_SUMMARY = 'Delivery held near goal; defect reporting resumes next month.'

/** A live company-scope report for 2026-M10 unless overridden. */
export function reportDocument(over: Partial<ReportDocument> = {}): ReportDocument {
  return {
    live: true,
    revision: 0,
    dataRevised: false,
    changes: [],
    summary: REPORT_SUMMARY,
    facts: ['not reported: Defect rate'],
    view: reportView(),
    generatedAt: '2026-11-02T15:00:00Z',
    summaryScope: 'company',
    ...over,
  }
}

/** 2026-M10 published by the test admin; earlier months live. */
export const publishedMonths: ReportMonth[] = [
  { period: '2026-M08', status: 'live', revision: 0 },
  { period: '2026-M09', status: 'live', revision: 0 },
  {
    period: '2026-M10',
    status: 'published',
    revision: 1,
    publishedAt: '2026-11-03T14:00:00Z',
    publishedBy: 'dev|admin',
  },
]

export const liveMonths: ReportMonth[] = publishedMonths.map((m) => ({ period: m.period, status: 'live', revision: 0 }))

export const reportMembers: Membership[] = [
  member('dev|admin', 'Test Admin', 'admin@example.test', 'admin'),
  member('dev|viewer', 'Test Viewer', 'viewer@example.test', 'viewer'),
]

export interface ReportHandlerOptions {
  /** The document to answer `GET .../reports/{period}` with. */
  document?: (url: URL) => ReportDocument
  months?: ReportMonth[]
  summary?: ReportSummary
  members?: Membership[]
  /** Records each request so tests can assert what was asked for. */
  seen?: { documents: URL[]; publishes: URL[]; summaryPuts: unknown[]; members: number }
}

/** MSW handlers for the report endpoints and the members list. */
export function reportHandlers(options: ReportHandlerOptions = {}) {
  const base = `${API}/v1/scorecards/sc-main/reports`
  return [
    http.get(base, () => HttpResponse.json({ months: options.months ?? liveMonths })),
    http.get(`${base}/:period`, ({ request }) => {
      const url = new URL(request.url)
      options.seen?.documents.push(url)
      return HttpResponse.json(options.document?.(url) ?? reportDocument())
    }),
    http.get(`${base}/:period/summary`, () =>
      HttpResponse.json(options.summary ?? { text: REPORT_SUMMARY, revision: 3 }),
    ),
    http.put(`${base}/:period/summary`, async ({ request }) => {
      const body = (await request.json()) as { text: string; expectedRevision: number }
      options.seen?.summaryPuts.push(body)
      return HttpResponse.json({ text: body.text, revision: body.expectedRevision + 1 })
    }),
    http.post(`${base}/:period/publish`, ({ request }) => {
      options.seen?.publishes.push(new URL(request.url))
      return HttpResponse.json({ revision: 1, unlocked: true })
    }),
    http.get(`${API}/v1/members`, () => {
      if (options.seen) options.seen.members++
      return HttpResponse.json({ members: options.members ?? reportMembers })
    }),
  ]
}

export function newSeen(): NonNullable<ReportHandlerOptions['seen']> {
  return { documents: [], publishes: [], summaryPuts: [], members: 0 }
}
