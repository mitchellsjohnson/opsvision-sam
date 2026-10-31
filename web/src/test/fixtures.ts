import type { components } from '../api/schema'

type Me = components['schemas']['Me']
type Tenant = components['schemas']['Tenant']
type Scorecard = components['schemas']['Scorecard']

// All fixtures are synthetic.
export const tenant: Tenant = {
  id: 'tenant-1',
  name: 'Example Co',
  auth0OrgId: 'org_example',
  fiscalYearStartMonth: 1,
  statusScale: [
    { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
    { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
    { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
  ],
  defaultRole: 'viewer',
  createdAt: '2026-01-01T00:00:00Z',
}

export function meFor(role: 'admin' | 'contributor' | 'viewer'): Me {
  return {
    userId: `test|${role}`,
    name: `Test ${role}`,
    email: `${role}@example.test`,
    isOperator: false,
    tenant,
    role,
    scope: { orgUnitIds: [], metricKeys: [] },
    tenants: [{ id: tenant.id, name: tenant.name }],
  }
}

export const scorecards: Scorecard[] = [
  { id: 'sc-main', name: 'Main scorecard' },
]

export const orgUnits: components['schemas']['OrgUnit'][] = [
  { id: 'unit-a', name: 'Unit A', levelId: 'l1', parentId: '', sourceKeys: [] },
  { id: 'unit-b', name: 'Unit B', levelId: 'l1', parentId: '', sourceKeys: [] },
]

export const devUsers = [
  { userId: 'dev|admin', email: 'admin@example.test', name: 'Test Admin', role: 'admin' },
  { userId: 'dev|viewer', email: 'viewer@example.test', name: 'Test Viewer', role: 'viewer' },
]
