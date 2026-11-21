import type { MetricSummary } from '../../api/queries'

const DEFAULT_LABELS: Record<string, string> = { G: 'Green', Y: 'Yellow', R: 'Red' }

/**
 * What a reader needs after the value: for a metric with no company value,
 * `worst {item}` (its value is the one shown); else the standing's headline
 * without the threshold it restates (`138 above the Green line`).
 */
export function standingLine(s: Pick<MetricSummary, 'standing'>): string {
  const { headline, display } = s.standing
  const worst = headline.indexOf(' · worst ')
  if (worst >= 0) {
    const rest = headline.slice(worst + ' · '.length)
    return display && rest.endsWith(` ${display}`) ? rest.slice(0, -display.length - 1) : rest
  }
  return headline.replace(/\s+\([^)]*\)$/, '')
}

/**
 * `Copy reminder` (spec §10.5): the month's missing exec summaries as plain
 * text for chat, one line each, then a link to the Exec summaries view.
 * Items that are not missing are left out.
 */
export function reminderText(
  items: MetricSummary[],
  url: string,
  periodLabel: string,
  statusLabel: (key: string) => string = (k) => DEFAULT_LABELS[k] ?? k,
): string {
  const missing = items.filter((s) => s.state === 'missing')
  const lines = missing.map((s) => {
    const value = [s.standing.display, s.standing.status ? statusLabel(s.standing.status) : ''].filter(Boolean).join(' ')
    return `- ${[s.metricName, value, standingLine(s)].filter(Boolean).join(' · ')}`
  })
  return [`Exec summaries needed for ${periodLabel} (${missing.length}), required to publish:`, ...lines, url].join('\n')
}
