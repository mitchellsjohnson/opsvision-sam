import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { useMe, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import type { ViewRequest } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { Footnote } from '../../ui/Footnote'
import { StatusBadge } from '../../ui/StatusBadge'
import { buildColumns, columnRequest } from './columns'
import { overrideSentence } from './format'
import { cellOutcome, currentCell, MetricTile } from './MetricTile'
import { groupRows } from './viewHelpers'

type Schemas = components['schemas']
type ViewRow = Schemas['ViewRow']

/** The row a tile shows for a metric: the shallowest (the selected subject, or the top of the tree). */
function shallowest(rows: ViewRow[]): ViewRow {
  return rows.reduce((best, r) => (r.depth < best.depth ? r : best))
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading charts" aria-busy="true">
      <div className="grid gap-4 motion-safe:animate-pulse sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-44 rounded-lg bg-ink/10" />
        ))}
      </div>
    </div>
  )
}

export interface ChartsTabProps {
  scorecardId: string
}

/** The executive view: one tile per metric, grouped by category, with a status summary on top. */
export function ChartsTab({ scorecardId }: ChartsTabProps) {
  const [period] = usePeriodState()
  const [params] = useSearchParams()
  const me = useMe()
  const versions = useVersions(scorecardId)
  const fy = period.fiscalYearStartMonth

  // The same columns the table uses for this grain, without the YTD column: tiles show the period itself.
  const columns = useMemo(() => buildColumns(period.period, false, fy), [period.period, fy])
  const request: ViewRequest = { ...columnRequest(columns) }
  if (period.subjects.length > 0) request.subjects = period.subjects
  const view = useView(period.ready ? scorecardId : undefined, request)

  const scale = me.data?.tenant?.statusScale ?? []
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  const tableLink = (metricKey: string) => {
    const next = new URLSearchParams(params)
    next.delete('tab')
    const search = next.size > 0 ? `?${next.toString()}` : ''
    return { pathname: '../table', search, hash: `#metric-${metricKey}` }
  }

  if (view.isPending) return <Skeleton />
  if (view.isError) {
    return (
      <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        <p className="font-medium text-status-r">Could not load the charts: {view.error.message}</p>
        <button
          type="button"
          onClick={() => void view.refetch()}
          className="mt-3 rounded-md border border-ink/40 bg-white px-3 py-1.5 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    )
  }
  if (view.data.rows.length === 0) {
    return <p className="text-sm text-ink/80">No results for this selection.</p>
  }

  const groups = groupRows(view.data).map((g) => ({
    ...g,
    tiles: g.metrics.map((m) => {
      const row = shallowest(m.rows)
      const cell = currentCell(row, columns)
      const metric = versions.data?.versions
        .find((v) => v.id === cell?.versionId)
        ?.content.metrics.find((x) => x.key === row.metricKey)
      return { row, cell, metric }
    }),
  }))
  const tiles = groups.flatMap((g) => g.tiles)

  // Counts of the selected period across the shown tiles: each scale level, then not applicable and no data.
  const counts = new Map<string, number>(scale.map((s) => [s.key, 0]))
  let notApplicable = 0
  let noData = 0
  for (const { cell } of tiles) {
    const outcome = cellOutcome(cell)
    if (outcome === 'na') notApplicable++
    else if (outcome === 'missing') noData++
    else if (cell) counts.set(cell.status, (counts.get(cell.status) ?? 0) + 1)
  }

  const notes = tiles.flatMap(({ row, cell }) =>
    cell?.override
      ? [{ id: `note-${row.metricKey}`, where: `${row.metricName}, ${row.subjectName}`, text: overrideSentence(cell.override) }]
      : [],
  )

  return (
    <div>
      <section aria-label="Status summary">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {[...counts].map(([key, n]) => (
            <li key={key} className="flex items-center gap-2">
              <StatusBadge status={key} label={statusLabel(key)} />
              <span>{statusLabel(key) ?? key}</span>
              <span className="font-semibold">{n}</span>
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span>Not applicable</span>
            <span className="font-semibold">{notApplicable}</span>
          </li>
          <li className="flex items-center gap-2">
            <span>No data</span>
            <span className="font-semibold">{noData}</span>
          </li>
        </ul>
      </section>

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`category-${g.id}`} className="mt-6">
          <h2 id={`category-${g.id}`} className="text-lg font-semibold text-accent-deep">
            {g.name}
          </h2>
          <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.tiles.map(({ row, metric }) => (
              <li key={row.metricKey}>
                <MetricTile
                  row={row}
                  columns={columns}
                  metric={metric}
                  fiscalYearStartMonth={fy}
                  statusLabel={statusLabel}
                  to={tableLink(row.metricKey)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {notes.length > 0 && (
        <section aria-label="Override notes" className="mt-6 space-y-1">
          {notes.map((n) => (
            <Footnote key={n.id} id={n.id} marker="†">
              <span className="font-medium">{n.where}: </span>
              <span>{n.text}</span>
            </Footnote>
          ))}
        </section>
      )}
    </div>
  )
}
