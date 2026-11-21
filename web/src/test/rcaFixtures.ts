import type { components } from '../api/schema'

type CellAttribution = components['schemas']['CellAttribution']
type MetricSummary = components['schemas']['MetricSummary']
type MetricSummaryList = components['schemas']['MetricSummaryList']
type MetricSummaryDraft = components['schemas']['MetricSummaryDraft']
type OrgUnit = components['schemas']['OrgUnit']
type RcaIncident = components['schemas']['RcaIncident']
type RcaLink = components['schemas']['RcaLink']
type RcaRecord = components['schemas']['RcaRecord']

// All fixtures are synthetic; they mirror the demo seed's Oct 2026 cells (spec §14).

/** The company root unit: exec summaries belong to its cells. */
export const COMPANY = 'acme'

/** Org units with a single company root, for cards that tell the company cell from a child's. */
export const companyUnits: OrgUnit[] = [
  { id: COMPANY, name: 'Acme Demo', levelId: 'company', parentId: '', sourceKeys: [] },
  { id: 'checkout', name: 'Checkout', levelId: 'product', parentId: COMPANY, sourceKeys: [] },
  { id: 'billing', name: 'Billing', levelId: 'product', parentId: COMPANY, sourceKeys: [] },
  { id: 'mobile', name: 'Mobile', levelId: 'segment', parentId: COMPANY, sourceKeys: [] },
]

