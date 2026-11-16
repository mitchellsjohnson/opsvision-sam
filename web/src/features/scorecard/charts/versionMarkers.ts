import { useMemo } from 'react'
import { useParams } from 'react-router'
import { useVersions } from '../../../api/queries'
import type { components } from '../../../api/schema'
import { usePeriodState } from '../../../shell/usePeriodState'
import type { Column } from '../columns'
import { versionInForce } from '../viewRequest'

type MethodologyVersion = components['schemas']['MethodologyVersion']

/** A methodology change at column `index`: the line's short label and its hover text. */
export interface VersionMarker {
  index: number
  /** `From records`, or the version name. */
  label: string
  /** `Methodology changed: 2026 v2 from Jul 2026`. */
  title: string
}

/** The measures named in a metric's formula that the version derives from records. */
function derivedMeasures(version: MethodologyVersion, metricKey: string): Set<string> {
  const formula = version.content.metrics.find((m) => m.key === metricKey)?.formula ?? ''
  const names = new Set(formula.match(/[A-Za-z_]\w*/g) ?? [])
  return new Set(version.content.measures.filter((m) => m.source === 'derived' && names.has(m.key)).map((m) => m.key))
}

/**
 * Where the published version in force changes between adjacent columns
 * (§7.2). The label is `From records` when the newer version derives a
 * measure of the metric that the older one did not, else the version's name.
 * A column with no version before it is not a change, and a view restated
 * under one version has none.
 */
export function versionBoundaries(versions: MethodologyVersion[], columns: Column[], metricKey: string, restate = ''): VersionMarker[] {
  if (restate !== '') return []
  const inForce = columns.map((c) => versionInForce(versions, c.period, ''))
  const markers: VersionMarker[] = []
  for (let i = 1; i < columns.length; i++) {
    const before = inForce[i - 1]
    const after = inForce[i]
    if (!before || !after || before.id === after.id) continue
    const was = derivedMeasures(before, metricKey)
    const fromRecords = [...derivedMeasures(after, metricKey)].some((m) => !was.has(m))
    markers.push({
      index: i,
      label: fromRecords ? 'From records' : after.name,
      title: `Methodology changed: ${after.name} from ${columns[i]!.fullLabel}`,
    })
  }
  return markers
}

/** The methodology markers for a metric's chart over `columns`; none while the versions load or when the view is restated. */
export function useVersionMarkers(columns: Column[], metricKey: string): VersionMarker[] {
  const { sc } = useParams()
  const [period] = usePeriodState()
  const versions = useVersions(sc)
  const list = versions.data?.versions
  return useMemo(() => versionBoundaries(list ?? [], columns, metricKey, period.restate), [list, columns, metricKey, period.restate])
}
