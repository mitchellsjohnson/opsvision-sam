import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import type { RecordedRequest } from './adminFixtures'
import { metric } from './methodologyFixtures'
import { API } from './server'

type Schemas = components['schemas']
type ImportTemplate = Schemas['ImportTemplate']
type RecordTemplate = Schemas['RecordTemplate']
type RecordType = Schemas['RecordType']
type RecordsInspectResult = Schemas['RecordsInspectResult']
type RecordsPreview = Schemas['RecordsPreview']
type RecordsPreviewRequest = Schemas['RecordsPreviewRequest']
type RecordContribution = Schemas['RecordContribution']
type ChangeSetPreview = Schemas['ChangeSetPreview']
type MethodologyVersion = Schemas['MethodologyVersion']

// All data is synthetic: the Acme Demo products and fictional tracker keys.

export const RECORDS_UPLOAD_ORIGIN = 'https://uploads.example.test'
export const CSV_TYPE = 'text/csv'
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const acmeUnits: Schemas['OrgUnit'][] = [
  { id: 'acme', name: 'Acme Demo', levelId: 'company', parentId: '', sourceKeys: [] },
  { id: 'commerce', name: 'Commerce', levelId: 'segment', parentId: 'acme', sourceKeys: ['Commerce'] },
  { id: 'platform', name: 'Platform', levelId: 'segment', parentId: 'acme', sourceKeys: [] },
  { id: 'checkout', name: 'Checkout', levelId: 'product', parentId: 'commerce', sourceKeys: ['Checkout'] },
  { id: 'billing', name: 'Billing', levelId: 'product', parentId: 'commerce', sourceKeys: ['Billing'] },
  { id: 'identity', name: 'Identity', levelId: 'product', parentId: 'platform', sourceKeys: [] },
  { id: 'messaging', name: 'Messaging', levelId: 'product', parentId: 'platform', sourceKeys: [] },
  { id: 'analytics', name: 'Analytics', levelId: 'product', parentId: 'platform', sourceKeys: [] },
  { id: 'pipelines', name: 'Pipelines', levelId: 'product', parentId: 'platform', sourceKeys: [] },
]

export const acmeItems: Schemas['TrackedItem'][] = [
  { id: 'ios-app', kindId: 'app', name: 'iOS App', orgUnitId: 'checkout', sourceKeys: [] },
  { id: 'android-app', kindId: 'app', name: 'Android App', orgUnitId: 'checkout', sourceKeys: [] },
]

export const recordTypes: RecordType[] = [
  {
    id: 'defect',
    name: 'Defect',
    priorities: ['P1', 'P2', 'P3', 'P4'],
    attributes: [{ key: 'customerTicket', name: 'Customer ticket', type: 'bool' }],
    trackedFrom: { tracker: '2026-M11' },
    revision: 1,
  },
  { id: 'epic', name: 'Epic', priorities: [], attributes: [], trackedFrom: { tracker: '2026-M11' }, revision: 1 },
]

export function recordTemplate(over: Partial<RecordTemplate> = {}): RecordTemplate {
  return {
    name: 'Defects export',
    recordType: 'defect',
    source: 'tracker',
    file: { format: 'csv', headerRow: 1 },
    fullExport: false,
    fields: {
      externalId: { column: 'Issue key' },
      subjectKey: { column: 'Product' },
      priority: { column: 'Priority', map: { Highest: 'P1', High: 'P2', Medium: 'P3', Low: 'P4' } },
      createdAt: { column: 'Created' },
      completedAt: { column: 'Resolved' },
    },
    ...over,
  }
}

function asBody(t: RecordTemplate): Record<string, unknown> {
  return t as unknown as Record<string, unknown>
}

