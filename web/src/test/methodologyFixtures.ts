import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import type { RecordedRequest } from './adminFixtures'
import { API } from './server'

type Schemas = components['schemas']
type MethodologyVersion = Schemas['MethodologyVersion']
type Metric = Schemas['Metric']
type ErrorDetail = Schemas['ErrorDetail']
type ImportTemplate = Schemas['ImportTemplate']
type ChangeSetPreview = Schemas['ChangeSetPreview']

// All data is synthetic.

export const UPLOAD_ORIGIN = 'https://uploads.example.test'

export interface UploadRecord {
  url: string
  contentType: string | null
  authorization: string | null
  bytes: number
}

export interface MethodologyFake {
  versions: MethodologyVersion[]
  templates: ImportTemplate[]
  /** What POST validate answers with (valid when empty). */
  validateErrors: ErrorDetail[]
  /** What the next parse and apply answer with. */
  preview: ChangeSetPreview
  applied?: ChangeSetPreview
  uploads: UploadRecord[]
  /** Every write the page made, in order. */
  requests: RecordedRequest[]
  failNext: Map<string, { status: number; code: string; message: string; details?: { path: string; message: string }[] }>
}

export function metric(key: string, name: string, over: Partial<Metric> = {}): Metric {
  return {
    key,
    name,
    categoryId: 'delivery',
    formula: 'closed / total * 100',
    format: 'percent1',
    direction: 'higher_better',
    frequency: 'monthly',
    reportedAt: [{ kind: 'level', id: 'company' }],
    rollItemsToOrg: false,
    rule: {
      type: 'bands',
      bands: [
        { status: 'G', op: '>=', value: 90 },
        { status: 'Y', op: '>=', value: 75 },
        { status: 'R', op: '', value: 0 },
      ],
    },
    targets: [],
    definition: '',
    notes: '',
    example: '',
    source: '',
    link: '',
    ...over,
  }
}

const categories = [
  { id: 'delivery', name: 'Delivery', order: 1 },
  { id: 'quality', name: 'Quality', order: 2 },
]
const measures = [
  { key: 'closed', name: 'Closed items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
  { key: 'total', name: 'Total items', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
] as const

function content() {
  return {
    categories: structuredClone(categories),
    measures: structuredClone([...measures]),
    metrics: [
      metric('on_time_pct', 'On-time delivery'),
      metric('defect_rate', 'Defect rate', {
        categoryId: 'quality',
        formula: 'defects',
        format: 'number1',
        direction: 'lower_better',
        rule: {
          type: 'change',
          compare: 'prior_period',
          bands: [
            { status: 'G', op: '<=', value: -5 },
            { status: 'R', op: '', value: 0 },
          ],
        },
      }),
    ],
  }
}

export function newMethodologyFake(): MethodologyFake {
  const old = content()
  old.metrics = [metric('on_time_pct', 'On-time delivery', { formula: 'closed / total' })]
  return {
    versions: [
      { id: 'ver-2', scorecardId: 'sc-main', name: 'FY27 proposal', status: 'draft', effectiveFrom: '', revision: 1, content: content() },
      { id: 'ver-1', scorecardId: 'sc-main', name: 'FY26 published', status: 'published', effectiveFrom: '2026-M01', revision: 3, content: content() },
      { id: 'ver-0', scorecardId: 'sc-main', name: 'FY25 published', status: 'superseded', effectiveFrom: '2025-M01', revision: 2, content: old },
    ],
    templates: [
      { id: 'legacy-main', name: 'Legacy workbook', profile: 'legacy_workbook', body: { sheets: [], rows: [], methodology: [] } },
    ],
    validateErrors: [],
    preview: {
      id: 'imp-1',
      status: 'parsed',
      counts: { dataPoints: 12, overrides: 1, versionText: 3, legacyNotes: 2 },
      findings: [
        { severity: 'warn', sheet: 'Scorecard', cell: 'F7', message: 'Cell text "n/a" was skipped' },
        { severity: 'info', sheet: 'Methodology', cell: 'C2', message: 'Definition replaced' },
      ],
      sample: [
        { kind: 'data_point', measureKey: 'closed', subjectId: 'north', period: '2025-M01', value: 40 },
        { kind: 'data_point', measureKey: 'total', subjectId: 'north', period: '2025-M01', naReason: 'Not measured' },
        { kind: 'override', metricKey: 'on_time_pct', subjectId: 'north', period: '2025-M02', value: 71, status: 'Y' },
        { kind: 'version_text', metricKey: 'on_time_pct', field: 'definition', text: 'Share of epics done on time' },
      ],
    },
    uploads: [],
    requests: [],
    failNext: new Map(),
  }
}

function errorResponse(e: { status: number; code: string; message: string; details?: unknown }) {
  return HttpResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status })
}

/** Field-level changes of one methodology against another, addressed the way the API does. */
export function diffContents(from: MethodologyVersion['content'], to: MethodologyVersion['content']) {
  const changes: { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }[] = []
  const was = new Map(from.metrics.map((m) => [m.key, m]))
  const is = new Map(to.metrics.map((m) => [m.key, m]))
  for (const [key, m] of is) if (!was.has(key)) changes.push({ path: `metrics[${key}]`, kind: 'added', after: m })
  for (const [key, m] of was) if (!is.has(key)) changes.push({ path: `metrics[${key}]`, kind: 'removed', before: m })
  for (const [key, b] of was) {
    const a = is.get(key)
    if (!a) continue
    for (const field of Object.keys(b) as (keyof Metric)[]) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        changes.push({ path: `metrics[${key}].${field}`, kind: 'changed', before: b[field], after: a[field] })
      }
    }
  }
  return changes
}

