import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import { cellKey } from '../viewHelpers'
import { StatusMarker } from './chartParts'
import { chartTheme } from './chartTheme'

type ViewRow = components['schemas']['ViewRow']

export function UptimeRows({
  childRows,
  columns,
  currentColumnKey,
  scale,
}: {
  childRows: ViewRow[]
  columns: Column[]
  currentColumnKey: string
  scale: components['schemas']['StatusLevel'][]
}) {
  return (
    <ul className="space-y-2 text-sm">
      {childRows.map((child) => {
        const cell = child.cells.find((c) => cellKey(c) === currentColumnKey)
        const theme = chartTheme(scale, cell?.status ?? '')
        const statuses = columns.map((col) => child.cells.find((c) => cellKey(c) === col.key))
        return (
          <li key={child.subjectId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-24">{child.subjectName}</span>
            <span className="flex flex-wrap gap-0.5" data-testid={`uptime-strip-${child.subjectId}`}>
              {statuses.map((c, i) => {
                const col = columns[i]!
                const status = c?.status && c.naReason === '' ? c.status : ''
                const label = !c
                  ? `${col.fullLabel}: no data`
                  : c.naReason
                    ? `${col.fullLabel}: not applicable, ${c.naReason}`
                    : `${col.fullLabel}: ${c.display || 'no data'}${status ? `, status ${status}` : ''}`
                return (
                  <span key={col.key} role="img" aria-label={label}>
                    <StatusMarker theme={chartTheme(scale, status)} />
                  </span>
                )
              })}
            </span>
            <span className="flex items-center gap-2">
              <StatusMarker theme={theme} />
              <span className="font-medium tabular-nums">{cell?.display || '—'}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
