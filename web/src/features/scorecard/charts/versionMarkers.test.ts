import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildMonthTrendColumns, coarseColumns } from '../columns'
import { versionBoundaries } from './versionMarkers'

type MethodologyVersion = components['schemas']['MethodologyVersion']
type Measure = components['schemas']['Measure']

const measures: Measure[] = [
  { key: 'epics_on_time', name: 'Epics on time', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
  { key: 'epics_committed', name: 'Epics committed', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
  { key: 'tickets', name: 'Tickets', unit: 'count', orgAgg: 'sum', timeAgg: 'sum' },
]

function version(id: string, name: string, effectiveFrom: string, derived: string[] = [], status: MethodologyVersion['status'] = 'published'): MethodologyVersion {
  return {
    id,
    scorecardId: 'sc',
    name,
    status,
    effectiveFrom,
    publishedAt: `${effectiveFrom.slice(0, 4)}-01-01T00:00:00Z`,
    revision: 1,
    content: {
      categories: [],
      measures: measures.map((m) => (derived.includes(m.key) ? { ...m, source: 'derived' as const } : m)),
      metrics: [
        { key: 'on_time', formula: 'epics_on_time / epics_committed * 100' },
        { key: 'tickets_closed', formula: 'tickets' },
      ].map(
        (m) =>
          ({
            ...m,
            name: m.key,
            categoryId: 'c',
            format: 'percent0',
            direction: 'higher_better',
            frequency: 'monthly',
            reportedAt: [],
            rollItemsToOrg: false,
            rule: { type: 'bands', bands: [] },
            targets: [],
            definition: '',
            notes: '',
            example: '',
            source: '',
            link: '',
          }) as components['schemas']['Metric'],
      ),
    },
  }
}

// Nov 2025 – Oct 2026; the 2025 methodology runs until 2026 v1.0 takes over in Jan and 2026 v2 in Jul.
const columns = buildMonthTrendColumns('2026-M10', 12, 1)
const versions = [
  version('v2025', '2025 v1.0', '2025-M01'),
  version('v2026', '2026 v1.0', '2026-M01'),
  version('v2026-2', '2026 v2', '2026-M07', ['epics_on_time', 'epics_committed']),
]

/** `v` with metric `key`'s definition edited. */
function editMetric(v: MethodologyVersion, key: string, edit: (m: components['schemas']['Metric']) => void): MethodologyVersion {
  const metrics = v.content.metrics.map((m) => {
    if (m.key !== key) return m
    const copy = structuredClone(m)
    edit(copy)
    return copy
  })
  return { ...v, content: { ...v.content, metrics } }
}

describe('versionBoundaries', () => {
  it('marks a change of version only where the metric changed: From records when it newly derives a measure of the metric', () => {
    // 2026 v1.0 restates 2025 v1.0 unchanged for this metric, so January is no boundary.
    expect(versionBoundaries(versions, columns, 'on_time')).toEqual([
      { index: 8, label: 'From records', title: 'Methodology changed: 2026 v2 from Jul 2026' },
    ])
  })

  it('skips every boundary where the metric’s rule, formula and measures did not change', () => {
    expect(versionBoundaries(versions, columns, 'tickets_closed')).toEqual([])
  })

  it('names the version when the metric’s rule or formula changed', () => {
    const ruled = [versions[0]!, editMetric(versions[1]!, 'tickets_closed', (m) => (m.rule = { type: 'bands', bands: [{ status: 'G', op: '>=', value: 10 }] })), versions[2]!]
    // Only 2026 v1.0 has the new rule, so July changes it back.
    expect(versionBoundaries(ruled, columns, 'tickets_closed').map((m) => [m.index, m.label])).toEqual([
      [2, '2026 v1.0'],
      [8, '2026 v2'],
    ])
    const formula = [versions[0]!, versions[1]!, editMetric(versions[2]!, 'tickets_closed', (m) => (m.formula = 'tickets * 2'))]
    expect(versionBoundaries(formula, columns, 'tickets_closed').map((m) => [m.index, m.label])).toEqual([[8, '2026 v2']])
  })

  it('a change to a measure the formula names counts; other measures do not', () => {
    const other = (v: MethodologyVersion): MethodologyVersion => ({
      ...v,
      content: { ...v.content, measures: v.content.measures.map((m) => (m.key === 'tickets' ? { ...m, timeAgg: 'average' as const } : m)) },
    })
    const changed = [versions[0]!, other(versions[1]!), other(versions[2]!)]
    expect(versionBoundaries(changed, columns, 'tickets_closed').map((m) => m.index)).toEqual([2])
    expect(versionBoundaries(changed, columns, 'on_time').map((m) => m.index)).toEqual([8])
  })

  it('a measure already derived before the change is not news', () => {
    const later = [...versions, editMetric(version('v2026-3', '2026 v3', '2026-M09', ['epics_on_time', 'epics_committed']), 'on_time', (m) => (m.formula = 'epics_on_time / epics_committed'))]
    expect(versionBoundaries(later, columns, 'on_time').map((m) => [m.index, m.label])).toEqual([
      [8, 'From records'],
      [10, '2026 v3'],
    ])
  })

  it('no marker where no version was in force before, and none for drafts', () => {
    const fromJan = [version('v2026', '2026 v1.0', '2026-M01'), version('draft', 'Draft', '2026-M05', [], 'draft')]
    expect(versionBoundaries(fromJan, columns, 'on_time')).toEqual([])
  })

  it('is empty when the view is restated under one version', () => {
    expect(versionBoundaries(versions, columns, 'on_time', 'v2026')).toEqual([])
  })

  it('works on coarse columns: the quarter whose last month runs under the new version', () => {
    const quarters = coarseColumns('2026-M10', 'quarter', 4, 1)
    expect(versionBoundaries(versions, quarters, 'on_time').map((m) => [quarters[m.index]!.label, m.label])).toEqual([['Q3', 'From records']])
  })
})