/**
 * MSW handlers for the methodology and import endpoints over an in-memory
 * fake. Writes are recorded in `fake.requests` and applied.
 */
export function methodologyHandlers(fake: MethodologyFake) {
  const write = async (request: Request, path: string) => {
    const body = request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined)
    fake.requests.push({ method: request.method, path, body })
    const fail = fake.failNext.get(`${request.method} ${path}`)
    if (fail) {
      fake.failNext.delete(`${request.method} ${path}`)
      return { body, failure: errorResponse(fail) }
    }
    return { body: body as never, failure: undefined }
  }
  const find = (id: unknown) => fake.versions.find((v) => v.id === id)
  const V = `${API}/v1/scorecards/sc-main/versions`

  return [
    http.get(V, () => HttpResponse.json({ versions: fake.versions })),
    http.post(V, async ({ request }) => {
      const w = await write(request, '/scorecards/sc-main/versions')
      if (w.failure) return w.failure
      const b = w.body as { name: string; cloneFrom?: string }
      const source = b.cloneFrom ? find(b.cloneFrom) : undefined
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
      const w = await write(request, `/scorecards/sc-main/versions/${String(params.v)}`)
      if (w.failure) return w.failure
      const b = w.body as { revision: number; name?: string; content: MethodologyVersion['content'] }
      const v = find(params.v)
      if (!v) return errorResponse({ status: 404, code: 'not_found', message: 'version not found' })
      if (b.revision !== v.revision) return errorResponse({ status: 409, code: 'conflict', message: 'revision is stale' })
      v.content = b.content
      if (b.name) v.name = b.name
      v.revision += 1
      return HttpResponse.json(v)
    }),
    http.post(`${V}/:v/validate`, async ({ request, params }) => {
      await write(request, `/scorecards/sc-main/versions/${String(params.v)}/validate`)
      return HttpResponse.json({ valid: fake.validateErrors.length === 0, errors: fake.validateErrors })
    }),
    http.post(`${V}/:v/publish`, async ({ request, params }) => {
      const w = await write(request, `/scorecards/sc-main/versions/${String(params.v)}/publish`)
      if (w.failure) return w.failure
      const v = find(params.v)
      if (!v) return errorResponse({ status: 404, code: 'not_found', message: 'version not found' })
      v.status = 'published'
      v.effectiveFrom = (w.body as { effectiveFrom: string }).effectiveFrom
      v.revision += 1
      return HttpResponse.json(v)
    }),
    http.get(`${V}/:v/diff`, ({ request, params }) => {
      const against = new URL(request.url).searchParams.get('against')
      const to = find(params.v)
      const from = against ? find(against) : fake.versions.find((v) => v.status !== 'draft')
      if (!to || !from) return errorResponse({ status: 400, code: 'invalid', message: 'no published version to compare with; pass one' })
      return HttpResponse.json({ from: from.id, to: to.id, changes: diffContents(from.content, to.content) })
    }),

    http.get(`${API}/v1/import-templates`, () => HttpResponse.json({ templates: fake.templates })),
    http.put(`${API}/v1/import-templates/:id`, async ({ request, params }) => {
      const w = await write(request, `/import-templates/${String(params.id)}`)
      if (w.failure) return w.failure
      const t = w.body as ImportTemplate
      const i = fake.templates.findIndex((x) => x.id === t.id)
      if (i >= 0) fake.templates[i] = t
      else fake.templates.push(t)
      return HttpResponse.json(t)
    }),
    http.post(`${API}/v1/imports/uploads`, async ({ request }) => {
      const w = await write(request, '/imports/uploads')
      if (w.failure) return w.failure
      return HttpResponse.json({ importId: 'imp-1', uploadUrl: `${UPLOAD_ORIGIN}/put/imp-1?sig=abc` }, { status: 201 })
    }),
    http.put(`${UPLOAD_ORIGIN}/put/:id`, async ({ request }) => {
      const bytes = (await request.arrayBuffer()).byteLength
      fake.uploads.push({
        url: request.url,
        contentType: request.headers.get('content-type'),
        authorization: request.headers.get('authorization'),
        bytes,
      })
      const fail = fake.failNext.get('PUT upload')
      if (fail) {
        fake.failNext.delete('PUT upload')
        return new HttpResponse(null, { status: fail.status })
      }
      return new HttpResponse(null, { status: 200 })
    }),
    http.post(`${API}/v1/imports/:id/parse`, async ({ request, params }) => {
      const w = await write(request, `/imports/${String(params.id)}/parse`)
      if (w.failure) return w.failure
      return HttpResponse.json(fake.preview)
    }),
    http.post(`${API}/v1/imports/:id/apply`, async ({ request, params }) => {
      const w = await write(request, `/imports/${String(params.id)}/apply`)
      if (w.failure) return w.failure
      return HttpResponse.json(fake.applied ?? { ...fake.preview, status: 'applied' })
    }),
  ]
}
