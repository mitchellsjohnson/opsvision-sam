import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { deploymentRows } from '../../../test/deploymentFixtures'
import { addQuarterly, buildView, quarterlyVersions, versions } from '../../../test/viewFixtures'
import { buildTrendColumns } from '../columns'
import { absentItemMetrics, attentionInputs, healthTally, metricNoun, metricStandings } from './standings'

type ScorecardView = components['schemas']['ScorecardView']

const SCALE = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]

/** The Overview's request at Oct 2026: 12 months, then four quarters. */
function overviewQuery(): URLSearchParams {
  const q = new URLSearchParams()
  for (let m = 11; m <= 12; m++) q.append('periods', `2025-M${m}`)
  for (let m = 1; m <= 10; m++) q.append('periods', `2026-M${String(m).padStart(2, '0')}`)
  for (const p of ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']) q.append('periods', p)
  return q
}

/** The 21 deployments of Deployment uptime over the Overview's 12 months, reported only for the `deployments` item kind. */
function deploymentView(): ScorecardView {
  const columns = buildTrendColumns('2026-M10', 1)
  const periods = columns.map((c) => c.period)
  return {
    periods,
    ytd: [],
    categories: [{ id: 'eng', name: 'Engineering', order: 1 }],
    rows: deploymentRows(columns),
    versionByPeriod: Object.fromEntries(periods.map((p) => [p, 'ver-1'])),
  }
}

const deploymentVersions = versions.map((v) =>
  v.id !== 'ver-1'
    ? v
    : {
        ...v,
        content: {
          ...v.content,
          metrics: [
            {
              ...v.content.metrics[0]!,
              key: 'deployment_uptime',
              name: 'Deployment uptime',
              categoryId: 'eng',
              reportedAt: [{ kind: 'item_kind' as const, id: 'deployments' }],
            },
          ],
        },
      },
)

describe('metricStandings', () => {
  it('counts each metric once: a monthly one at the month, a quarterly one at its latest quarter', () => {
    const view = addQuarterly(buildView(overviewQuery()))
    const { metrics, selected, priorTrend } = metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE, versions: quarterlyVersions })
    expect([selected?.key, priorTrend?.key]).toEqual(['2026-M10', '2026-M09'])
    const status = Object.fromEntries(metrics.map((m) => [m.key, m.status?.status ?? '']))
    expect(status).toEqual({ on_time_pct: 'Y', concepts_value: 'G', defect_rate: '' })
    const concepts = metrics.find((m) => m.key === 'concepts_value')!
    expect(concepts.coarse.map((c) => c.key)).toEqual(['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3'])
    expect(concepts.status?.counted.key).toBe('2026-Q3')
    expect(healthTally(metrics.map((m) => m.status?.status ?? ''), 0, 'none')).toEqual(
      new Map([
        ['none', 1],
        ['Y', 1],
        ['G', 1],
      ]),
    )
  })

  it('without the coarse periods, a quarterly metric has no status at the month', () => {
    const q = new URLSearchParams()
    for (let m = 5; m <= 10; m++) q.append('periods', `2026-M${String(m).padStart(2, '0')}`)
    const { metrics } = metricStandings({ view: addQuarterly(buildView(q)), period: '2026-M10', fy: 1, scale: SCALE })
    expect(metrics.find((m) => m.key === 'concepts_value')!.status?.status).toBe('')
  })

  it('names item children by their kind: the kind’s name when known, else its id', () => {
    const view = deploymentView()
    const caption = (input: Partial<Parameters<typeof metricStandings>[0]> = {}) =>
      metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE, versions: deploymentVersions, ...input }).metrics[0]!.status?.caption
    expect(caption()).toBe('worst of 9 deployments · 12 not reported')
    expect(caption({ itemKinds: [{ id: 'deployments', name: 'Regional deployments' }] })).toBe(
      'worst of 9 regional deployments · 12 not reported',
    )
    const { noun } = metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE, versions: deploymentVersions }).metrics[0]!
    expect(noun).toEqual({ one: 'deployment', many: 'deployments' })
  })

  it('names unit children by their org level', () => {
    const view = buildView(overviewQuery())
    Object.assign(view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!.cells.find((c) => c.period === '2026-M10')!, {
      value: null,
      display: '',
      status: '',
    })
    const caption = (orgLevels?: { depth: number; name: string }[]) =>
      metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE, orgLevels }).metrics.find((m) => m.key === 'on_time_pct')!.status?.caption
    expect(caption([{ depth: 1, name: 'Products' }])).toBe('worst of 2 products')
    expect(caption([])).toBe('worst of 2 units')
    // Callers that pass no levels (the report) keep the noun they had.
    expect(caption()).toBe('worst of 2 segments')
  })

  it('ranks with the prior status and the streak at the counted column', () => {
    const view = buildView(overviewQuery())
    const { metrics } = metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE })
    const labels: Record<string, string> = { G: 'Green', Y: 'Yellow', R: 'Red' }
    const [onTime] = attentionInputs(metrics, { categories: view.categories, scale: SCALE, fy: 1, statusLabel: (k) => labels[k] })
    expect(onTime).toMatchObject({ metricKey: 'on_time_pct', status: 'Y', priorStatus: 'G', priorLabel: 'Green', streakMonths: 1 })
  })
})

describe('metricNoun', () => {
  const columns = buildTrendColumns('2026-M10', 1)
  const items = deploymentRows(columns)
  const metric = deploymentVersions.find((v) => v.id === 'ver-1')!.content.metrics[0]!
  const units = buildView(overviewQuery()).rows.filter((r) => r.metricKey === 'on_time_pct')
  const [scope, ...children] = units

  it('three arguments keep the old words', () => {
    expect(metricNoun('uptime', null, items)).toEqual({ one: 'service', many: 'services' })
    expect(metricNoun('ratio', scope!, children)).toEqual({ one: 'segment', many: 'segments' })
    expect(metricNoun('ratio', scope!, [])).toEqual({ one: 'item', many: 'items' })
  })

  it('items: the kind’s name, else the kind id from the metric, else item', () => {
    expect(metricNoun('uptime', null, items, { metric, itemKinds: [{ id: 'deployments', name: 'Regional deployments' }] })).toEqual({
      one: 'regional deployment',
      many: 'regional deployments',
    })
    expect(metricNoun('uptime', null, items, { metric })).toEqual({ one: 'deployment', many: 'deployments' })
    expect(metricNoun('uptime', null, items, {})).toEqual({ one: 'item', many: 'items' })
  })

  it('units: the children’s level, else unit', () => {
    expect(metricNoun('ratio', scope!, children, { levelName: 'Products' })).toEqual({ one: 'product', many: 'products' })
    expect(metricNoun('ratio', scope!, children, {})).toEqual({ one: 'unit', many: 'units' })
  })
})

describe('absentItemMetrics', () => {
  it('names a metric reported only for items that has no rows in the view', () => {
    const withItems = versions.map((v) =>
      v.id !== 'ver-1'
        ? v
        : {
            ...v,
            content: {
              ...v.content,
              metrics: [...v.content.metrics, { ...v.content.metrics[0]!, key: 'svc_uptime', name: 'Service uptime', reportedAt: [{ kind: 'item_kind' as const, id: 'service' }] }],
            },
          },
    )
    const view = buildView(overviewQuery())
    const { metrics, selected } = metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE, versions: withItems })
    expect(absentItemMetrics(view, withItems, selected, metrics).map((m) => m.key)).toEqual(['svc_uptime'])
  })
})
