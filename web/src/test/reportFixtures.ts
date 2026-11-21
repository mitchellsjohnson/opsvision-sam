import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { coarseColumns } from '../features/scorecard/columns'
import { formatPeriod, parsePeriod, prev, type Period } from '../lib/period'
import { member } from './adminFixtures'
import { API, state } from './server'
import { addQuarterly, addServiceUptime, buildView, QUARTERLY_VALUES } from './viewFixtures'

type Schemas = components['schemas']
type ReportDocument = Schemas['ReportDocument']
type ReportMonth = Schemas['ReportMonth']
type ReportSummary = Schemas['ReportSummary']
type ScorecardView = Schemas['ScorecardView']
type Membership = Schemas['Membership']
type MetricSummary = Schemas['MetricSummary']
type MetricSummaryList = Schemas['MetricSummaryList']
type RcaLink = Schemas['RcaLink']

// All data is synthetic.

// ---- Exec summaries -----------------------------------------------------------

const link = (title: string, url: string): RcaLink => ({ title, url })

/** On-time delivery's 12 links, the first a postmortem. */
export const onTimeLinks: RcaLink[] = [
  link('Postmortem: release train slip', 'https://docs.example/postmortems/release-oct'),
  ...Array.from({ length: 11 }, (_, i) => link(`DEL-${101 + i}`, `https://tracker.example/browse/DEL-${101 + i}`)),
]

export const ON_TIME_TEXT = 'Two releases slipped a week behind a certificate change; both shipped by Oct 28.'

function exec(over: Partial<MetricSummary> & Pick<MetricSummary, 'metricKey' | 'metricName'>): MetricSummary {
  return {
    period: '2026-M10',
    requirement: 'required',
    state: 'missing',
    standing: { display: '', status: '', headline: '' },
    links: [],
    linksTotal: 0,
    stale: false,
    staleReasons: [],
    canEdit: true,
    ...over,
  }
}

/** On-time delivery: Yellow at 84.3%, written with 12 links and two evidence keys. */
export const onTimeWritten: MetricSummary = exec({
  metricKey: 'on_time_pct',
  metricName: 'On-time delivery',
  categoryId: 'delivery',
  requirementReason: 'Yellow',
  state: 'written',
  standing: { display: '84.3%', status: 'Y', headline: '15.7 pts short of 100% · 6 of 38 items missed' },
  text: ON_TIME_TEXT,
  links: onTimeLinks,
  linksTotal: onTimeLinks.length,
  authorName: 'Avery Admin',
  channel: 'web',
  updatedAt: '2026-11-02T10:00:00Z',
  revision: 2,
  evidence: [
    { key: 'DEL-101', title: 'Release train A', url: 'https://tracker.example/browse/DEL-101', pointsDisplay: '' },
    { key: 'DEL-104', title: 'Release train B', url: 'https://tracker.example/browse/DEL-104', pointsDisplay: '' },
  ],
})

/** The same metric with nothing written: required, so publishing is blocked. */
export const onTimeMissing: MetricSummary = exec({
  metricKey: 'on_time_pct',
  metricName: 'On-time delivery',
  categoryId: 'delivery',
  requirementReason: 'Yellow',
  standing: onTimeWritten.standing,
  evidence: onTimeWritten.evidence,
})

/** Service uptime: no company value; the worst service is Red. */
export const uptimeMissing: MetricSummary = exec({
  metricKey: 'svc_uptime',
  metricName: 'Service uptime',
  categoryId: 'delivery',
  requirementReason: '1 of 2 services below 100%',
  standing: { display: '99.20%', status: 'R', headline: '1 of 2 services below 100% · worst Web service 99.20%' },
})

/** Green below 100%: still required. */
export const trainingMissing: MetricSummary = exec({
  metricKey: 'security_training',
  metricName: 'Security training completion',
  categoryId: 'quality',
  requirementReason: 'Below 100% (94%)',
  standing: { display: '94%', status: 'G', headline: '6 pts short of 100%' },
})

/** Written, but its numbers moved since: allowed to publish, and flagged. */
export const spendStale: MetricSummary = exec({
  metricKey: 'spend_vs_plan',
  metricName: 'Spend vs plan',
  categoryId: 'quality',
  requirementReason: 'Above 100% (104%)',
  state: 'stale',
  stale: true,
  staleReasons: ['The value changed from 102% to 104%.'],
  standing: { display: '104%', status: 'G', headline: '4% over plan · $46k over' },
  text: 'Vendor renewals landed a month early.',
  authorName: 'Avery Admin',
  channel: 'mcp',
  updatedAt: '2026-10-30T09:00:00Z',
  revision: 1,
})

