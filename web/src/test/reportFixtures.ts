import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { coarseColumns } from '../features/scorecard/columns'
import { formatPeriod, parsePeriod, prev, type Period } from '../lib/period'
import { member } from './adminFixtures'
import { API } from './server'
import { addQuarterly, addServiceUptime, buildView, QUARTERLY_VALUES } from './viewFixtures'

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

/**
 * The report's view with Service uptime (item-only, no company value) and a
 * third service, Batch service, silent in Oct 2026: Web service is the worst,
 * at 99.20% Red, of 2 services reported.
 */
export function reportViewWithUptime(period = '2026-M10'): ScorecardView {
  const view = addServiceUptime(reportView(period))
  const web = view.rows.find((r) => r.metricKey === 'svc_uptime' && r.subjectId === 'svc-web')!
  view.rows.push({
    ...web,
    subjectId: 'svc-batch',
    subjectName: 'Batch service',
    cells: web.cells.map((c) => ({
      ...c,
      subjectId: 'svc-batch',
      ...(c.period === period && !c.ytd ? { value: null, display: '', status: '', coverage: [0, 1] } : {}),
    })),
  })
  return view
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

/** Concepts delivered expected value with Q3 FY2026 reported Yellow. */
export const QUARTERLY_Q3_YELLOW: typeof QUARTERLY_VALUES = {
  ...QUARTERLY_VALUES,
  '2026-Q3': { value: 70, display: '70%', status: 'Y' },
}

/**
 * The view a revision stores as `standing`, which the Overview counts from:
 * the 12 months ending at the period, its four quarters and year to date,
 * with the quarterly metric added and coarse cells kept only on its row.
 */
export function standingView(period = '2026-M10', values = QUARTERLY_Q3_YELLOW): ScorecardView {
  const months: Period[] = [parsePeriod(period)!]
  for (let i = 0; i < 11; i++) months.unshift(prev(months[0]!))
  const q = new URLSearchParams()
  for (const m of months) q.append('periods', formatPeriod(m))
  for (const c of coarseColumns(period, 'quarter', 4, 1)) q.append('periods', c.period)
  q.append('ytd', period)
  const view = addQuarterly(buildView(q), values)
  for (const row of view.rows) {
    if (row.frequency === 'monthly') row.cells = row.cells.filter((c) => c.ytd || parsePeriod(c.period)?.grain === 'month')
  }
  return view
}

/** A revision published with `standing` (v2): Concepts delivered expected value counts at Q3 FY2026, Yellow. */
export function publishedDocV2(over: Partial<ReportDocument> = {}): ReportDocument {
  return reportDocument({
    live: false,
    revision: 1,
    view: addQuarterly(reportView(), QUARTERLY_Q3_YELLOW),
    standing: standingView(),
    facts: ['not reported: Defect rate'],
    ...over,
  })
}

/**
 * A revision published before `standing` existed (v1): a quarterly metric
 * and a twice-yearly one (Platform review score), neither with a period it
 * can be counted in.
 */
export function publishedDocV1(over: Partial<ReportDocument> = {}): ReportDocument {
  const view = addQuarterly(reportView(), QUARTERLY_Q3_YELLOW)
  const quarterly = view.rows.find((r) => r.metricKey === 'concepts_value')!
  view.rows.push({
    ...quarterly,
    metricKey: 'platform_review',
    metricName: 'Platform review score',
    frequency: 'biannual',
    cells: quarterly.cells.map((c) => ({ ...c, metricKey: 'platform_review' })),
  })
  return reportDocument({
    live: false,
    revision: 1,
    view,
    facts: ['not reported: Concepts delivered expected value, Defect rate, Platform review score'],
    ...over,
  })
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
  /** The stored summary, or a function answering each GET (a Response for a failure). */
  summary?: ReportSummary | (() => ReportSummary | Response)
  /** Answers a summary PUT instead of the default success, e.g. with a 409. */
  putSummary?: (body: { text: string; expectedRevision: number }) => Response | undefined
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
    http.get(`${base}/:period/summary`, () => {
      const out = typeof options.summary === 'function' ? options.summary() : options.summary
      if (out instanceof Response) return out
      return HttpResponse.json(out ?? { text: REPORT_SUMMARY, revision: 3 })
    }),
    http.put(`${base}/:period/summary`, async ({ request }) => {
      const body = (await request.json()) as { text: string; expectedRevision: number }
      options.seen?.summaryPuts.push(body)
      return options.putSummary?.(body) ?? HttpResponse.json({ text: body.text, revision: body.expectedRevision + 1 })
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