export function recordsTemplates(): ImportTemplate[] {
  return [
    { id: 'defects-export', name: 'Defects export', profile: 'records', body: asBody(recordTemplate()) },
    {
      id: 'epics-export',
      name: 'Epics export',
      profile: 'records',
      body: asBody(
        recordTemplate({
          name: 'Epics export',
          recordType: 'epic',
          fullExport: true,
          fields: { externalId: { column: 'Key' }, subjectKey: { column: 'Team' }, dueAt: { column: 'Due date' } },
        }),
      ),
    },
    { id: 'legacy-main', name: 'Legacy workbook', profile: 'legacy_workbook', body: { sheets: [], rows: [], methodology: [] } },
  ]
}

export function inspection(matchedTemplateId: string, rowCount: number, over: Partial<Schemas['RecordInspection']> = {}): RecordsInspectResult {
  return {
    inspection: {
      headers: ['Issue key', 'Product', 'Priority', 'Created', 'Resolved'],
      rowCount,
      samples: [['CHK-101', 'Checkout', 'High', '10/02/2026', '']],
      suggestedType: 'defect',
      guesses: [],
      values: {},
      dateFormats: {},
      ambiguousDates: [],
      draft: recordTemplate(),
      matchedTemplateId,
      added: [],
      missing: [],
      ...over,
    },
    subjects: [],
  }
}

export function contribution(externalId: string, reason: string, over: Partial<RecordContribution> = {}): RecordContribution {
  return {
    source: 'tracker',
    externalId,
    title: `Synthetic item ${externalId}`,
    url: `https://tracker.example/browse/${externalId}`,
    priority: 'none',
    state: 'open',
    amount: 1,
    reason,
    dates: {},
    ...over,
  }
}

const NO_COUNTS = { new: 0, changed: 0, unchanged: 0, skipped: 0, missing: 0, unmatched: 0, errors: 0 }

export function emptyPreview(over: Partial<RecordsPreview> = {}): RecordsPreview {
  return {
    planId: 'plan-0',
    counts: { ...NO_COUNTS },
    story: { nothingChanged: false, sameRecords: false, warnings: [], lines: [], more: 0, typed: [], lockedWaiting: [] },
    problems: [],
    unmatched: [],
    parents: [],
    newValues: {},
    missing: [],
    columnsAdded: [],
    columnsMissing: [],
    ...over,
  }
}

/** A defects export: 37 changed rows, questions to answer, a row it cannot read. */
export function defectsPreview(): RecordsPreview {
  return emptyPreview({
    counts: { new: 7, changed: 30, unchanged: 1150, skipped: 0, missing: 0, unmatched: 17, errors: 1 },
    story: {
      nothingChanged: false, sameRecords: false, warnings: [],
      lines: [
        {
          period: '2026-M10',
          metricKey: 'defect_score',
          metricName: 'Defect score',
          subjectId: 'checkout',
          subjectName: 'Checkout',
          beforeDisplay: '3.1',
          afterDisplay: '4.6',
          beforeStatus: 'G',
          afterStatus: 'Y',
          reasons: { newly_open: [contribution('CHK-101', 'open_days', { priority: 'P1' })] },
        },
      ],
      more: 0,
      typed: [],
      lockedWaiting: [],
    },
    problems: [
      {
        row: 12,
        kind: 'error',
        column: 'Created',
        field: 'createdAt',
        value: '31/02/2026',
        message: 'createdAt (column "Created"): no date format matches the subject snapshot revision',
      },
      { row: 40, kind: 'unmapped_value', column: 'Priority', field: 'priority', value: 'Urgent', message: 'value "Urgent" has no mapping' },
    ],
    unmatched: [
      { value: 'Checkout Svc', rows: 14, subjectId: 'checkout', score: 0.82, candidates: ['checkout'] },
      { value: 'Pmt Gateway', rows: 3, subjectId: '', score: 0, candidates: ['billing'] },
    ],
    newValues: { priority: [{ value: 'Urgent', count: 3, suggested: '' }] },
    columnsAdded: ['Sprint', 'Labels'],
    columnsMissing: ['Linked tickets'],
  })
}

