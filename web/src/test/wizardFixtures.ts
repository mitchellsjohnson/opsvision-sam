import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import type { RecordedRequest } from './adminFixtures'
import { metric } from './methodologyFixtures'
import { acmeItems, acmeUnits, contribution, emptyPreview, recordTypes, recordsTemplates } from './recordsFixtures'
import { API } from './server'

type Schemas = components['schemas']
type ImportTemplate = Schemas['ImportTemplate']
type MethodologyVersion = Schemas['MethodologyVersion']
type RecordType = Schemas['RecordType']
type RecordsInspectResult = Schemas['RecordsInspectResult']
type RecordsPreview = Schemas['RecordsPreview']
type RecordsPreviewRequest = Schemas['RecordsPreviewRequest']

// All data is synthetic: the Acme Demo products and fictional tracker keys.

export const WIZARD_UPLOAD_ORIGIN = 'https://uploads.example.test'

/** A defects export OpsVision has not seen: every field guessed, ambiguous dates, products to match. */
export function defectsInspection(): RecordsInspectResult {
  return {
    inspection: {
      headers: ['Issue key', 'Summary', 'Product', 'Priority', 'Status', 'Created', 'Resolved', 'Due date', 'Customer ticket'],
      rowCount: 1204,
      samples: [
        ['CHK-101', 'Refund total rounds', 'Checkout Svc', 'High', 'Open', '03/04/2026', '', '', 'yes'],
        ['CHK-102', 'Login loops forever', 'Identity', 'Highest', 'Done', '03/05/2026', '03/09/2026', '04/01/2026', ''],
        ['BIL-7', 'Invoice PDF is blank', 'Billing', 'Medium', 'Won’t Do', '03/06/2026', '03/07/2026', '', ''],
        ['ANL-3', 'Chart legend overlaps', 'Analytics', 'Low', 'In Review', '03/07/2026', '', '', 'Linked'],
        ['PAY-9', 'Card retry fails', 'Commerce', 'High', 'Closed', '03/08/2026', '03/10/2026', '', ''],
      ],
      suggestedType: 'defect',
      guesses: [
        { field: 'externalId', column: 'Issue key', confidence: 0.95, samples: ['CHK-101', 'CHK-102', 'BIL-7'] },
        { field: 'subjectKey', column: 'Product', confidence: 0.95, samples: ['Checkout Svc', 'Identity', 'Billing'] },
        { field: 'title', column: 'Summary', confidence: 0.95, samples: ['Refund total rounds', 'Login loops forever', 'Invoice PDF is blank'] },
        { field: 'priority', column: 'Priority', confidence: 0.95, samples: ['High', 'Highest', 'Medium'] },
        { field: 'status', column: 'Status', confidence: 0.95, samples: ['Open', 'Done', 'Won’t Do'] },
        { field: 'state', column: 'Status', confidence: 0.95, samples: ['Open', 'Done', 'Won’t Do'] },
        { field: 'createdAt', column: 'Created', confidence: 0.95, samples: ['03/04/2026', '03/05/2026', '03/06/2026'] },
        { field: 'dueAt', column: 'Due date', confidence: 0.6, samples: ['04/01/2026'] },
        { field: 'completedAt', column: 'Resolved', confidence: 0.95, samples: ['03/09/2026', '03/07/2026', '03/10/2026'] },
      ],
      values: {
        priority: [
          { value: 'High', count: 40, suggested: 'P2' },
          { value: 'Medium', count: 30, suggested: 'P3' },
          { value: 'Highest', count: 12, suggested: 'P1' },
          { value: 'Low', count: 9, suggested: 'P4' },
          { value: '', count: 3, suggested: 'none' },
        ],
        state: [
          { value: 'Open', count: 50, suggested: 'open' },
          { value: 'Done', count: 30, suggested: 'done' },
          { value: 'In Review', count: 10, suggested: 'open' },
          { value: 'Won’t Do', count: 4, suggested: 'cancelled' },
          { value: 'Closed', count: 2, suggested: 'done' },
        ],
        subjectKey: [
          { value: 'Identity', count: 20, suggested: '' },
          { value: 'Checkout Svc', count: 14, suggested: '' },
        ],
      },
      dateFormats: {
        Created: ['01/02/2006', '02/01/2006'],
        Resolved: ['01/02/2006', '02/01/2006'],
        'Due date': ['01/02/2006'],
      },
      ambiguousDates: ['Created', 'Resolved'],
      draft: {
        name: 'Defect export',
        recordType: 'defect',
        source: 'tracker',
        file: { format: 'csv', headerRow: 1 },
        fullExport: false,
        fields: {
          externalId: { column: 'Issue key' },
          subjectKey: { column: 'Product' },
          title: { column: 'Summary' },
          priority: { column: 'Priority', default: 'none', map: { High: 'P2', Medium: 'P3', Highest: 'P1', Low: 'P4' } },
          status: { column: 'Status' },
          state: {
            column: 'Status',
            map: { '*': 'open', Open: 'open', Done: 'done', 'In Review': 'open', 'Won’t Do': 'cancelled', Closed: 'done' },
          },
          createdAt: { column: 'Created', dateFormats: ['01/02/2006'] },
          dueAt: { column: 'Due date', dateFormats: ['01/02/2006'] },
          completedAt: { column: 'Resolved', dateFormats: ['01/02/2006'] },
        },
      },
      matchedTemplateId: '',
      added: [],
      missing: [],
    },
    subjects: [
      { value: 'Checkout Svc', rows: 14, subjectId: 'checkout', score: 0.82, candidates: ['checkout'] },
      { value: 'Identity', rows: 20, subjectId: 'identity', score: 0.9, candidates: ['identity'] },
      { value: 'Billing', rows: 9, subjectId: 'billing', score: 1, candidates: ['billing'] },
      { value: 'Pmt Gateway', rows: 3, subjectId: '', score: 0, candidates: ['billing'] },
      { value: 'Commerce', rows: 2, subjectId: 'commerce', score: 1, candidates: [] },
    ],
  }
}

