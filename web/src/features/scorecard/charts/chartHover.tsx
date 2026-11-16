import { Tooltip } from 'recharts'
import type { components } from '../../../api/schema'
import type { Column } from '../columns'
import { chartTheme, type StatusTheme } from './chartTheme'
import type { ChartPoint } from './points'

type StatusLevel = components['schemas']['StatusLevel']

export interface ChartSeries {
  name: string
  color: string
  points: ChartPoint[]
}

export interface ChartHoverCardProps {
  active?: boolean
  /** Recharts' tooltip payload; each entry's `payload` is the hovered datum, which carries its column index `i`. */
  payload?: ReadonlyArray<{ payload?: unknown }>
  columns: Column[]
  series: ChartSeries[]
  scale: StatusLevel[]
  /** A line for a column, by index: `Methodology changed: 2026 v2 from Jul 2026`. */
  notes?: Record<number, string>
}

function valueText(point: ChartPoint): string {
  if (point.kind === 'na') return 'n/a'
  if (point.kind === 'missing') return 'No data'
  return point.display || '—'
}

function statusText(theme: StatusTheme, withLabel: boolean): string {
  return [theme.shape, theme.letter, withLabel ? theme.label : ''].filter(Boolean).join(' ')
}

/**
 * The hover label for one period, pinned at the top of the plot: the bold
 * value, the full period, the status and the change; one line per series
 * when there are several.
 */
export function ChartHoverCard({ active, payload, columns, series, scale, notes }: ChartHoverCardProps) {
  const datum = payload?.[0]?.payload as { i?: unknown } | undefined
  const i = typeof datum?.i === 'number' ? datum.i : -1
  const column = columns[i]
  if (!active || !column) return null
  const single = series.length === 1 ? series[0]!.points[i] : undefined
  const note = notes?.[i]
  return (
    <div data-testid="chart-hover" className="w-max max-w-64 rounded-md bg-ink px-2 py-1.5 text-[11px] leading-4 text-white shadow-md">
      {single ? (
        <>
          <p className="text-[13px] font-semibold tabular-nums">{valueText(single)}</p>
          <p className="text-white/75">{column.fullLabel}</p>
          {single.kind === 'na' && <p>{single.naReason || 'Not applicable'}</p>}
          {single.kind === 'value' && single.status && (
            <p data-testid="hover-status">{statusText(chartTheme(scale, single.status), true)}</p>
          )}
          {single.change && <p className="text-white/75">{single.change}</p>}
          {single.overrideReason && <p>{`† ${single.overrideReason}`}</p>}
        </>
      ) : (
        <>
          <p className="text-white/75">{column.fullLabel}</p>
          <ul className="mt-0.5 space-y-0.5">
            {series.map((s, idx) => {
              const point = s.points[i]
              if (!point) return null
              return (
                <li key={idx} className="flex items-center gap-1.5">
                  <span data-swatch="" className="inline-block size-2 shrink-0 rounded-full ring-1 ring-white/60" style={{ backgroundColor: s.color }} />
                  <span className="text-white/75">{s.name}</span>
                  <span className="font-semibold tabular-nums">{valueText(point)}</span>
                  {point.kind === 'value' && point.status && <span>{statusText(chartTheme(scale, point.status), false)}</span>}
                  {point.overrideReason && <span>†</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {note && <p className="mt-0.5 text-white/75">{note}</p>}
    </div>
  )
}

interface CursorProps {
  /** Line charts: the cursor's top and bottom points. */
  points?: { x: number; y: number }[]
  /** Bar charts: the hovered column's band. */
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A single vertical hairline through the hovered column. */
export function Hairline({ points, x = 0, y = 0, width = 0, height = 0 }: CursorProps) {
  const cx = points?.[0]?.x ?? x + width / 2
  return (
    <line
      data-role="hairline"
      x1={cx}
      x2={cx}
      y1={points?.[0]?.y ?? y}
      y2={points?.[1]?.y ?? y + height}
      stroke="var(--color-ink)"
      strokeOpacity={0.35}
      strokeWidth={1}
      pointerEvents="none"
    />
  )
}

export function hoverTooltip(columns: Column[], series: ChartSeries[], scale: StatusLevel[], animated: boolean, top: number, notes?: Record<number, string>) {
  return (
    <Tooltip
      content={(props) => (
        <ChartHoverCard active={props.active} payload={props.payload} columns={columns} series={series} scale={scale} notes={notes} />
      )}
      // Keep n/a and missing periods, so they still say why there is no value.
      filterNull={false}
      cursor={<Hairline />}
      // Pinned to the top of the plot; it follows the column and flips left near the right edge.
      position={{ y: top }}
      offset={8}
      allowEscapeViewBox={{ x: false, y: true }}
      // Above neighboring tiles, below the sticky control bar (z-10).
      wrapperStyle={{ zIndex: 5, outline: 'none' }}
      isAnimationActive={animated}
      animationDuration={150}
    />
  )
}