/** An epics export (a full export): three slips, a typed value that differs, two missing records. */
export function epicsPreview(): RecordsPreview {
  return emptyPreview({
    counts: { new: 2, changed: 10, unchanged: 300, skipped: 4, missing: 2, unmatched: 0, errors: 0 },
    story: {
      nothingChanged: false, sameRecords: false, warnings: [],
      lines: [
        {
          period: '2026-M10',
          metricKey: 'on_time_pct',
          metricName: 'On-time delivery',
          subjectId: 'billing',
          subjectName: 'Billing',
          beforeDisplay: '84%',
          afterDisplay: '81%',
          beforeStatus: 'Y',
          afterStatus: 'Y',
          reasons: {
            slipped: [contribution('BIL-12', 'slipped'), contribution('BIL-40', 'slipped'), contribution('BIL-77', 'slipped')],
          },
        },
      ],
      more: 0,
      typed: [
        {
          measureKey: 'epics_on_time',
          subjectId: 'billing',
          period: '2026-M10',
          typed: 48,
          typedSource: 'grid',
          records: 47,
          contributions: [contribution('BIL-5', 'met', { state: 'done' })],
        },
      ],
      lockedWaiting: [],
    },
    missing: ['BIL-3', 'BIL-9'],
  })
}

export interface RecordsFake {
  templates: ImportTemplate[]
  /** Inspect answers by uploaded file name. */
  inspections: Record<string, RecordsInspectResult>
  /** Preview answers by uploaded file name; may depend on the request. */
  previews: Record<string, RecordsPreview | ((body: RecordsPreviewRequest) => RecordsPreview)>
  applied: Record<string, ChangeSetPreview['records']>
  /** The planId of each import's latest preview; apply needs it, as in the API. */
  plans: Record<string, string>
  uploads: { url: string; contentType: string | null; authorization: string | null }[]
  requests: RecordedRequest[]
  failNext: Map<string, { status: number; code: string; message: string }>
}

export function newRecordsFake(): RecordsFake {
  return {
    templates: recordsTemplates(),
    inspections: {
      'defects.csv': inspection('defects-export', 1204, { lastUploadAsOf: `${new Date().getFullYear()}-10-31` }),
      'epics.xlsx': inspection('epics-export', 316, { headers: ['Key', 'Team', 'Due date'], suggestedType: 'epic' }),
      'mystery.csv': inspection('', 52, { suggestedType: '' }),
    },
    previews: { 'defects.csv': defectsPreview(), 'epics.xlsx': epicsPreview() },
    applied: {},
    plans: {},
    uploads: [],
    requests: [],
    failNext: new Map(),
  }
}

