import { describe, expect, it } from 'vitest'
import { addQuarterly, buildView, quarterlyVersions, versions } from '../../../test/viewFixtures'
import { absentItemMetrics, attentionInputs, healthTally, metricStandings } from './standings'

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

  it('ranks with the prior status and the streak at the counted column', () => {
    const view = buildView(overviewQuery())
    const { metrics } = metricStandings({ view, period: '2026-M10', fy: 1, scale: SCALE })
    const labels: Record<string, string> = { G: 'Green', Y: 'Yellow', R: 'Red' }
    const [onTime] = attentionInputs(metrics, { categories: view.categories, scale: SCALE, fy: 1, statusLabel: (k) => labels[k] })
    expect(onTime).toMatchObject({ metricKey: 'on_time_pct', status: 'Y', priorStatus: 'G', priorLabel: 'Green', streakMonths: 1 })
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
