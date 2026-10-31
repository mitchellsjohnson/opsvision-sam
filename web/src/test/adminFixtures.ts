import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { API } from './server'
import { versions } from './viewFixtures'

type Schemas = components['schemas']
type Level = Schemas['Level']
type OrgUnit = Schemas['OrgUnit']
type OrgMove = Schemas['OrgMove']
type OrgTreeNode = Schemas['OrgTreeNode']
type ItemKind = Schemas['ItemKind']
type TrackedItem = Schemas['TrackedItem']
type Membership = Schemas['Membership']

// All data is synthetic.

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

export interface AdminFake {
  levels: Level[]
  units: OrgUnit[]
  moves: OrgMove[]
  kinds: ItemKind[]
  items: TrackedItem[]
  members: Membership[]
  /** Every write the page made, in order. */
  requests: RecordedRequest[]
  /** Errors to answer the next write to a path with, e.g. `PATCH /members/:id`. */
  failNext: Map<string, { status: number; code: string; message: string; details?: { path: string; message: string }[] }>
}

export function newAdminFake(): AdminFake {
  return {
    levels: [
      { id: 'company', name: 'Company', depth: 0 },
      { id: 'segment', name: 'Segment', depth: 1 },
      { id: 'product', name: 'Product', depth: 2 },
    ],
    units: [
      { id: 'acme', name: 'Acme', levelId: 'company', parentId: '', sourceKeys: [] },
      { id: 'seg-a', name: 'Segment A', levelId: 'segment', parentId: 'acme', sourceKeys: ['seg a'] },
      { id: 'seg-b', name: 'Segment B', levelId: 'segment', parentId: 'acme', sourceKeys: [] },
      { id: 'prod-1', name: 'Product One', levelId: 'product', parentId: 'seg-a', sourceKeys: [] },
      {
        id: 'old-seg',
        name: 'Old Segment',
        levelId: 'segment',
        parentId: 'acme',
        sourceKeys: [],
        retiredFrom: '2020-M01',
      },
    ],
    moves: [],
    kinds: [
      { id: 'service', name: 'Service' },
      { id: 'vendor', name: 'Vendor' },
    ],
    items: [
      { id: 'svc-1', kindId: 'service', name: 'Billing Service', orgUnitId: 'prod-1', sourceKeys: ['billing'] },
      { id: 'ven-1', kindId: 'vendor', name: 'Vendor One', orgUnitId: '', sourceKeys: [] },
    ],
    members: [
      member('dev|admin', 'Test Admin', 'admin@example.test', 'admin'),
      member('dev|viewer', 'Test Viewer', 'viewer@example.test', 'viewer'),
      member('pending:new@example.test', '', 'new@example.test', 'contributor'),
    ],
    requests: [],
    failNext: new Map(),
  }
}

export function member(userId: string, name: string, email: string, role: Membership['role']): Membership {
  return {
    userId,
    name,
    email,
    role,
    scope: { orgUnitIds: [], metricKeys: [] },
    createdAt: '2026-01-01T00:00:00Z',
  }
}

/** The tree as of a month: the units, with moves effective on or before it applied. */
export function treeAt(fake: AdminFake, month: string): OrgTreeNode[] {
  const parentOf = new Map<string, string>()
  for (const u of fake.units) parentOf.set(u.id, u.parentId)
  for (const m of [...fake.moves].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth))) {
    if (m.effectiveMonth <= month) parentOf.set(m.unitId, m.newParentId)
  }
  const active = fake.units.filter((u) => !u.retiredFrom || u.retiredFrom > month)
  const build = (u: OrgUnit): OrgTreeNode => ({
    id: u.id,
    name: u.name,
    levelId: u.levelId,
    children: active.filter((c) => parentOf.get(c.id) === u.id).map(build),
  })
  return active.filter((u) => !parentOf.get(u.id)).map(build)
}

function errorResponse(e: { status: number; code: string; message: string; details?: unknown }) {
  return HttpResponse.json(
    { error: { code: e.code, message: e.message, details: e.details } },
    { status: e.status },
  )
}

/**
 * MSW handlers for the org, item, member and methodology endpoints over an
 * in-memory fake. Writes are recorded in `fake.requests` and applied, so the
 * pages see their own changes when they refetch.
 */
