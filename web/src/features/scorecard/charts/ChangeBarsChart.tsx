import type { components } from '../../../api/schema'
import { useElementWidth } from '../../../ui/useElementWidth'
import type { ChartSize } from './chartParts'
import { barFill, chartTheme } from './chartTheme'
import { changeLabelTop, changeScale, keptLabels, SIDE_LABEL, worseText, type ChangeBar } from './changeBars'

type StatusLevel = components['schemas']['StatusLevel']

const HEIGHT: Record<ChartSize, number> = { tile: 64, focus: 120 }
/**
 * The change that set each period's status (§9): up for worse, down for
 * better, from a zero line, filled by the status it earned, with the Red
 * boundary dashed and labelled at the right. Decorative: the chart summary
 * names the changes, and the ribbon below carries the letters.
 */
export function ChangeBars({
  bars,
  scale,
  size,
  inset,
  edges,
  red,
  caption,
}: {
  bars: ChangeBar[]
  scale: StatusLevel[]
  size: ChartSize
  /** The plot's left and right offsets, so each bar sits over its ribbon cell. */
  inset: { left: number; right: number }
  /** The rule's band edges in worse terms (focus ticks). */
  edges: number[]
  /** The Red boundary in worse terms. */
  red: number | null
  caption: string
}) {
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const height = HEIGHT[size]
  const values = bars.flatMap((b) => (b.worse === null ? [] : [b.worse]))
  const y = changeScale(height, values, red, size === 'focus')
  const zero = y(0)
  const redY = red !== null && red > 0 ? y(red) : null
  const worst = Math.max(...scale.map((s) => s.rank))
  const best = Math.min(...scale.map((s) => s.rank))
  const redColor = chartTheme(scale, scale.find((s) => s.rank === worst)?.key ?? 'R').color
  // `worse` and `better` hold the top and bottom slots, then the Red boundary's label; a tick within 12px of one kept would print over it.
  const slots = [SIDE_LABEL / 2, height - SIDE_LABEL / 2]
  const ticks = (size === 'focus' ? [...new Set([...(red !== null ? [red] : []), 0, ...edges])] : red !== null ? [red] : []).reduce<number[]>(
    (kept, t) => ([...slots, ...kept.map(y)].every((c) => Math.abs(c - y(t)) >= SIDE_LABEL) ? [...kept, t] : kept),
    [],
  )
  const side = 'absolute left-full pl-1 text-[10px] leading-3 whitespace-nowrap text-ink/70'
  const rankOf = (status: string) => scale.find((s) => s.key === status)?.rank
  const kept = keptLabels(
    bars.flatMap((b, index) => {
      const rank = rankOf(b.status)
      return b.worse !== null && rank !== undefined && rank > best ? [{ index, rank, text: worseText(b.worse) }] : []
    }),
    width / Math.max(bars.length, 1),
    bars.length,
  )
  return (
    <div data-testid="change-bars" aria-hidden="true" className="mt-1">
      <p className="text-[11px] leading-4 text-ink/70" style={{ marginLeft: inset.left }}>
        {caption}
      </p>
      <div ref={measure} data-role="change-plot" className="relative" style={{ height, marginLeft: inset.left, marginRight: inset.right }}>
        <div data-role="zero-line" className="absolute inset-x-0 border-t border-ink/55" style={{ top: zero }} />
        {redY !== null && <div data-role="red-line" className="absolute inset-x-0 border-t border-dashed" style={{ top: redY, borderColor: redColor }} />}
        {ticks.map((t) => (
          <span key={t} data-role="side-label" className={side} style={{ top: y(t) - SIDE_LABEL / 2 }}>
            {worseText(t)}
          </span>
        ))}
        <span data-role="side-label" className={side} style={{ top: 0 }}>
          worse
        </span>
        <span data-role="side-label" className={side} style={{ top: height - SIDE_LABEL }}>
          better
        </span>
        <div className="absolute inset-0 flex gap-px">
          {bars.map((b, index) => {
            const { fill, stroke } = barFill(scale, b.status)
            const up = b.worse !== null && b.worse > 0
            const top = b.worse === null ? zero : Math.min(zero, y(b.worse))
            const barHeight = b.worse === null ? 0 : Math.max(Math.abs(y(b.worse) - zero), 1)
            const labelled = kept.has(index)
            const edge = index === 0 ? 'left-0 text-left' : index === bars.length - 1 ? 'right-0 text-right' : 'inset-x-0 text-center'
            return (
              <div key={b.key} data-key={b.key} className="relative min-w-0 flex-1">
                {b.worse !== null && (
                  <div
                    data-role="change-bar"
                    data-status={b.status}
                    data-direction={up ? 'up' : 'down'}
                    className="absolute inset-x-[18%] rounded-[1px]"
                    style={{ top, height: barHeight, backgroundColor: fill, boxShadow: `inset 0 0 0 1px ${stroke}` }}
                  />
                )}
                {labelled && (
                  <span
                    data-role="change-label"
                    className={`absolute ${edge} text-[10px] leading-3 font-semibold whitespace-nowrap text-ink tabular-nums`}
                    style={up ? { top: changeLabelTop(top, redY) } : { top: top + barHeight + 1 }}
                  >
                    {worseText(b.worse!)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