/** Defect rate is not measured in Oct: nothing is required. */
export const defectOptional: MetricSummary = exec({
  metricKey: 'defect_rate',
  metricName: 'Defect rate',
  categoryId: 'quality',
  requirement: 'optional',
  state: 'optional',
})

/** A month with every required summary written. */
export const writtenSummaries: MetricSummary[] = [onTimeWritten, defectOptional]

/** Oct 2026 with three required summaries missing (and one stale). */
export const missingSummaries: MetricSummary[] = [onTimeMissing, uptimeMissing, trainingMissing, spendStale, defectOptional]

const STATE_ORDER = ['missing', 'stale', 'written', 'optional']

/** The list as `listMetricSummaries` returns it: counts over every row, rows of one state, excerpts unless `full`. */
export function summaryListBody(items: MetricSummary[], q: URLSearchParams, frozen = false): MetricSummaryList {
  const rows = [...items].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))
  const count = (s: string) => rows.filter((r) => r.state === s).length
  const counts = {
    required: rows.filter((r) => r.requirement === 'required').length,
    missing: count('missing'),
    stale: count('stale'),
    written: count('written'),
    optional: count('optional'),
  }
  const wanted = q.get('state') ?? (frozen ? 'all' : 'missing')
  const full = q.get('full') === 'true'
  const shown =
    q.get('countsOnly') === 'true'
      ? []
      : rows
          .filter((r) => wanted === 'all' || r.state === wanted)
          .map((r) => ({
            ...r,
            canEdit: !frozen && state.role === 'admin',
            ...(full || r.text === undefined || [...r.text].length <= 60 ? {} : { text: `${[...r.text].slice(0, 60).join('').trimEnd()}…` }),
            links: full ? r.links : r.links.slice(0, 3),
          }))
  return { period: q.get('period') ?? '2026-M10', counts, items: shown }
}

export interface SummaryListOptions {
  /** The live rows; a function is read on every request. */
  summaries?: MetricSummary[] | (() => MetricSummary[])
  /** Frozen rows by published revision; a revision not listed answers with no rows (published before exec summaries). */
  revisions?: Record<number, MetricSummary[]>
  /** Each list request's URL. */
  seen?: URL[]
}

/** `GET /scorecards/{sc}/metric-summaries` over fixture rows. */
export function summaryListHandler(sc: string, options: SummaryListOptions = {}) {
  return http.get(`${API}/v1/scorecards/${sc}/metric-summaries`, ({ request }) => {
    const url = new URL(request.url)
    options.seen?.push(url)
    const revision = url.searchParams.get('revision')
    if (revision !== null) {
      return HttpResponse.json(summaryListBody(options.revisions?.[Number(revision)] ?? [], url.searchParams, true))
    }
    const live = typeof options.summaries === 'function' ? options.summaries() : (options.summaries ?? writtenSummaries)
    return HttpResponse.json(summaryListBody(live, url.searchParams))
  })
}

/** The 409 a publish gets while required summaries are missing. */
export function publishBlockedResponse(missing: MetricSummary[], stale = 0) {
  const n = missing.length
  return HttpResponse.json(
    {
      error: { code: 'summaries_missing', message: `${n} exec ${n === 1 ? 'summary is' : 'summaries are'} missing for Oct 2026.` },
      missing,
      stale,
    },
    { status: 409 },
  )
}

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
  /** Answers a publish instead of the default success, e.g. with `publishBlockedResponse`. */
  publish?: () => Response | undefined
  /** The month's exec summaries (live, and frozen by revision); every required one is written by default. */
  summaries?: SummaryListOptions['summaries']
  revisionSummaries?: SummaryListOptions['revisions']
  /** Records each request so tests can assert what was asked for. */
  seen?: { documents: URL[]; publishes: URL[]; summaryPuts: unknown[]; members: number; summaryLists?: URL[] }
}

/** MSW handlers for the report endpoints, the month's exec summaries and the members list. */
export function reportHandlers(options: ReportHandlerOptions = {}) {
  const base = `${API}/v1/scorecards/sc-main/reports`
  return [
    summaryListHandler('sc-main', { summaries: options.summaries, revisions: options.revisionSummaries, seen: options.seen?.summaryLists }),
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
      return options.publish?.() ?? HttpResponse.json({ revision: 1, unlocked: true })
    }),
    http.get(`${API}/v1/members`, () => {
      if (options.seen) options.seen.members++
      return HttpResponse.json({ members: options.members ?? reportMembers })
    }),
  ]
}

export function newSeen(): NonNullable<ReportHandlerOptions['seen']> {
  return { documents: [], publishes: [], summaryPuts: [], members: 0, summaryLists: [] }
}