export function adminHandlers(fake: AdminFake) {
  /** Records a write and returns a queued failure for it, if any. */
  const write = async (request: Request, path: string) => {
    const body = request.method === 'DELETE' ? undefined : await request.clone().json()
    fake.requests.push({ method: request.method, path, body })
    const key = `${request.method} ${path}`
    const fail = fake.failNext.get(key)
    if (fail) {
      fake.failNext.delete(key)
      return { body, failure: errorResponse(fail) }
    }
    return { body: body as never, failure: undefined }
  }

  return [
    http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ levels: fake.levels })),
    http.put(`${API}/v1/org/levels`, async ({ request }) => {
      const w = await write(request, '/org/levels')
      if (w.failure) return w.failure
      fake.levels = (w.body as { levels: Level[] }).levels
      return HttpResponse.json({ levels: fake.levels })
    }),
    http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: fake.units })),
    http.post(`${API}/v1/org/units`, async ({ request }) => {
      const w = await write(request, '/org/units')
      if (w.failure) return w.failure
      fake.units.push(w.body as OrgUnit)
      return HttpResponse.json(w.body, { status: 201 })
    }),
    http.patch(`${API}/v1/org/units/:id`, async ({ request, params }) => {
      const w = await write(request, `/org/units/${String(params.id)}`)
      if (w.failure) return w.failure
      const u = fake.units.find((x) => x.id === params.id)
      if (!u) return errorResponse({ status: 404, code: 'not_found', message: 'org unit not found' })
      Object.assign(u, w.body)
      return HttpResponse.json(u)
    }),
    http.post(`${API}/v1/org/units/:id/moves`, async ({ request, params }) => {
      const w = await write(request, `/org/units/${String(params.id)}/moves`)
      if (w.failure) return w.failure
      const b = w.body as { newParentId: string; effectiveMonth: string; note?: string }
      const move: OrgMove = { unitId: String(params.id), note: '', ...b }
      fake.moves.push(move)
      return HttpResponse.json(move, { status: 201 })
    }),
    http.get(`${API}/v1/org/tree`, ({ request }) => {
      const month = new URL(request.url).searchParams.get('month') ?? '2026-M10'
      return HttpResponse.json({ month, roots: treeAt(fake, month) })
    }),

    http.get(`${API}/v1/item-kinds`, () => HttpResponse.json({ itemKinds: fake.kinds })),
    http.post(`${API}/v1/item-kinds`, async ({ request }) => {
      const w = await write(request, '/item-kinds')
      if (w.failure) return w.failure
      fake.kinds.push(w.body as ItemKind)
      return HttpResponse.json(w.body, { status: 201 })
    }),
    http.get(`${API}/v1/items`, () => HttpResponse.json({ items: fake.items })),
    http.post(`${API}/v1/items`, async ({ request }) => {
      const w = await write(request, '/items')
      if (w.failure) return w.failure
      fake.items.push(w.body as TrackedItem)
      return HttpResponse.json(w.body, { status: 201 })
    }),
    http.patch(`${API}/v1/items/:id`, async ({ request, params }) => {
      const w = await write(request, `/items/${String(params.id)}`)
      if (w.failure) return w.failure
      const it = fake.items.find((x) => x.id === params.id)
      if (!it) return errorResponse({ status: 404, code: 'not_found', message: 'item not found' })
      Object.assign(it, w.body)
      return HttpResponse.json(it)
    }),

    http.get(`${API}/v1/members`, () => HttpResponse.json({ members: fake.members })),
    http.post(`${API}/v1/members`, async ({ request }) => {
      const w = await write(request, '/members')
      if (w.failure) return w.failure
      const b = w.body as { email: string; role: Membership['role']; scope: Membership['scope'] }
      const m: Membership = {
        userId: `pending:${b.email.trim().toLowerCase()}`,
        name: '',
        email: b.email.trim(),
        role: b.role,
        scope: b.scope,
        createdAt: '2026-10-15T00:00:00Z',
      }
      fake.members.push(m)
      return HttpResponse.json(m, { status: 201 })
    }),
    http.patch(`${API}/v1/members/:userId`, async ({ request, params }) => {
      const userId = decodeURIComponent(String(params.userId))
      const w = await write(request, `/members/${userId}`)
      if (w.failure) return w.failure
      const m = fake.members.find((x) => x.userId === userId)
      if (!m) return errorResponse({ status: 404, code: 'not_found', message: 'not found' })
      Object.assign(m, w.body)
      return HttpResponse.json(m)
    }),

    http.get(`${API}/v1/scorecards/:sc/versions`, () => HttpResponse.json({ versions: publishedVersions })),
  ]
}

/** The methodology versions of the default scorecard; its published version has one metric. */
export const publishedVersions = versions
