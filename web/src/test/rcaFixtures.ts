import type { components } from '../api/schema'

type CellRca = components['schemas']['CellRca']
type RcaIncident = components['schemas']['RcaIncident']
type RcaRecord = components['schemas']['RcaRecord']
type RcaNote = components['schemas']['RcaNote']
type CellRcaList = components['schemas']['CellRcaList']
type CellRcaDraft = components['schemas']['CellRcaDraft']

// All fixtures are synthetic; they mirror the demo seed's Oct 2026 cells (spec §14).

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

function base(over: Partial<CellRca> & Pick<CellRca, 'metricKey' | 'subjectId' | 'subjectName'>): CellRca {
  return {
    period: '2026-M10',
    display: '',
    status: '',
    expectation: 'none',
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
    note: null,
    stale: false,
    staleReasons: [],
    canEdit: true,
    ...over,
  }
}

export const webhooksNote: RcaNote = {
  text: 'Config deploy saturated the delivery queue (INC-2041); a retry worker crash loop and regional DNS failures followed. 40m has no incident.',
  links: [{ title: 'Postmortem', url: 'https://docs.example/postmortems/webhooks-oct' }],
  authorId: 'dev|admin',
  authorName: 'Avery Admin',
  channel: 'web',
  updatedAt: '2026-11-03T10:00:00Z',
  revision: 1,
}

/** Webhooks uptime, Oct 2026: 420 minutes reported, three incidents and a remainder. */
export const webhooksRca: CellRca = base({
  metricKey: 'uptime',
  subjectId: 'webhooks',
  subjectName: 'Webhooks',
  display: '99.06%',
  status: 'R',
  expectation: 'needed',
  gap: {
    kind: 'downtime',
    ideal: 100,
    units: 94,
    decimals: 2,
    headline: '0.94 pts short of 100% · 7h 00m down',
    detail: 'Red · Green at 99.90% or better',
    periodMinutes: 44640,
    reportedMinutes: 420,
    reportedFrom: 'measure',
  },
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
  note: webhooksNote,
})

/** Search uptime: a note written at 99.90% that now reads stale, a fan-out incident and a tied remainder. */
export const searchRca: CellRca = base({
  metricKey: 'uptime',
  subjectId: 'search',
  subjectName: 'Search',
  display: '99.87%',
  status: 'Y',
  expectation: 'needed',
  gap: {
    kind: 'downtime',
    ideal: 100,
    units: 13,
    decimals: 2,
    headline: '0.13 pts short of 100% · 1h 00m down',
    detail: 'Yellow · Green at 99.90% or better',
    periodMinutes: 44640,
    reportedMinutes: 60,
    reportedFrom: 'measure',
  },
  incidents: [
    incident({
      externalId: 'INC-2049@Search',
      key: 'INC-2049',
      url: 'https://tracker.example/browse/INC-2049',
      title: 'Regional DNS resolution failures',
      startedAt: '2026-10-17T11:20:00Z',
      endedAt: '2026-10-17T11:50:00Z',
      countedMinutes: 30,
      countedDisplay: '30m',
      pointsDisplay: '0.07 pts',
      notes: ['Same window as sp-7f3k (Status page)'],
      subjectIds: ['search'],
    }),
  ],
  incidentsTotal: 1,
  unexplained: { minutes: 30, display: '0.06 pts · 30m of the 1h 00m reported', withinTolerance: false },
  note: {
    text: 'Index rebuild during the planned failover; slow queries for about 30 minutes, no failed requests.',
    links: [],
    authorId: 'dev|contributor',
    authorName: 'Casey Contributor',
    channel: 'mcp',
    updatedAt: '2026-10-28T09:00:00Z',
    revision: 2,
  },
  stale: true,
  staleReasons: ['The value changed from 99.90% to 99.87%.', '1 new incident since it was written: INC-2049.'],
})

