import clsx from 'clsx'
import { useMemo } from 'react'
import type { components } from '../../../api/schema'
import { parsePeriod } from '../../../lib/period'
import { ItemName, StatusCell, StatusChip, type StatusLevel } from '../../../ui/status'
import { textWidth, uiFont, useFontsReady } from '../../../ui/textWidth'
import { useElementWidth } from '../../../ui/useElementWidth'
import { chartTheme } from '../charts/chartTheme'
import { endOrdinal, type Column } from '../columns'
import { metricStandings, type MetricStanding } from '../logic/standings'
import { cellReported, type StatusScaleEntry } from '../logic/statusAtScope'
import { buildBoardRow, type BoardCell } from '../logic/statusBoard'
import { cellKey } from '../viewHelpers'
import { metricValue, NOT_IN_REVISION, type ReportMetric, type ReportModel } from './model'

type ScorecardView = components['schemas']['ScorecardView']

/** Below the top bar and the control bar, whichever stay on screen (both publish 0px when they scroll away). */
const STICKY_TOP = 'calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))'
const STICKY_CELL = 'sticky z-10 border-b border-ink/10 bg-white px-0 pb-1 pt-1.5'
const MONTHS_GRID = 'grid grid-cols-6 gap-[3px]'
const CAPTION = 'mt-0.5 min-w-0 text-[11px] leading-4 text-ink/70'
const ITEM_CAPTION = clsx(CAPTION, 'flex justify-end whitespace-nowrap')

export interface ReportStatusListProps {
  model: ReportModel
  scale: StatusLevel[]
  /**
   * The view the report counts from, at its scope: the revision's `standing`,
   * the Overview's view for a live report, or else the report's own view.
   * A coarse metric's periods are only there.
   */
  counted: ScorecardView
  fiscalYearStartMonth: number
}

type Caption = { text: string } | { worst: string; rest: string } | null

interface Line {
  metric: ReportMetric
  cells: BoardCell[]
  caption: Caption
  /** The months' values for a screen reader: `Jun 2026: 88% Green; …`. */
  spoken: string
}

/** A chip whose status is spoken in words; the shape and letter are for the eye. */
export function SpokenChip({ status, scale, size = 'md' }: { status: string; scale: StatusLevel[]; size?: 'md' | 'lg' }) {
  return (
    <>
      <span aria-hidden="true" className="inline-flex">
        <StatusChip status={status} scale={scale} size={size} />
      </span>
      <span className="sr-only">{chartTheme(scale, status).label || status}</span>
    </>
  )
}

function spokenCell(cell: BoardCell, label: (key: string) => string): string {
  if (cell.kind === 'status') {
    const detail = cell.display ? `${cell.display} ${label(cell.status)}` : label(cell.status)
    return !cell.display && cell.caption ? `${detail}, ${cell.caption}` : detail
  }
  if (cell.kind === 'unrated') return `${cell.display}, not rated`
  if (cell.kind === 'na') return cell.naReason ? `Not applicable, ${cell.naReason}` : 'Not applicable'
  return 'No data'
}

/** `Q3 FY2026 · Q4 due by Jan`: the counted period and the next one due, from the standing's quiet line. */
function coarseCaption(standing: MetricStanding): string | null {
  const quiet = standing.status?.quiet
  const prefix = `${standing.head.metricName} (`
  if (!quiet?.startsWith(prefix) || !quiet.endsWith(')')) return null
  return quiet.slice(prefix.length, -1).replace('; ', ' · ')
}

function captionOf(metric: ReportMetric, standing: MetricStanding | undefined, label: (key: string) => string): Caption {
  if (!metric.status) {
    const text = standing?.status?.notReported?.text
    return text ? { text } : null
  }
  if (standing && standing.coarse.length > 0) {
    const text = coarseCaption(standing) ?? metric.caption
    return text ? { text } : null
  }
  if (metric.worst) {
    if (!standing?.status) return { worst: metric.worst.name, rest: metric.caption }
    const key = standing.status.counted.key
    const count = standing.children.filter((ch) => {
      const c = ch.cells.find((x) => cellKey(x) === key)
      return cellReported(c) && c?.status === metric.status
    }).length
    return { worst: metric.worst.name, rest: `${count} of ${standing.children.length} ${label(metric.status)}` }
  }
  if (metric.ytd) return { text: `YTD ${metric.ytd}` }
  return metric.caption ? { text: metric.caption } : null
}

function lineOf(
  metric: ReportMetric,
  standing: MetricStanding | undefined,
  months: Column[],
  entries: StatusScaleEntry[],
  fy: number,
  label: (key: string) => string,
): Line {
  const blank = { status: '', display: '', naReason: '', change: null, caption: '' }
  // Not counted in this revision: it has no period here to draw.
  if (metric.display === NOT_IN_REVISION) {
    return { metric, cells: months.map((m) => ({ ...blank, key: m.key, kind: 'notDue' })), caption: null, spoken: '' }
  }
  const cells: BoardCell[] = standing
    ? buildBoardRow({
        key: standing.key,
        category: standing.category,
        scope: standing.scope,
        head: standing.head,
        children: standing.children,
        noun: standing.noun,
        columns: months,
        scale: entries,
        fyStart: fy,
        coarse: standing.coarse,
      }).cells
    : months.map((m) => ({ ...blank, key: m.key, kind: 'missing' }))
  // A coarse period is spoken by its own name, in the month that closes it.
  const coarseByEnd = new Map((standing?.coarse ?? []).map((c) => [endOrdinal(parsePeriod(c.period)!), c]))
  const spoken = months
    .flatMap((m, i) => {
      const cell = cells[i]!
      if (cell.kind === 'notDue') return []
      const p = parsePeriod(m.period)
      const at = (p && coarseByEnd.get(endOrdinal(p))) || m
      return [`${at.fullLabel}: ${spokenCell(cell, label)}`]
    })
    .join('; ')
  return { metric, cells, caption: captionOf(metric, standing, label), spoken }
}