function summary(over: Partial<MetricSummary> & Pick<MetricSummary, 'metricKey' | 'metricName'>): MetricSummary {
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

/** The slot of a summary that is not written: no text, author or links. */
export function unwritten(s: MetricSummary, state: 'missing' | 'optional' = 'missing'): MetricSummary {
  return {
    metricKey: s.metricKey,
    metricName: s.metricName,
    categoryId: s.categoryId,
    period: s.period,
    requirement: state === 'missing' ? 'required' : 'optional',
    requirementReason: state === 'missing' ? s.requirementReason : undefined,
    state,
    standing: s.standing,
    links: [],
    linksTotal: 0,
    stale: false,
    staleReasons: [],
    canEdit: s.canEdit,
  }
}

const link = (title: string, url: string): RcaLink => ({ title, url })

/** The company Uptime summary's 12 links, as `getMetricSummary` returns them. */
export const uptimeLinks: RcaLink[] = [
  link('Postmortem: webhook queue saturation', 'https://docs.example/postmortems/webhooks-oct'),
  link('INC-2041', 'https://tracker.example/browse/INC-2041'),
  link('INC-2047', 'https://tracker.example/browse/INC-2047'),
  link('INC-2049', 'https://tracker.example/browse/INC-2049'),
  link('INC-2052', 'https://tracker.example/browse/INC-2052'),
  link('88412', 'https://oncall.example/incidents/88412'),
  link('Status page incident', 'https://status.example/incidents/7h1q'),
  link('Capacity plan for the delivery queue', 'https://docs.example/plans/queue-capacity'),
  link('DNS provider notice', 'https://status.example/incidents/7f3k'),
  link('Retry worker fix', 'https://tracker.example/browse/INC-2048'),
  link('Ingest rebalance runbook', 'https://docs.example/runbooks/ingest-rebalance'),
  link('Search failover review', 'https://docs.example/reviews/search-failover'),
]

export const uptimeText =
  'Webhooks lost 7h to a queue saturation after the 3 Oct deploy (INC-2041) and an overlapping crash loop and DNS fault on 17 Oct; Analytics Ingest and Search had short incidents. 40m on Webhooks has no incident.'

/** The company Uptime exec summary for Oct 2026, whole (`getMetricSummary`). */
export const uptimeSummary: MetricSummary = summary({
  metricKey: 'uptime',
  metricName: 'Uptime',
  categoryId: 'reliability',
  requirementReason: '13 of 21 services below 100%',
  state: 'written',
  standing: { display: '99.06%', status: 'R', headline: '13 of 21 services below 100% · worst Webhooks 99.06%' },
  text: uptimeText,
  links: uptimeLinks,
  linksTotal: uptimeLinks.length,
  authorName: 'Avery Admin',
  channel: 'web',
  updatedAt: '2026-11-02T10:00:00Z',
  revision: 1,
})

/** The same summary as cards carry it: an excerpt and the first 3 links. */
export const uptimeCardSummary: MetricSummary = {
  ...uptimeSummary,
  text: 'Webhooks lost 7h to a queue saturation after the 3 Oct deplo…',
  links: uptimeLinks.slice(0, 3),
}

/** Deployment uptime: Red, required, not written. */
export const deploymentMissing: MetricSummary = summary({
  metricKey: 'deployment_uptime',
  metricName: 'Deployment uptime',
  categoryId: 'reliability',
  requirementReason: 'Red',
  standing: { display: '99.63%', status: 'R', headline: '1 of 6 deployments below 100% · worst Notification Relay - Multi-Region Active 98.66%' },
})

/** Epics delivered on time: Yellow at the company, required, not written. */
export const epicsMissing: MetricSummary = summary({
  metricKey: 'epics_on_time',
  metricName: 'Epics delivered on time',
  categoryId: 'delivery',
  requirementReason: 'Yellow',
  standing: { display: '84%', status: 'Y', headline: '16 pts short of 100% · 14 of 88 epics missed' },
})

/** Security training: Green at 94%, so required though Green. */
export const securityMissing: MetricSummary = summary({
  metricKey: 'security_training',
  metricName: 'Security training completion',
  categoryId: 'people',
  requirementReason: 'Below 100% (94%)',
  standing: { display: '94%', status: 'G', headline: '6 pts short of 100%' },
})

/** Spend vs plan: written through MCP, now stale. */
export const spendStale: MetricSummary = summary({
  metricKey: 'spend_vs_plan',
  metricName: 'Spend vs plan',
  categoryId: 'finance',
  requirementReason: 'Above 100% (104%)',
  state: 'stale',
  standing: { display: '104%', status: 'G', headline: '4% over plan · $46k over' },
  text: 'Checkout pulled the tax adapter forward; its spend lands a month early. Other products are on plan.',
  links: [],
  linksTotal: 0,
  authorName: 'Avery Admin',
  channel: 'mcp',
  updatedAt: '2026-10-30T09:00:00Z',
  revision: 2,
  stale: true,
  staleReasons: ['The value changed from 102% to 104%.', '1 more product is over plan: Billing.'],
})

/** A perfect metric: not required and not written. */
export const conceptsOptional: MetricSummary = summary({
  metricKey: 'postmortems_on_time',
  metricName: 'Incident postmortems on time',
  categoryId: 'reliability',
  requirement: 'optional',
  state: 'optional',
  standing: { display: '100%', status: 'G', headline: '' },
})

/** Hostile written text and links (Review Focus 4): HTML, Markdown, a punycode host, http and script URLs. */
export const hostileSummary: MetricSummary = {
  ...uptimeSummary,
  text: '<b>bold</b> and **not markdown**',
  links: [
    link('Runbook', 'https://xn--bcher-kva.example/runbook'),
    link('Old wiki', 'http://wiki.example/page'),
    link('<img src=x onerror=alert(1)>', 'https://docs.example/pm/2041'),
  ],
  linksTotal: 3,
}

function incident(over: Partial<RcaIncident> & Pick<RcaIncident, 'externalId' | 'title'>): RcaIncident {
  return {
    source: 'incident-tracker',
    key: over.externalId,
    url: `https://tracker.example/browse/${over.externalId}`,
    severity: 'SEV2',
    state: 'done',
    countedMinutes: 0,
    countedDisplay: '0m',
    pointsDisplay: '',
    notes: [],
    subjectIds: ['webhooks'],
    ...over,
  }
}

function base(over: Partial<CellAttribution> & Pick<CellAttribution, 'metricKey' | 'subjectId' | 'subjectName'>): CellAttribution {
  return {
    period: '2026-M10',
    display: '',
    status: '',
    attribution: 'available',
    gap: { kind: 'none', headline: '', detail: '' },
    incidents: [],
    incidentsTotal: 0,
    unexplained: null,
    excess: null,
    records: [],
    recordsTotal: 0,
    children: [],
    childrenTotal: 0,
    override: null,
    summary: uptimeCardSummary,
    ...over,
  }
}

const downtime = (units: number, headline: string, detail: string, reportedMinutes: number): CellAttribution['gap'] => ({
  kind: 'downtime',
  ideal: 100,
  units,
  decimals: 2,
  headline,
  detail,
  periodMinutes: 44640,
  reportedMinutes,
  reportedFrom: 'measure',
})

/** Webhooks uptime, Oct 2026: 420 minutes reported, three incidents and a remainder. */
export const webhooksAttribution: CellAttribution = base({
  metricKey: 'uptime',
  subjectId: 'webhooks',
  subjectName: 'Webhooks',
  display: '99.06%',
  status: 'R',
  gap: downtime(94, '0.94 pts short of 100% · 7h 00m down', 'Red · Green at 99.90% or better', 420),
  incidents: [
    incident({
      externalId: 'INC-2041',
      title: 'Webhook delivery queue saturated after config deploy',
      startedAt: '2026-10-03T14:05:00Z',
      endedAt: '2026-10-03T18:15:00Z',
      countedMinutes: 250,
      countedDisplay: '4h 10m',
      pointsDisplay: '0.56 pts',
      notes: ['Same window as sp-7h1q (Status page)'],
    }),
    incident({
      externalId: 'INC-2047',
      title: 'Retry worker crash loop',
      severity: 'SEV3',
      startedAt: '2026-10-17T09:40:00Z',
      endedAt: '2026-10-17T11:45:00Z',
      countedMinutes: 112.5,
      countedDisplay: '1h 53m',
      pointsDisplay: '0.25 pts',
      notes: ['Overlaps INC-2049 for 25m'],
    }),
    incident({
      externalId: 'INC-2049@Webhooks',
      key: 'INC-2049',
      url: 'https://tracker.example/browse/INC-2049',
      title: 'Regional DNS resolution failures',
      startedAt: '2026-10-17T11:20:00Z',
      endedAt: '2026-10-17T11:50:00Z',
      countedMinutes: 17.5,
      countedDisplay: '17m',
      pointsDisplay: '0.04 pts',
      notes: ['Overlaps INC-2047 for 25m'],
    }),
  ],
  incidentsTotal: 3,
  unexplained: { minutes: 40, display: '0.09 pts · 40m of the 7h 00m reported', withinTolerance: false },
})

/** Analytics Ingest uptime: incidents explain more than the reported downtime. */
export const ingestAttribution: CellAttribution = base({
  metricKey: 'uptime',
  subjectId: 'analytics-ingest',
  subjectName: 'Analytics Ingest',
  display: '99.83%',
  status: 'Y',
  gap: downtime(17, '0.17 pts short of 100% · 1h 15m down', 'Yellow · Green at 99.90% or better', 75),
  incidents: [
    incident({
      externalId: 'INC-2052',
      title: 'Ingest lag from partition rebalance',
      severity: 'SEV3',
      startedAt: '2026-10-22T02:10:00Z',
      endedAt: '2026-10-22T03:40:00Z',
      countedMinutes: 90,
      countedDisplay: '1h 30m',
      pointsDisplay: '0.20 pts',
      subjectIds: ['analytics-ingest'],
    }),
  ],
  incidentsTotal: 1,
  excess: { minutes: 15, display: '0.20 pts · 15m more than the 1h 15m reported', withinTolerance: false },
})

/** A relay whose incidents leave 5 of 600 minutes unexplained: within tolerance, still shown. */
export const relayAttribution: CellAttribution = base({
  metricKey: 'deployment_uptime',
  subjectId: 'notification-relay',
  subjectName: 'Notification Relay - Multi-Region Active',
  display: '98.66%',
  status: 'R',
  gap: downtime(134, '1.34 pts short of 100% · 10h 00m down', 'Red · Green at 99.90% or better', 600),
  incidents: [
    incident({
      externalId: 'INC-2060',
      title: 'Relay failover stalled across regions',
      startedAt: '2026-09-30T23:10:00Z',
      endedAt: '2026-10-01T09:05:00Z',
      countedMinutes: 545,
      countedDisplay: '9h 05m',
      pointsDisplay: '1.22 pts',
      notes: ['Started Sep 30, 23:10 · 9h 05m of 9h 55m fell in Oct'],
      subjectIds: ['notification-relay'],
    }),
    incident({
      externalId: 'INC-2063',
      title: 'Partial delivery loss in one region',
      severity: 'SEV3',
      startedAt: '2026-10-12T07:00:00Z',
      endedAt: '2026-10-12T09:05:00Z',
      countedMinutes: 50,
      countedDisplay: '50m',
      pointsDisplay: '0.11 pts',
      notes: ['40% impact · counts 50m of 2h 05m'],
      subjectIds: ['notification-relay'],
    }),
  ],
  incidentsTotal: 2,
  unexplained: { minutes: 5, display: '0.01 pts · 5m of the 10h 00m reported', withinTolerance: true },
  summary: deploymentMissing,
})

/** Event Bus uptime: 37 incidents of 10m each and 30m unexplained; the first page has 5. */
export const busIncidents: RcaIncident[] = Array.from({ length: 37 }, (_, i) =>
  incident({
    externalId: `INC-${3001 + i}`,
    title: `Event bus partition stall ${i + 1}`,
    severity: 'SEV3',
    startedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T06:00:00Z`,
    endedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T06:10:00Z`,
    countedMinutes: 10,
    countedDisplay: '10m',
    pointsDisplay: '0.02 pts',
    subjectIds: ['event-bus'],
  }),
)

export const busAttribution: CellAttribution = base({
  metricKey: 'uptime',
  subjectId: 'event-bus',
  subjectName: 'Event Bus',
  display: '99.10%',
  status: 'R',
  gap: downtime(90, '0.90 pts short of 100% · 6h 40m down', 'Red · Green at 99.90% or better', 400),
  incidents: busIncidents.slice(0, 5),
  incidentsTotal: 37,
  incidentsCursor: 'bus-p2',
  unexplained: { minutes: 30, display: '0.07 pts · 30m of the 6h 40m reported', withinTolerance: false },
})

/** Further attribution pages by cursor: the server's pages of 50. */
export const attributionPages: Record<string, CellAttribution> = {
  'bus-p2': { ...busAttribution, incidents: busIncidents.slice(5), incidentsCursor: undefined },
}

function record(externalId: string, title: string, priority: string, note: string): RcaRecord {
  return {
    contribution: {
      source: 'delivery-tracker',
      externalId,
      title,
      url: `https://tracker.example/browse/${externalId}`,
      priority,
      state: 'open',
      amount: 1,
      reason: 'missed',
      dates: {},
      subjectId: 'checkout',
    },
    note,
  }
}

/** Checkout epics on time: 3 of 11 missed. Ratio rows carry no points. */
export const epicsAttribution: CellAttribution = base({
  metricKey: 'epics_on_time',
  subjectId: 'checkout',
  subjectName: 'Checkout',
  display: '73%',
  status: 'R',
  gap: {
    kind: 'ratio',
    ideal: 100,
    units: 27,
    decimals: 0,
    headline: '27 pts short of 100% · 3 of 11 epics missed',
    detail: 'Red · Green at 90% or better · each miss costs 9.1 pts',
  },
  records: [
    record('CHK-226', 'Saved cards migration', 'P2', 'Slipped Oct 15 → Nov 12'),
    record('CHK-233', 'Tax engine adapter', 'P2', 'Slipped Oct 31 → Dec 5'),
    record('CHK-238', 'Refund webhook v2', 'P3', 'Missed Oct 28 · still open'),
  ],
  recordsTotal: 3,
  recordsSummary: '3 of 11 epics missed',
  summary: epicsMissing,
})

/** The company roll-up of epics on time: the worst three products, each with its attribution line. */
export const epicsCompanyAttribution: CellAttribution = base({
  metricKey: 'epics_on_time',
  subjectId: COMPANY,
  subjectName: 'Acme Demo',
  display: '84%',
  status: 'Y',
  gap: {
    kind: 'ratio',
    ideal: 100,
    units: 16,
    decimals: 0,
    headline: '16 pts short of 100% · 14 of 88 epics missed',
    detail: 'Yellow · Green at 90% or better · each miss costs 1.1 pts',
  },
  children: [
    { subjectId: 'checkout', subjectName: 'Checkout', display: '73%', status: 'R', impactDisplay: '3 missed', attributionLine: '3 of 11 epics missed · CHK-226 + 2 more' },
    { subjectId: 'billing', subjectName: 'Billing', display: '82%', status: 'Y', impactDisplay: '2 missed', attributionLine: '2 of 11 epics missed · BIL-231 + 1 more' },
    { subjectId: 'identity', subjectName: 'Identity', display: '86%', status: 'Y', impactDisplay: '2 missed', attributionLine: '' },
  ],
  childrenTotal: 8,
  summary: epicsMissing,
})

/** The company Uptime cell: no company value; the worst services and their attribution lines. */
export const uptimeCompanyAttribution: CellAttribution = base({
  metricKey: 'uptime',
  subjectId: COMPANY,
  subjectName: 'Acme Demo',
  display: '99.06%',
  status: 'R',
  gap: { kind: 'downtime', ideal: 100, headline: '13 of 21 services below 100% · worst Webhooks 99.06%', detail: 'Red · Green at 99.90% or better' },
  children: [
    { subjectId: 'webhooks', subjectName: 'Webhooks', display: '99.06%', status: 'R', impactDisplay: '0.94 pts', attributionLine: 'INC-2041 + 2 more · 0.09 pts not explained' },
    { subjectId: 'analytics-ingest', subjectName: 'Analytics Ingest', display: '99.83%', status: 'Y', impactDisplay: '0.17 pts', attributionLine: 'INC-2052 · 15m more than reported' },
    { subjectId: 'search', subjectName: 'Search', display: '99.87%', status: 'Y', impactDisplay: '0.13 pts', attributionLine: 'INC-2049 · 0.06 pts not explained' },
  ],
  childrenTotal: 13,
})

/** Spend vs plan at the company: its summary is stale. */
export const spendCompanyAttribution: CellAttribution = base({
  metricKey: 'spend_vs_plan',
  subjectId: COMPANY,
  subjectName: 'Acme Demo',
  display: '104%',
  status: 'G',
  gap: { kind: 'plan', ideal: 100, headline: '4% over plan · $46k over', detail: 'Green · Under plan is fine · Yellow above 110%' },
  summary: spendStale,
})

/** Security training at the company: Green 94%, required, not written. */
export const securityCompanyAttribution: CellAttribution = base({
  metricKey: 'security_training',
  subjectId: COMPANY,
  subjectName: 'Acme Demo',
  display: '94%',
  status: 'G',
  gap: { kind: 'percent', ideal: 100, headline: '6 pts short of 100%', detail: 'Green · Green at 90% or better' },
  summary: securityMissing,
})

/** Postmortems on time: perfect, so its summary is optional. */
export const postmortemsCompanyAttribution: CellAttribution = base({
  metricKey: 'postmortems_on_time',
  subjectId: COMPANY,
  subjectName: 'Acme Demo',
  display: '100%',
  status: 'G',
  attribution: 'none',
  summary: conceptsOptional,
})

/** A Green 100.00% service: nothing to explain. */
export const perfectAttribution: CellAttribution = base({
  metricKey: 'uptime',
  subjectId: 'checkout-api',
  subjectName: 'Checkout API',
  display: '100.00%',
  status: 'G',
  attribution: 'none',
})

/** A viewer scoped to Mobile cannot read the company cell: no summary. */
export const mobileAttribution: CellAttribution = base({
  ...epicsAttribution,
  subjectId: 'mobile',
  subjectName: 'Mobile',
  display: '78%',
  status: 'R',
  summary: null,
})

/** Hostile imported and written text: a script URL, an HTML title, a punycode host. */
export const hostileAttribution: CellAttribution = base({
  ...webhooksAttribution,
  subjectId: 'push-gateway',
  subjectName: 'Push Gateway',
  incidents: [
    incident({
      externalId: 'INC-6666',
      title: '<img src=x onerror="alert(1)">',
      url: 'javascript:alert(1)',
      countedMinutes: 420,
      countedDisplay: '7h 00m',
      pointsDisplay: '0.94 pts',
    }),
  ],
  incidentsTotal: 1,
  unexplained: null,
  summary: hostileSummary,
})

/** Every first page by `metric|subject|period`, as the default handlers serve them. */
export const attributionByCell: Record<string, CellAttribution> = Object.fromEntries(
  [
    webhooksAttribution,
    ingestAttribution,
    relayAttribution,
    busAttribution,
    epicsAttribution,
    epicsCompanyAttribution,
    uptimeCompanyAttribution,
    spendCompanyAttribution,
    securityCompanyAttribution,
    postmortemsCompanyAttribution,
    perfectAttribution,
    mobileAttribution,
    hostileAttribution,
  ].map((a) => [`${a.metricKey}|${a.subjectId}|${a.period}`, a]),
)

/** Whole summaries by `metric|period`, as `getMetricSummary` serves them. */
export const summaryByMetric: Record<string, MetricSummary> = Object.fromEntries(
  [uptimeSummary, deploymentMissing, epicsMissing, securityMissing, spendStale, conceptsOptional].map((s) => [
    `${s.metricKey}|${s.period}`,
    s,
  ]),
)

export const summaryList: MetricSummaryList = {
  period: '2026-M10',
  counts: { required: 5, missing: 3, stale: 1, written: 1, optional: 1 },
  items: [deploymentMissing, epicsMissing, securityMissing, { ...spendStale }, uptimeCardSummary, conceptsOptional],
}

export const summaryDraftPending: MetricSummaryDraft = {
  id: 'draft-1',
  pending: true,
  createdAt: '2026-11-20T12:00:00Z',
  warnings: [],
}

export const summaryDraftDone: MetricSummaryDraft = {
  id: 'draft-1',
  pending: false,
  text: 'Webhooks lost 7h 00m: INC-2041 4h 10m, INC-2047 and INC-2049 2h 10m; 40m is not explained. Analytics Ingest and Search had short incidents.',
  createdAt: '2026-11-20T12:00:00Z',
  warnings: [],
}