/** An epics export: due dates, no priorities, every product already linked. */
export function epicsInspection(): RecordsInspectResult {
  return {
    inspection: {
      headers: ['Key', 'Summary', 'Team', 'Status', 'Created', 'Due date', 'Resolved'],
      rowCount: 316,
      samples: [
        ['BIL-12', 'Usage-based invoices', 'Billing', 'In Progress', '2026-08-01', '2026-10-15', ''],
        ['BIL-40', 'Tax by region', 'Billing', 'Done', '2026-07-12', '2026-09-30', '2026-09-28'],
      ],
      suggestedType: 'epic',
      guesses: [
        { field: 'externalId', column: 'Key', confidence: 0.95, samples: ['BIL-12', 'BIL-40'] },
        { field: 'subjectKey', column: 'Team', confidence: 0.95, samples: ['Billing'] },
        { field: 'title', column: 'Summary', confidence: 0.95, samples: ['Usage-based invoices', 'Tax by region'] },
        { field: 'status', column: 'Status', confidence: 0.95, samples: ['In Progress', 'Done'] },
        { field: 'state', column: 'Status', confidence: 0.95, samples: ['In Progress', 'Done'] },
        { field: 'createdAt', column: 'Created', confidence: 0.95, samples: ['2026-08-01', '2026-07-12'] },
        { field: 'dueAt', column: 'Due date', confidence: 0.95, samples: ['2026-10-15', '2026-09-30'] },
        { field: 'completedAt', column: 'Resolved', confidence: 0.95, samples: ['2026-09-28'] },
      ],
      values: {
        state: [
          { value: 'In Progress', count: 200, suggested: 'open' },
          { value: 'Done', count: 116, suggested: 'done' },
        ],
      },
      dateFormats: {},
      ambiguousDates: [],
      draft: {
        name: 'Epic export',
        recordType: 'epic',
        source: 'tracker',
        file: { format: 'xlsx', headerRow: 1 },
        fullExport: false,
        fields: {
          externalId: { column: 'Key' },
          subjectKey: { column: 'Team' },
          title: { column: 'Summary' },
          status: { column: 'Status' },
          state: { column: 'Status', map: { '*': 'open', 'In Progress': 'open', Done: 'done' } },
          createdAt: { column: 'Created' },
          dueAt: { column: 'Due date' },
          completedAt: { column: 'Resolved' },
        },
      },
      matchedTemplateId: '',
      added: [],
      missing: [],
    },
    subjects: [{ value: 'Billing', rows: 316, subjectId: 'billing', score: 1, candidates: ['billing'] }],
  }
}

