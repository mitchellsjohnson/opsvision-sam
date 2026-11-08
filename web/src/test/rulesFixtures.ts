import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import type { RecordedRequest } from './adminFixtures'
import { recordsTemplates, recordTypes } from './recordsFixtures'
import { API } from './server'

type Schemas = components['schemas']
type RecordType = Schemas['RecordType']
type ImportTemplate = Schemas['ImportTemplate']
type RecordsSample = Schemas['RecordsSample']
type RecordsSampleRequest = Schemas['RecordsSampleRequest']

// All data is synthetic: the Acme Demo products and fictional tracker keys.

/** A saved template as the API lists it, with the last time it was applied. */
export type ListedTemplate = ImportTemplate & { lastUsed?: string; revision?: number }

export interface RulesFake {
  recordTypes: RecordType[]
  templates: ListedTemplate[]
  /** What POST records/sample answers with for a condition that compiles. */
  sample: RecordsSample
  requests: RecordedRequest[]
  failNext: Map<string, { status: number; code: string; message: string; details?: { path: string; message: string }[] }>
}

export function sampleOf(total: number, bySubject: [string, string, number][]): RecordsSample {
  return { total, bySubject: bySubject.map(([subjectId, name, count]) => ({ subjectId, name, count })) }
}

export function newRulesFake(): RulesFake {
  const templates: ListedTemplate[] = recordsTemplates()
  const defects = templates.find((t) => t.id === 'defects-export')
  if (defects) Object.assign(defects, { lastUsed: '2026-10-31T14:05:00Z', revision: 3 })
  return {
    recordTypes: structuredClone(recordTypes),
    templates,
    sample: sampleOf(212, [
      ['checkout', 'Checkout', 41],
      ['billing', 'Billing', 18],
      ['identity', 'Identity', 12],
      ['analytics', 'Analytics', 9],
    ]),
    requests: [],
    failNext: new Map(),
  }
}

function errorResponse(e: { status: number; code: string; message: string; details?: unknown }) {
  return HttpResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status })
}

/** MSW handlers for record types, saved templates and the records sample, over an in-memory fake. */
export function rulesHandlers(fake: RulesFake) {
  const write = async (request: Request, path: string) => {
    const body = await request.clone().json().catch(() => undefined)
    fake.requests.push({ method: request.method, path, body })
    const fail = fake.failNext.get(`${request.method} ${path}`)
    if (fail) {
      fake.failNext.delete(`${request.method} ${path}`)
      return { body, failure: errorResponse(fail) }
    }
    return { body, failure: undefined }
  }
  return [
    http.get(`${API}/v1/record-types`, () => HttpResponse.json({ recordTypes: fake.recordTypes })),
    http.put(`${API}/v1/record-types/:id`, async ({ request, params }) => {
      const id = String(params.id)
      const w = await write(request, `/record-types/${id}`)
      if (w.failure) return w.failure
      const body = w.body as RecordType
      const i = fake.recordTypes.findIndex((t) => t.id === id)
      const current = i >= 0 ? (fake.recordTypes[i]?.revision ?? 0) : 0
      if (body.revision !== current) {
        return errorResponse({ status: 409, code: 'conflict', message: 'revision is stale' })
      }
      const stored = { ...body, revision: current + 1 }
      if (i >= 0) fake.recordTypes[i] = stored
      else fake.recordTypes.push(stored)
      fake.recordTypes.sort((a, b) => a.id.localeCompare(b.id))
      return HttpResponse.json(stored)
    }),
    http.get(`${API}/v1/import-templates`, () => HttpResponse.json({ templates: fake.templates })),
    http.put(`${API}/v1/import-templates/:id`, async ({ request, params }) => {
      const w = await write(request, `/import-templates/${String(params.id)}`)
      if (w.failure) return w.failure
      const t = w.body as ListedTemplate
      const i = fake.templates.findIndex((x) => x.id === t.id)
      const stored = { ...t, lastUsed: fake.templates[i]?.lastUsed }
      if (i >= 0) fake.templates[i] = stored
      else fake.templates.push(stored)
      return HttpResponse.json(stored)
    }),
    http.post(`${API}/v1/scorecards/:sc/records/sample`, async ({ request, params }) => {
      const w = await write(request, `/scorecards/${String(params.sc)}/records/sample`)
      if (w.failure) return w.failure
      const body = w.body as RecordsSampleRequest
      if (/\bnope\b/.test(body.where ?? '')) {
        return errorResponse({
          status: 400,
          code: 'invalid',
          message: 'invalid request',
          details: [{ path: 'where', message: `where: unknown field "nope" on record type "${body.recordType}"` }],
        })
      }
      return HttpResponse.json(fake.sample)
    }),
  ]
}