/** `◆ 1 Red · ▲ 1 Yellow`: a category's statuses other than the best, worst first. */
function categoryTally(metrics: ReportMetric[], scale: StatusLevel[]): { key: string; label: string; count: number }[] {
  const best = Math.min(...scale.map((s) => s.rank))
  return [...scale]
    .filter((s) => s.rank !== best)
    .sort((a, b) => b.rank - a.rank)
    .map((s) => ({ key: s.key, label: s.label || s.key, count: metrics.filter((m) => m.status === s.key).length }))
    .filter((t) => t.count > 0)
}

/**
 * The scorecard table on phones (§13.2): a two-column status table, one row
 * per metric. The metric's name heads the row; one cell holds its value and
 * chip, a caption, the six months as decorative cells and the months' values
 * for a screen reader.
 */
export function ReportStatusList({ model, scale, counted, fiscalYearStartMonth: fy }: ReportStatusListProps) {
  const months = useMemo(() => model.columns.filter((c) => !c.ytd).slice(-6), [model.columns])
  const groups = useMemo(() => {
    const entries = scale.map((s) => ({ key: s.key, rank: s.rank }))
    const label = (key: string) => scale.find((s) => s.key === key)?.label || key
    const byKey = new Map(metricStandings({ view: counted, period: model.period, fy, scale: entries }).metrics.map((m) => [m.key, m]))
    return model.categories.map((c) => ({
      ...c,
      tally: categoryTally(c.metrics, scale),
      lines: c.metrics.map((m) => lineOf(m, byKey.get(m.key), months, entries, fy, label)),
    }))
  }, [model.categories, model.period, counted, fy, months, scale])

  // The value column's width, measured on its header; 0 until measured (and in tests), when every caption takes one line.
  const [columnRef, columnWidth] = useElementWidth<HTMLTableCellElement>()
  const fontsReady = useFontsReady()
  const fits = (text: string) => columnWidth === 0 || !fontsReady || textWidth(text, uiFont(400, 11)) <= columnWidth

  const first = months[0]?.fullLabel ?? ''
  const last = months.at(-1)?.fullLabel ?? ''
  return (
    <div className="mt-3 rounded-lg border border-ink/20 bg-white px-3 pb-2">
      <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{`${model.scorecardName}, ${first} – ${last}, ${model.scopeLabel}`}</caption>
        <colgroup>
          <col className="w-[38%]" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <td className={STICKY_CELL} style={{ top: STICKY_TOP }} />
            <th ref={columnRef} scope="col" className={STICKY_CELL} style={{ top: STICKY_TOP }}>
              <span className="sr-only">{`Value, ${first} to ${last}`}</span>
              <span aria-hidden="true" className={clsx(MONTHS_GRID, 'text-center text-[11px] leading-4 font-medium text-ink/70')}>
                {months.map((m) => (
                  <span key={m.key} data-month="" className={clsx(m.period === model.period && 'font-semibold text-accent-deep')}>
                    {m.label}
                  </span>
                ))}
              </span>
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.id}>
            <tr>
              <th
                scope="rowgroup"
                colSpan={2}
                className="px-0 pb-0.5 pt-3 text-left text-[11px] leading-4 font-semibold uppercase text-ink/70"
              >
                {g.name}
                {g.tally.map((t) => (
                  <span key={t.key}>
                    {' · '}
                    <span aria-hidden="true">{chartTheme(scale, t.key).shape}</span> {t.count} {t.label}
                  </span>
                ))}
              </th>
            </tr>
            {g.lines.map(({ metric, cells, caption, spoken }) => {
              const value = metricValue(metric) || '—'
              return (
                <tr key={metric.key}>
                  <th scope="row" className="border-b border-ink/10 py-2 pr-2 text-left align-top font-semibold break-words">
                    {metric.name}
                  </th>
                  <td className="min-w-0 border-b border-ink/10 py-2 align-top">
                    <div className="flex items-center justify-end gap-1.5">
                      <span
                        className={clsx(
                          'tabular-nums',
                          metric.display === NOT_IN_REVISION ? 'text-xs text-ink/80' : 'font-semibold',
                        )}
                      >
                        {value}
                      </span>
                      {metric.status && <SpokenChip status={metric.status} scale={scale} />}
                    </div>
                    {caption &&
                      ('text' in caption ? (
                        <div data-caption="" className={clsx(CAPTION, 'text-right break-words')}>
                          {caption.text}
                        </div>
                      ) : fits(`${caption.worst} · ${caption.rest}`) ? (
                        <div data-caption="" className={ITEM_CAPTION}>
                          <ItemName name={caption.worst} className="min-w-0" />
                          {caption.rest && <span className="shrink-0 whitespace-pre">{` · ${caption.rest}`}</span>}
                        </div>
                      ) : (
                        // Too long for one line: the item's name gets the line, so its distinguishing part shows.
                        <div data-caption="" className={clsx(ITEM_CAPTION, 'flex-col items-end')}>
                          <ItemName name={caption.worst} className="min-w-0" />
                          {caption.rest && <span>{caption.rest}</span>}
                        </div>
                      ))}
                    <div className={clsx(MONTHS_GRID, 'mt-1.5')}>
                      {cells.map((c) => (
                        <StatusCell key={c.key} cell={c} name="" scale={scale} decorative />
                      ))}
                    </div>
                    {spoken && <span className="sr-only">{spoken}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        ))}
      </table>
    </div>
  )
}
