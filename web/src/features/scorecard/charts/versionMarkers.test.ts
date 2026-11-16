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

describe('versionBoundaries', () => {
  it('marks each column where the version in force changes: the version name, or From records when it newly derives a measure of the metric', () => {
    expect(versionBoundaries(versions, columns, 'on_time')).toEqual([
      { index: 2, label: '2026 v1.0', title: 'Methodology changed: 2026 v1.0 from Jan 2026' },
      { index: 8, label: 'From records', title: 'Methodology changed: 2026 v2 from Jul 2026' },
    ])
  })

  it('names the version when the newer one derives no measure of this metric', () => {
    expect(versionBoundaries(versions, columns, 'tickets_closed').map((m) => m.label)).toEqual(['2026 v1.0', '2026 v2'])
  })

  it('a measure already derived before the change is not news', () => {
    const later = [...versions, version('v2026-3', '2026 v3', '2026-M09', ['epics_on_time', 'epics_committed'])]
    expect(versionBoundaries(later, columns, 'on_time').map((m) => [m.index, m.label])).toEqual([
      [2, '2026 v1.0'],
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
    expect(versionBoundaries(versions, quarters, 'on_time').map((m) => [quarters[m.index]!.label, m.label])).toEqual([
      ['Q1', '2026 v1.0'],
      ['Q3', 'From records'],
    ])
  })
})