/** Analytics Ingest uptime: incidents explain more than the reported downtime (no note: needed). */
export const ingestRca: CellRca = base({
  metricKey: 'uptime',
  subjectId: 'analytics-ingest',
  subjectName: 'Analytics Ingest',
  display: '99.83%',
  status: 'Y',
  expectation: 'needed',
  gap: {
    kind: 'downtime',
    ideal: 100,
    units: 17,
    decimals: 2,
    headline: '0.17 pts short of 100% · 1h 15m down',
    detail: 'Yellow · Green at 99.90% or better',
    periodMinutes: 44640,
    reportedMinutes: 75,
    reportedFrom: 'measure',
  },
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
export const relayRca: CellRca = base({
  metricKey: 'deployment_uptime',
  subjectId: 'notification-relay',
  subjectName: 'Notification Relay - Multi-Region Active',
  display: '98.66%',
  status: 'R',
  expectation: 'needed',
  gap: {
    kind: 'downtime',
    ideal: 100,
    units: 134,
    decimals: 2,
    headline: '1.34 pts short of 100% · 10h 00m down',
    detail: 'Red · Green at 99.90% or better',
    periodMinutes: 44640,
    reportedMinutes: 600,
    reportedFrom: 'measure',
  },
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
})

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

/** Checkout epics on time: 3 of 11 missed, no note yet. Ratio rows carry no points. */
export const epicsRca: CellRca = base({
  metricKey: 'epics_on_time',
  subjectId: 'checkout',
  subjectName: 'Checkout',
  display: '73%',
  status: 'R',
  expectation: 'needed',
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
})

/** Billing epics, which the caller cannot write. */
export const billingRca: CellRca = base({
  ...epicsRca,
  subjectId: 'billing',
  subjectName: 'Billing',
  display: '82%',
  status: 'Y',
  gap: { ...epicsRca.gap, units: 18, headline: '18 pts short of 100% · 2 of 11 epics missed', detail: 'Yellow · Green at 90% or better · each miss costs 9.1 pts' },
  records: epicsRca.records.slice(0, 2),
  recordsTotal: 2,
  recordsSummary: '2 of 11 epics missed',
  canEdit: false,
})

/** The company roll-up of epics on time: the worst three products. */
export const epicsRollupRca: CellRca = base({
  metricKey: 'epics_on_time',
  subjectId: 'acme',
  subjectName: 'Acme Demo',
  display: '84%',
  status: 'Y',
  expectation: 'available',
  gap: {
    kind: 'ratio',
    ideal: 100,
    units: 16,
    decimals: 0,
    headline: '16 pts short of 100% · 14 of 88 epics missed',
    detail: 'Yellow · Green at 90% or better',
  },
  children: [
    { subjectId: 'checkout', subjectName: 'Checkout', display: '73%', status: 'R', impactDisplay: '3 missed', written: false, topIncident: 'CHK-226' },
    {
      subjectId: 'billing',
      subjectName: 'Billing',
      display: '82%',
      status: 'Y',
      impactDisplay: '2 missed',
      written: true,
      excerpt: 'Ledger freeze moved two epics into November…',
    },
    { subjectId: 'identity', subjectName: 'Identity', display: '86%', status: 'Y', impactDisplay: '2 missed', written: false },
  ],
  childrenTotal: 8,
})

/** A Green 100.00% cell: nothing to explain. */
export const perfectRca: CellRca = base({
  metricKey: 'uptime',
  subjectId: 'checkout-api',
  subjectName: 'Checkout API',
  display: '100.00%',
  status: 'G',
  expectation: 'none',
})

/** Hostile imported and written text: a script URL, an HTML title, a punycode host. */
export const hostileRca: CellRca = base({
  ...webhooksRca,
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
  note: {
    ...webhooksNote,
    text: '<b>bold</b> and **not markdown**',
    links: [
      { title: 'Runbook', url: 'https://xn--bcher-kva.example/runbook' },
      { title: 'Old wiki', url: 'http://wiki.example/page' },
    ],
  },
})

/** Every fixture by `metric|subject|period`, as the default handlers serve them. */
export const rcaByCell: Record<string, CellRca> = Object.fromEntries(
  [webhooksRca, searchRca, ingestRca, relayRca, epicsRca, billingRca, epicsRollupRca, perfectRca, hostileRca].map((r) => [
    `${r.metricKey}|${r.subjectId}|${r.period}`,
    r,
  ]),
)

export const rcaList: CellRcaList = {
  period: '2026-M10',
  counts: { needed: 3, stale: 1, written: 1, available: 4, neededMine: 3 },
  items: [
    {
      metricKey: 'uptime',
      metricName: 'Uptime',
      categoryId: 'reliability',
      subjectId: 'analytics-ingest',
      subjectName: 'Analytics Ingest',
      subjectKind: 'item',
      groupName: 'Data',
      period: '2026-M10',
      display: '99.83%',
      status: 'Y',
      state: 'needed',
      gapDisplay: '0.17 pts · 1h 15m',
      evidenceDisplay: '1 incident',
      canEdit: true,
    },
    {
      metricKey: 'uptime',
      metricName: 'Uptime',
      categoryId: 'reliability',
      subjectId: 'webhooks',
      subjectName: 'Webhooks',
      subjectKind: 'item',
      groupName: 'Platform',
      period: '2026-M10',
      display: '99.06%',
      status: 'R',
      state: 'written',
      gapDisplay: '0.94 pts · 7h 00m',
      evidenceDisplay: '3 incidents',
      excerpt: 'Config deploy saturated the delivery queue (INC-2041); a retr…',
      authorName: 'Avery Admin',
      updatedAt: '2026-11-03T10:00:00Z',
      revision: 1,
      canEdit: true,
    },
  ],
}

export const rcaDraftPending: CellRcaDraft = {
  id: 'draft-1',
  pending: true,
  createdAt: '2026-11-20T12:00:00Z',
  warnings: [],
}

export const rcaDraftDone: CellRcaDraft = {
  id: 'draft-1',
  pending: false,
  text: 'INC-2041 saturated the delivery queue for 4h 10m; INC-2047 and INC-2049 added 2h 10m. 0.09 pts (40m) not explained.',
  createdAt: '2026-11-20T12:00:00Z',
  warnings: [],
}
