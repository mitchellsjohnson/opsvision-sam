import type { components } from '../../../api/schema'
import { StatusMarker } from './chartParts'
import { chartTheme } from './chartTheme'
import type { ChartPoint } from './points'

export function LetteredChips({ points, scale }: { points: ChartPoint[]; scale: components['schemas']['StatusLevel'][] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {points.map((p) => {
        const theme = chartTheme(scale, p.status)
        return (
          <span key={p.key} className="inline-flex items-center gap-1 rounded border border-ink/20 px-2 py-1 text-xs">
            <span className="text-ink/70">{p.label}</span>
            {p.kind === 'na' ? (
              <span>n/a</span>
            ) : p.kind === 'missing' ? (
              <span className="text-ink/60">no data</span>
            ) : (
              <>
                <span>{p.display}</span>
                <StatusMarker theme={theme} />
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}