const versions: MethodologyVersion[] = [
  {
    id: 'ver-1',
    scorecardId: 'sc-main',
    name: 'FY26 published',
    status: 'published',
    effectiveFrom: '2026-M01',
    revision: 1,
    content: {
      categories: [{ id: 'delivery', name: 'Delivery', order: 1 }],
      measures: [
        { key: 'epics_committed', name: 'Epics committed', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
        { key: 'epics_on_time', name: 'Epics delivered on time', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
      ],
      metrics: [metric('on_time_pct', 'On-time delivery', { formula: 'epics_on_time / epics_committed * 100' })],
    },
  },
]

/** The requests the page made to one path, in order. */
export function requestsTo(fake: RecordsFake, method: string, path: string): RecordedRequest[] {
  return fake.requests.filter((r) => r.method === method && r.path === path)
}

/** MSW handlers for the records import endpoints over an in-memory fake. */
export function recordsHandlers(fake: RecordsFake, { withVersions = true } = {}) {
  const filenames = new Map<string, string>()
  // As in the API: an applied import cannot be previewed or applied again.
  const appliedIds = new Set<string>()
  let planCount = 0
  const appliedConflict = () =>
    HttpResponse.json(
      { error: { code: 'conflict', message: 'import is applied; only an uploaded or previewed import can be previewed' } },
      { status: 409 },
    )
  const record = async (request: Request, path: string) => {
    const body = await request.clone().json().catch(() => undefined)
    fake.requests.push({ method: request.method, path, body })
    const fail = fake.failNext.get(`${request.method} ${path}`)
    if (fail) {
      fake.failNext.delete(`${request.method} ${path}`)
      return { body, failure: HttpResponse.json({ error: { code: fail.code, message: fail.message } }, { status: fail.status }) }
    }
    return { body, failure: undefined }
  }
  const handlers = [
    http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: acmeUnits })),
    http.get(`${API}/v1/items`, () => HttpResponse.json({ items: acmeItems })),
    http.get(`${API}/v1/record-types`, () => HttpResponse.json({ recordTypes })),
    http.get(`${API}/v1/import-templates`, () => HttpResponse.json({ templates: fake.templates })),
    http.post(`${API}/v1/imports/uploads`, async ({ request }) => {
      const w = await record(request, '/imports/uploads')
      if (w.failure) return w.failure
      const id = `imp-${filenames.size + 1}`
      filenames.set(id, (w.body as { filename: string }).filename)
      return HttpResponse.json({ importId: id, uploadUrl: `${RECORDS_UPLOAD_ORIGIN}/put/${id}?sig=abc` }, { status: 201 })
    }),
    http.put(`${RECORDS_UPLOAD_ORIGIN}/put/:id`, ({ request }) => {
      fake.uploads.push({
        url: request.url,
        contentType: request.headers.get('content-type'),
        authorization: request.headers.get('authorization'),
      })
      return new HttpResponse(null, { status: 200 })
    }),
    http.post(`${API}/v1/imports/:id/inspect`, async ({ request, params }) => {
      const w = await record(request, `/imports/${String(params.id)}/inspect`)
      if (w.failure) return w.failure
      const result = fake.inspections[filenames.get(String(params.id)) ?? '']
      return result
        ? HttpResponse.json(result)
        : HttpResponse.json({ error: { code: 'not_found', message: 'import not found' } }, { status: 404 })
    }),
    http.post(`${API}/v1/imports/:id/records-preview`, async ({ request, params }) => {
      const w = await record(request, `/imports/${String(params.id)}/records-preview`)
      if (w.failure) return w.failure
      if (appliedIds.has(String(params.id))) return appliedConflict()
      const name = filenames.get(String(params.id)) ?? String(params.id)
      const p = fake.previews[name]
      if (!p) return HttpResponse.json({ error: { code: 'not_found', message: 'import not found' } }, { status: 404 })
      const planId = `plan-${String(params.id)}-${++planCount}`
      fake.plans[String(params.id)] = planId
      return HttpResponse.json({ ...(typeof p === 'function' ? p(w.body as RecordsPreviewRequest) : p), planId })
    }),
    http.post(`${API}/v1/imports/:id/apply`, async ({ request, params }) => {
      const id = String(params.id)
      const w = await record(request, `/imports/${id}/apply`)
      if (w.failure) return w.failure
      if (appliedIds.has(id)) {
        return HttpResponse.json({ error: { code: 'already_applied', message: 'this upload was already applied' } }, { status: 409 })
      }
      if ((w.body as { planId?: string } | undefined)?.planId !== fake.plans[id]) {
        return HttpResponse.json(
          { error: { code: 'preview_out_of_date', message: 'preview is out of date: this is not the latest preview of the import; preview the import again' } },
          { status: 409 },
        )
      }
      appliedIds.add(id)
      const name = filenames.get(id) ?? id
      const records = fake.applied[name] ?? {
        snapshotId: `snap-${id}`,
        counts: { new: 7, changed: 30, unchanged: 1150, skipped: 0, missing: 0, unmatched: 0, errors: 0 },
      }
      const out: ChangeSetPreview = {
        id,
        status: 'applied',
        counts: { dataPoints: 0, overrides: 0, versionText: 0, legacyNotes: 0 },
        findings: [],
        sample: [],
        records,
      }
      return HttpResponse.json(out)
    }),
  ]
  if (withVersions) {
    handlers.push(http.get(`${API}/v1/scorecards/sc-main/versions`, () => HttpResponse.json({ versions })))
  }
  return handlers
}
