import type { components } from '../api/schema'
import type { Column } from '../features/scorecard/columns'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']
type StatusLevel = components['schemas']['StatusLevel']

/**
 * The demo's 21 regional deployments (Deployment uptime) in the shape real
 * tenants show: long names, nine reporting in Oct 2026 (eight Green, one
 * Red), twelve not reported, eight of them with no reports from Nov 2025.
 */
interface Spec {
  id: string
  name: string
  group: string
  from?: string
  until?: string
  gaps?: string[]
  /** Red months. */
  outages?: string[]
  /** Yellow months. */
  degraded?: string[]
  oct?: number
  silent?: boolean
}

const SPECS: Spec[] = [
  {
    id: 'dep-notify-multi',
    name: 'Notification Relay - Multi-Region Active',
    group: 'Platform',
    from: '2025-M09',
    degraded: ['2026-M01', '2026-M02', '2026-M03', '2026-M04'],
    oct: 99.63,
  },
  { id: 'dep-pay-eu', name: 'Payments Gateway - EU Region Primary', group: 'Payments', oct: 100 },
  { id: 'dep-pay-us', name: 'Payments Gateway - US Region Primary', group: 'Payments', outages: ['2026-M07'], oct: 100 },
  {
    id: 'dep-portal-cloud',
    name: 'Customer Portal - Private Cloud Tenant Suite',
    group: 'Platform',
    outages: ['2026-M01', '2026-M02', '2026-M03'],
    oct: 99.98,
  },
  {
    id: 'dep-identity-east',
    name: 'Identity Service - Production East',
    group: 'Platform',
    from: '2026-M01',
    degraded: ['2026-M02'],
    outages: ['2026-M06'],
    oct: 99.99,
  },
  { id: 'dep-identity-west', name: 'Identity Service - Staging Mirror West', group: 'Platform', from: '2026-M08', oct: 99.97 },
  {
    id: 'dep-search-a1',
    name: 'Search Indexer - Production Cluster A-1',
    group: 'Data',
    from: '2026-M08',
    outages: ['2026-M09'],
    oct: 100,
  },
  { id: 'dep-search-a2', name: 'Search Indexer - Production Cluster A-2', group: 'Data', from: '2026-M09', oct: 99.99 },
  { id: 'dep-ledger', name: 'Ledger API', group: 'Payments', from: '2026-M09', oct: 99.99 },
  { id: 'dep-webhooks-us', name: 'Webhook Dispatcher - US Region Primary', group: 'Platform', from: '2025-M04', until: '2026-M09' },
  {
    id: 'dep-renderer',
    name: 'Document Renderer - Shared Worker Pool',
    group: 'Data',
    from: '2026-M04',
    until: '2026-M08',
    gaps: ['2026-M06'],
  },
  { id: 'dep-identity-dr', name: 'Identity Service - Disaster Recovery Standby', group: 'Platform', until: '2026-M06' },
  {
    id: 'dep-search-legacy',
    name: 'Search Indexer - Legacy Cluster B',
    group: 'Data',
    until: '2025-M12',
    outages: ['2025-M10', '2025-M11', '2025-M12'],
  },
  { id: 'dep-partner-sandbox', name: 'Partner API Gateway - Sandbox Environment', group: 'Payments', until: '2025-M09' },
  { id: 'dep-warehouse-primary', name: 'Analytics Warehouse - Batch Loader Primary', group: 'Data', silent: true },
  { id: 'dep-warehouse-replica', name: 'Analytics Warehouse - Batch Loader Replica', group: 'Data', silent: true },
  { id: 'dep-push-apac', name: 'Mobile Push Delivery - APAC Region Primary', group: 'Mobile', silent: true },
  { id: 'dep-push-eu', name: 'Mobile Push Delivery - EU Region Secondary', group: 'Mobile', silent: true },
  { id: 'dep-export-jobs', name: 'Data Export Service - Scheduled Jobs Runner', group: 'Data', silent: true },
  { id: 'dep-billing-recon', name: 'Billing Reconciliation - Nightly Batch Worker', group: 'Payments', silent: true },
  { id: 'dep-edge-cache', name: 'Edge Cache', group: 'Mobile', silent: true },
]

export const DEPLOYMENT_SCALE: StatusLevel[] = [
  { key: 'G', label: 'Green', color: '#137A3A', rank: 1 },
  { key: 'Y', label: 'Yellow', color: '#8A5A00', rank: 2 },
  { key: 'R', label: 'Red', color: '#B42318', rank: 3 },
]

const statusOf = (v: number) => (v >= 99.9 ? 'G' : v > 99.8 ? 'Y' : 'R')

function valueAt(s: Spec, period: string): number | null {
  if (s.silent) return null
  if (s.from && period < s.from) return null
  if (s.until && period > s.until) return null
  if (s.gaps?.includes(period)) return null
  if (s.outages?.includes(period)) return period === '2026-M01' ? 99.61 : 99.2
  if (s.degraded?.includes(period)) return 99.85
  if (period === '2026-M10' && s.oct !== undefined) return s.oct
  return 100
}

function cellOf(id: string, period: string, v: number | null): Cell {
  return {
    metricKey: 'deployment_uptime',
    subjectId: id,
    period,
    ytd: false,
    value: v,
    display: v === null ? '' : `${v.toFixed(2)}%`,
    status: v === null ? '' : statusOf(v),
    naReason: '',
    components: {},
    coverage: v === null ? [0, 1] : [1, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
  }
}

/** The deployments' item rows over `columns` (month columns, oldest first). */
export function deploymentRows(columns: Column[]): ViewRow[] {
  return SPECS.map((s) => ({
    metricKey: 'deployment_uptime',
    metricName: 'Deployment uptime',
    categoryId: 'eng',
    subjectId: s.id,
    subjectName: s.name,
    subjectKind: 'item',
    format: 'percent2',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'uptime',
    definition: '',
    cells: columns.map((c) => cellOf(s.id, c.period, valueAt(s, c.period))),
  }))
}

/** Each deployment's segment. */
export const deploymentGroup = (id: string): string => SPECS.find((s) => s.id === id)?.group ?? 'Unassigned'

export const DEPLOYMENT_NOUN = { one: 'deployment', many: 'deployments' }
