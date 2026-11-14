import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { API } from './server'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type ScorecardView = Schemas['ScorecardView']
type MethodologyVersion = Schemas['MethodologyVersion']
type Override = Schemas['Override']
type ContributionMeasure = Schemas['ContributionMeasure']
type RecordContribution = Schemas['RecordContribution']
type RecordContributions = Schemas['RecordContributions']

// All data is synthetic.

export const categories = [
  { id: 'delivery', name: 'Delivery', order: 1 },
  { id: 'quality', name: 'Quality', order: 2 },
]

export const versions: MethodologyVersion[] = [
  {
    id: 'ver-2',
    scorecardId: 'sc-main',
    name: 'FY27 proposal',
    status: 'draft',
    effectiveFrom: '',
    revision: 1,
    content: {
      categories,
      measures: [
        { key: 'closed', name: 'Closed items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
        { key: 'total', name: 'Total items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
      ],
      metrics: [],
    },
  },
  {
    id: 'ver-1',
    scorecardId: 'sc-main',
    name: 'FY26 published',
    status: 'published',
    effectiveFrom: '2026-M01',
    revision: 3,
    content: {
      categories,
      measures: [
        { key: 'closed', name: 'Closed items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
        { key: 'total', name: 'Total items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
        { key: 'defects', name: 'Defects', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
      ],
      metrics: [
        {
          key: 'on_time_pct',
          name: 'On-time delivery',
          categoryId: 'delivery',
          formula: 'closed / total * 100',
          format: 'percent1',
          direction: 'higher_better',
          frequency: 'monthly',
          reportedAt: [],
          rollItemsToOrg: false,
          rule: { type: 'bands', bands: [] },
          targets: [],
          definition: '',
          notes: '',
          example: '',
          source: '',
          link: '',
        },
        {
          key: 'defect_rate',
          name: 'Defect rate',
          categoryId: 'quality',
          formula: 'defects',
          format: 'number1',
          direction: 'lower_better',
          frequency: 'monthly',
          reportedAt: [],
          rollItemsToOrg: false,
          rule: { type: 'change', compare: 'prior_period' },
          targets: [],
          definition: '',
          notes: '',
          example: '',
          source: '',
          link: '',
        },
      ],
    },
  },
]

export const override: Override = {
  metricKey: 'defect_rate',
  subjectId: 'root',
  period: '2026-M08',
  value: null,
  status: 'R',
  reason: 'Audit finding',
  by: 'admin@example.test',
  at: '2026-10-05T12:00:00Z',
}

const blank = {
  value: null,
  display: '',
  status: '',
  naReason: '',
  components: {},
  coverage: [0, 1],
  change: null,
  changeKind: '',
  target: null,
  versionId: 'ver-1',
}

function cell(metricKey: string, subjectId: string, period: string, ytd: boolean): Cell {
  const identity = { metricKey, subjectId, period, ytd }
  if (metricKey === 'on_time_pct') {
    if (subjectId === 'root' && period === '2026-M10' && !ytd) {
      return {
        ...identity,
        value: 84.3,
        display: '84.3%',
        status: 'Y',
        naReason: '',
        components: { closed: 440, total: 522 },
        coverage: [3, 3],
        change: 2.1,
        changeKind: 'delta',
        target: 90,
        versionId: 'ver-1',
      }
    }
    if (subjectId === 'unit-a' && period === '2026-M10' && !ytd) {
      return { ...identity, ...blank, value: 70, display: '70.0%', status: 'R', components: { closed: 7, total: 10 }, coverage: [1, 1] }
    }
    if (subjectId === 'unit-b' && period === '2026-M10' && !ytd) {
      // Records so far this month run through Oct 14.
      return { ...identity, ...blank, value: 95, display: '95.0%', status: 'G', components: { closed: 95, total: 100 }, coverage: [1, 1], cutoff: '2026-10-14' }
    }
    return { ...identity, ...blank, value: 95, display: '95.0%', status: 'G', components: { closed: 95, total: 100 }, coverage: [1, 1] }
  }
  // defect_rate: lower is better, judged by change.
  if (subjectId === 'root' && !ytd) {
    if (period === '2026-M10') {
      return { ...identity, ...blank, naReason: 'Not measured this month' }
    }
    if (period === '2026-M09') return { ...identity, ...blank }
    if (period === '2026-M08') {
      return {
        ...identity,
        ...blank,
        value: 4,
        display: '4.0',
        status: 'R',
        components: { defects: 4 },
        coverage: [1, 1],
        change: -17,
        changeKind: 'improvement_pct',
        override: { ...override },
        computed: { value: 4, status: 'G' },
      }
    }
  }
  return {
    ...identity,
    ...blank,
    value: 2,
    display: '2.0',
    status: 'G',
    components: { defects: 2 },
    coverage: [1, 1],
    change: 12,
    changeKind: 'improvement_pct',
  }
}

const SUBJECTS: Record<string, { id: string; name: string; depth: number }[]> = {
  on_time_pct: [
    { id: 'root', name: 'All units', depth: 0 },
    { id: 'unit-a', name: 'Unit A', depth: 1 },
    { id: 'team-a1', name: 'Team A1', depth: 2 },
    { id: 'unit-b', name: 'Unit B', depth: 1 },
  ],
  defect_rate: [{ id: 'root', name: 'All units', depth: 0 }],
}

const METRICS = [
  {
    key: 'on_time_pct',
    name: 'On-time delivery',
    categoryId: 'delivery',
    format: 'percent1',
    direction: 'higher_better',
    frequency: 'monthly' as const,
    chartKind: 'ratio',
  },
  {
    key: 'defect_rate',
    name: 'Defect rate',
    categoryId: 'quality',
    format: 'number1',
    direction: 'lower_better',
    frequency: 'monthly' as const,
    chartKind: 'change',
  },
] as const

/** Builds the view the API would return for a request, honoring `subjects`. */
export function buildView(query: URLSearchParams): ScorecardView {
  const periods = query.getAll('periods')
  const ytd = query.getAll('ytd')
  const subjects = query.getAll('subjects')
  const rows: ViewRow[] = []
  for (const m of METRICS) {
    for (const s of SUBJECTS[m.key] ?? []) {
      if (subjects.length > 0 && !subjects.includes(s.id)) continue
      rows.push({
        metricKey: m.key,
        metricName: m.name,
        categoryId: m.categoryId,
        subjectId: s.id,
        subjectName: s.name,
        subjectKind: 'unit',
        format: m.format,
        depth: s.depth,
        direction: m.direction,
        frequency: m.frequency,
        chartKind: m.chartKind,
        definition: '',
        cells: [
          ...periods.map((p) => cell(m.key, s.id, p, false)),
          ...ytd.map((p) => cell(m.key, s.id, p, true)),
        ],
      })
    }
  }
  const versionByPeriod: Record<string, string> = {}
  for (const p of periods) versionByPeriod[p] = 'ver-1'
  for (const p of ytd) versionByPeriod[`YTD:${p}`] = 'ver-1'
  return { periods, ytd, categories, rows, versionByPeriod }
}

/** Services in the item-only uptime metric: one unattached, one under Unit A. */
export const UPTIME_SERVICES = [
  { id: 'svc-api', name: 'API service', depth: 0, oct: { value: 99.95, display: '99.95%', status: 'G' } },
  { id: 'svc-web', name: 'Web service', depth: 2, oct: { value: 99.2, display: '99.20%', status: 'R' } },
] as const

/** The services as tracked items: Web service sits in Team A1, under Unit A; API service is unattached. */
export const UPTIME_ITEMS: Schemas['TrackedItem'][] = [
  { id: 'svc-api', kindId: 'service', name: 'API service', orgUnitId: '', sourceKeys: [] },
  { id: 'svc-web', kindId: 'service', name: 'Web service', orgUnitId: 'team-a1', sourceKeys: [] },
]

/**
 * Appends `svc_uptime`, a metric reported only for tracked items (no org-unit
 * row), to a view built by `buildView`. Each service is 99.90% / G except in
 * 2026-M10, where it has the `oct` values above. With `subjects`, only the
 * services listed, as the API does.
 */
export function addServiceUptime(view: ScorecardView, subjects: string[] = []): ScorecardView {
  for (const s of UPTIME_SERVICES) {
    if (subjects.length > 0 && !subjects.includes(s.id)) continue
    const cellFor = (period: string, ytd: boolean): Cell => {
      const values = period === '2026-M10' && !ytd ? s.oct : { value: 99.9, display: '99.90%', status: 'G' }
      return { metricKey: 'svc_uptime', subjectId: s.id, period, ytd, ...blank, ...values, coverage: [1, 1] }
    }
    view.rows.push({
      metricKey: 'svc_uptime',
      metricName: 'Service uptime',
      categoryId: 'delivery',
      subjectId: s.id,
      subjectName: s.name,
      subjectKind: 'item',
      format: 'percent2',
      depth: s.depth,
      direction: 'higher_better',
      frequency: 'monthly',
      chartKind: 'uptime',
      definition: '',
      cells: [...view.periods.map((p) => cellFor(p, false)), ...view.ytd.map((p) => cellFor(p, true))],
    })
  }
  return view
}

export interface ViewHandlerOptions {
  /** Called with the URL of each view request. */
  onView?: (url: URL) => void
  /** Overrides the default view response. */
  respond?: (url: URL) => Response | undefined
}

const DERIVE: Record<string, Schemas['DeriveRule']> = {
  closed: { recordType: 'epic', op: 'commitments', outcome: 'met' },
  total: { recordType: 'epic', op: 'commitments', outcome: 'resolved' },
  defects: {
    recordType: 'defect',
    op: 'daily_open_weighted',
    weights: { P1: 64, P2: 16, P3: 4, P4: 2, none: 1 },
  },
}

/** The versions with ver-1's measures derived from records: on-time and resolved epics, weighted open defects. */
export const derivedVersions: MethodologyVersion[] = versions.map((v) =>
  v.id !== 'ver-1'
    ? v
    : {
        ...v,
        content: {
          ...v.content,
          measures: v.content.measures.map((m) => ({ ...m, source: 'derived' as const, derive: DERIVE[m.key] })),
        },
      },
)

/** One record's part in a derived value; an on-time Checkout epic unless overridden. */
export function contribution(over: Partial<RecordContribution> = {}): RecordContribution {
  return {
    source: 'tracker',
    externalId: 'CHK-101',
    title: 'Saved cards at checkout',
    url: 'https://tracker.example.test/browse/CHK-101',
    priority: 'none',
    state: 'done',
    amount: 1,
    reason: 'met',
    dates: { dueAt: '2026-10-20', completedAt: '2026-10-18' },
    subjectId: 'root',
    ...over,
  }
}

/** One derived measure of a cell, computed from records alone unless overridden; `total` defaults to the records given. */
export function contributionMeasure(over: Partial<ContributionMeasure> = {}): ContributionMeasure {
  const records = over.records ?? [contribution()]
  return {
    measureKey: 'closed',
    value: null,
    source: '',
    recordsValue: 1,
    cutoff: '2026-10-31',
    pending: 0,
    total: records.length,
    covered: true,
    ...over,
    records,
  }
}

/**
 * Handlers for the records behind a cell: ver-1 with derived measures, and
 * the contributions `respond` returns for each request (by URL).
 */
export function contributionHandlers(
  respond: (url: URL) => RecordContributions | Response | Promise<RecordContributions | Response>,
) {
  return [
    http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions: derivedVersions })),
    http.get(`${API}/v1/scorecards/sc-main/records/contributions`, async ({ request }) => {
      const out = await respond(new URL(request.url))
      return out instanceof Response ? out : HttpResponse.json(out)
    }),
  ]
}

/** MSW handlers for the scorecard view, versions and history endpoints. */
export function viewHandlers(options: ViewHandlerOptions = {}) {
  return [
    http.get(`${API}/v1/scorecards/sc-main/view`, ({ request }) => {
      const url = new URL(request.url)
      options.onView?.(url)
      return options.respond?.(url) ?? HttpResponse.json(buildView(url.searchParams))
    }),
    http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions })),
    http.get(`${API}/v1/scorecards/sc-main/history`, ({ request }) => {
      const q = new URL(request.url).searchParams
      const measure = q.get('measure') ?? ''
      const base = {
        measureKey: measure,
        subjectId: q.get('subject') ?? '',
        period: q.get('period') ?? '',
        naReason: '',
        source: 'grid' as const,
      }
      const value = measure === 'closed' ? 440 : measure === 'total' ? 522 : 4
      return HttpResponse.json({
        history: [
          { ...base, value, enteredBy: 'pm@example.test', enteredAt: '2026-10-03T09:15:00Z', revision: 2 },
          { ...base, value: value - 5, enteredBy: 'analyst@example.test', enteredAt: '2026-10-01T08:00:00Z', revision: 1 },
        ],
      })
    }),
  ]
}
