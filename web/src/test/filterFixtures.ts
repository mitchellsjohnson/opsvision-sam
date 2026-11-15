import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { API } from './server'

type OrgUnit = components['schemas']['OrgUnit']

// All fixtures are synthetic.
export const filterLevels: components['schemas']['Level'][] = [
  { id: 'company', name: 'Company', depth: 0 },
  { id: 'segment', name: 'Segment', depth: 1 },
  { id: 'product', name: 'Product', depth: 2 },
]

const unit = (id: string, name: string, levelId: string, parentId: string, retiredFrom?: string): OrgUnit => ({
  id,
  name,
  levelId,
  parentId,
  sourceKeys: [],
  ...(retiredFrom ? { retiredFrom } : {}),
})

export const filterUnits: OrgUnit[] = [
  unit('co', 'Example Co', 'company', ''),
  unit('seg-a', 'Unit A', 'segment', 'co'),
  unit('seg-b', 'Unit B', 'segment', 'co'),
  unit('prod-a1', 'Unit A1', 'product', 'seg-a'),
  unit('prod-a2', 'Unit A2', 'product', 'seg-a'),
  unit('prod-b1', 'Unit B1', 'product', 'seg-b'),
  unit('prod-b9', 'Unit B9', 'product', 'seg-b', '2026-M08'),
]

/** Org levels and units for the global filters, and a preferences endpoint that records saves. */
export function filterHandlers(options: { defaultScope?: string } = {}) {
  const prefs = { defaultScope: options.defaultScope ?? '' }
  const puts: { defaultScope: string }[] = []
  const handlers = [
    http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ levels: filterLevels })),
    http.get(`${API}/v1/org/units`, () => HttpResponse.json({ units: filterUnits })),
    http.get(`${API}/v1/me/preferences`, () => HttpResponse.json(prefs)),
    http.put(`${API}/v1/me/preferences`, async ({ request }) => {
      const body = (await request.json()) as { defaultScope: string }
      puts.push(body)
      prefs.defaultScope = body.defaultScope
      return HttpResponse.json(prefs)
    }),
  ]
  return { handlers, puts, prefs }
}