/** What the preview of a first upload shows: twelve scorecard numbers change. */
export function setupPreview(): RecordsPreview {
  return emptyPreview({
    counts: { new: 1180, changed: 0, unchanged: 0, skipped: 0, missing: 0, unmatched: 3, errors: 0 },
    story: {
      nothingChanged: false,
      lines: [
        {
          period: '2026-M10',
          metricKey: 'on_time_pct',
          metricName: 'On-time delivery',
          subjectId: 'billing',
          subjectName: 'Billing',
          beforeDisplay: '—',
          afterDisplay: '81%',
          beforeStatus: '',
          afterStatus: 'Y',
          reasons: { slipped: [contribution('BIL-12', 'slipped')] },
        },
        {
          period: '2026-M10',
          metricKey: 'on_time_pct',
          metricName: 'On-time delivery',
          subjectId: 'checkout',
          subjectName: 'Checkout',
          beforeDisplay: '—',
          afterDisplay: '92%',
          beforeStatus: '',
          afterStatus: 'G',
          reasons: { met: [contribution('CHK-7', 'met', { state: 'done' })] },
        },
      ],
      more: 10,
      typed: [],
      lockedWaiting: [],
    },
  })
}

export function wizardVersions(): MethodologyVersion[] {
  return [
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
}

/**
 * The published methodology with the epics measures already derived from
 * records: by On-time delivery's own rule (`same`), or by another rule.
 */
export function derivedEpicsVersions(rule: 'same' | 'other'): MethodologyVersion[] {
  const versions = wizardVersions()
  const content = versions[0]!.content
  const where = rule === 'other' ? { where: "category == 'feature'" } : {}
  content.measures = [
    { ...content.measures[0]!, source: 'derived', derive: { recordType: 'epic', op: 'commitments', outcome: 'resolved', ...where } },
    { ...content.measures[1]!, source: 'derived', derive: { recordType: 'epic', op: 'commitments', outcome: 'met', ...where } },
  ]
  return versions
}

export interface WizardFake {
  recordTypes: RecordType[]
  templates: ImportTemplate[]
  versions: MethodologyVersion[]
  /** Inspect answers by import ID. */
  inspections: Record<string, RecordsInspectResult>
  preview: (body: RecordsPreviewRequest) => RecordsPreview
  /** The planId of each import's latest preview. */
  plans: Record<string, string>
  requests: RecordedRequest[]
}

export function newWizardFake(): WizardFake {
  return {
    recordTypes: structuredClone(recordTypes),
    templates: recordsTemplates(),
    versions: wizardVersions(),
    inspections: { 'imp-1': defectsInspection(), 'imp-2': epicsInspection(), 'imp-9': defectsInspection() },
    preview: () => setupPreview(),
    plans: {},
    requests: [],
  }
}

export function wizardRequests(fake: WizardFake, method: string, path: string): RecordedRequest[] {
  return fake.requests.filter((r) => r.method === method && r.path === path)
}

/** MSW handlers for everything the setup wizard calls, over an in-memory fake. */
export function wizardHandlers(fake: WizardFake) {
  const record = async (request: Request, path: string) => {
    const body = await request.clone().json().catch(() => undefined)
    fake.requests.push({ method: request.method, path, body })
    return body
  }
  const V = `${API}/v1/scorecards/sc-main/versions`
  let uploads = 0
  let plans = 0
  return [
    http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: acmeUnits })),
    http.get(`${API}/v1/org/levels`, () =>
      HttpResponse.json({
        levels: [
          { id: 'company', name: 'Company', depth: 0 },
          { id: 'segment', name: 'Segment', depth: 1 },
          { id: 'product', name: 'Product', depth: 2 },
        ],
      }),
    ),
    http.get(`${API}/v1/items`, () => HttpResponse.json({ items: acmeItems })),
    http.get(`${API}/v1/record-types`, () => HttpResponse.json({ recordTypes: fake.recordTypes })),
    http.put(`${API}/v1/record-types/:id`, async ({ request, params }) => {
      const body = (await record(request, `/record-types/${String(params.id)}`)) as RecordType
      const saved = { ...body, revision: body.revision + 1 }
      const i = fake.recordTypes.findIndex((t) => t.id === saved.id)
      if (i >= 0) fake.recordTypes[i] = saved
      else fake.recordTypes.push(saved)
      return HttpResponse.json(saved)
    }),
    http.get(`${API}/v1/import-templates`, () => HttpResponse.json({ templates: fake.templates })),
    http.put(`${API}/v1/import-templates/:id`, async ({ request, params }) => {
      const t = (await record(request, `/import-templates/${String(params.id)}`)) as ImportTemplate
      const i = fake.templates.findIndex((x) => x.id === t.id)
      if (i >= 0) fake.templates[i] = t
      else fake.templates.push(t)
      return HttpResponse.json(t)
    }),
    http.post(`${API}/v1/imports/uploads`, async ({ request }) => {
      await record(request, '/imports/uploads')
      uploads += 1
      const id = `imp-up${uploads}`
      fake.inspections[id] ??= defectsInspection()
      return HttpResponse.json({ importId: id, uploadUrl: `${WIZARD_UPLOAD_ORIGIN}/put/${id}?sig=abc` }, { status: 201 })
    }),
    http.put(`${WIZARD_UPLOAD_ORIGIN}/put/:id`, () => new HttpResponse(null, { status: 200 })),
    http.post(`${API}/v1/imports/:id/inspect`, async ({ request, params }) => {
      await record(request, `/imports/${String(params.id)}/inspect`)
      const result = fake.inspections[String(params.id)]
      return result
        ? HttpResponse.json(result)
        : HttpResponse.json({ error: { code: 'not_found', message: 'import not found' } }, { status: 404 })
    }),
    http.post(`${API}/v1/imports/:id/records-preview`, async ({ request, params }) => {
      const id = String(params.id)
      const body = (await record(request, `/imports/${id}/records-preview`)) as RecordsPreviewRequest
      const planId = `plan-${id}-${++plans}`
      fake.plans[id] = planId
      return HttpResponse.json({ ...fake.preview(body), planId })
    }),
    http.post(`${API}/v1/imports/:id/apply`, async ({ request, params }) => {
      const id = String(params.id)
      const body = (await record(request, `/imports/${id}/apply`)) as { planId?: string } | undefined
      // As in the API: only the latest preview's plan can be applied.
      if (body?.planId !== fake.plans[id]) {
        return HttpResponse.json(
          { error: { code: 'conflict', message: 'preview is out of date: this is not the latest preview of the import; preview the import again' } },
          { status: 409 },
        )
      }
      return HttpResponse.json({
        id,
        status: 'applied',
        counts: { dataPoints: 0, overrides: 0, versionText: 0, legacyNotes: 0 },
        findings: [],
        sample: [],
        records: {
          snapshotId: `snap-${id}`,
          counts: { new: 1180, changed: 0, unchanged: 0, skipped: 0, missing: 0, unmatched: 0, errors: 0 },
        },
      })
    }),
    http.get(V, () => HttpResponse.json({ versions: fake.versions })),
    http.post(V, async ({ request }) => {
      const b = (await record(request, '/scorecards/sc-main/versions')) as { name: string; cloneFrom?: string }
      const source = fake.versions.find((v) => v.id === b.cloneFrom)
      const created: MethodologyVersion = {
        id: `ver-${fake.versions.length + 10}`,
        scorecardId: 'sc-main',
        name: b.name,
        status: 'draft',
        effectiveFrom: '',
        revision: 1,
        content: source ? structuredClone(source.content) : { categories: [], measures: [], metrics: [] },
      }
      fake.versions.unshift(created)
      return HttpResponse.json(created, { status: 201 })
    }),
    http.put(`${V}/:v`, async ({ request, params }) => {
      const b = (await record(request, `/scorecards/sc-main/versions/${String(params.v)}`)) as {
        revision: number
        content: MethodologyVersion['content']
      }
      const v = fake.versions.find((x) => x.id === params.v)
      if (!v) return HttpResponse.json({ error: { code: 'not_found', message: 'version not found' } }, { status: 404 })
      if (b.revision !== v.revision) {
        return HttpResponse.json({ error: { code: 'conflict', message: 'revision is stale' } }, { status: 409 })
      }
      v.content = b.content
      v.revision += 1
      return HttpResponse.json(v)
    }),
    http.post(`${V}/:v/publish`, async ({ request, params }) => {
      const b = (await record(request, `/scorecards/sc-main/versions/${String(params.v)}/publish`)) as { effectiveFrom: string }
      const v = fake.versions.find((x) => x.id === params.v)
      if (!v) return HttpResponse.json({ error: { code: 'not_found', message: 'version not found' } }, { status: 404 })
      v.status = 'published'
      v.effectiveFrom = b.effectiveFrom
      return HttpResponse.json({ ...v, recalculated: 24 })
    }),
    http.get(`${V}/:v/diff`, ({ params }) => HttpResponse.json({ from: 'ver-1', to: String(params.v), changes: [] })),
  ]
}
