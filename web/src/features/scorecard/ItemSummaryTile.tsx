import clsx from 'clsx'
import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router'
import type { components } from '../../api/schema'
import { HATCH, ItemName, StatusCell, StatusChip, UNRATED_CLASS, type StatusLevel } from '../../ui/status'
import { textWidth, uiFont, useFontsReady } from '../../ui/textWidth'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme, statusFill } from './charts/chartTheme'
import type { Column } from './columns'
import { groupItems, itemSummary, labelsNeedYear, lastReportedLabel, tileExceptions, type ItemRow } from './logic/itemGrid'
import { CELL_MIN, itemGridLayout } from './logic/itemGridLayout'
import type { SummaryDisplay } from '../rca/rcaState'
import { WhyButton } from '../rca/WhyButton'
import { countNoun, type NounForms } from './logic/nouns'
import { columnUnit, sinceText, thresholdText } from './logic/statusText'
import { TileFrame } from './TileFrame'

type ViewRow = components['schemas']['ViewRow']
type Direction = components['schemas']['Direction']
type StatusRule = components['schemas']['StatusRule']

/** Rows pad 6px each side inside the tile. */
const ROW_PAD = 12
const MAX_ROWS = 5
/** Tiles narrower than this (phones) stack each row: name and value, the cells below. A half-width tile at 1024 is 398px. */
const STACK_BELOW = 360
/** The name column's floor before the tile gives up months for it. */
const NAME_FLOOR = 200
/** A tile too wide to stack may give its name this little room, so 6 months still fit beside it. */
const NAME_FLOOR_MIN = 140
const INLINE_MONTHS = 6

/** A stopped row's value: `Last Sep`; with the year when the window's labels need it (`labelsNeedYear`). */
function lastText(r: ItemRow, long: boolean): string {
  return r.lastReported ? `Last ${long ? r.lastReported.fullLabel : r.lastReported.label}` : ''
}

export interface ItemSummaryTileProps {
  /** The metric's head row: its name, format and kind. */
  head: ViewRow
  /** Every item, reported or not. */
  rows: ItemRow[]
  /** The trend window; the last is the selected period. */
  columns: Column[]
  scale: StatusLevel[]
  direction: Direction
  noun: NounForms
  /** The metric's rule in force, with any per-item bands. */
  rule: StatusRule | undefined
  onExpand: (trigger: HTMLElement) => void
  /** Opens the dialog drilled into one item; `trigger` gets focus back on close. */
  onOpenItem: (itemId: string, trigger: HTMLElement) => void
  /**
   * The company's exec summary state for the selected period, at company
   * scope: the footer leads with `Summary: …`, or for admins `Exec summary
   * needed ›` linking `href` (the Exec summaries view at this metric).
   */
  summary?: { display: SummaryDisplay; href: string; onOpen: (el: HTMLElement) => void } | null
}

function segmentStyle(scale: StatusLevel[], key: string): CSSProperties {
  if (key === 'none') return { ...HATCH, backgroundColor: 'white', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 15%, transparent)' }
  if (key === 'unrated') return {}
  if (key === 'na') return { backgroundColor: 'var(--color-status-na-bg)', boxShadow: 'inset 0 0 0 1px var(--color-status-na)' }
  const fill = statusFill(scale, key)
  const color = scale.find((s) => s.key === key)?.color ?? 'var(--color-ink)'
  if (fill.tier === 'solid') return { backgroundColor: fill.background }
  const edge = fill.tier === 'outline' ? (fill.border ?? color) : `color-mix(in srgb, ${color} 25%, transparent)`
  return { backgroundColor: fill.background, boxShadow: `inset 0 0 0 1px ${edge}` }
}

/**
 * An item metric's tile (§6.4, §3.1): the worst item and since when, how the
 * items are spread across statuses, then the exceptions first, one button per
 * item (not at the best status, then those that stopped reporting inside the
 * shown months), at most five, and a line counting what has no row. Names come
 * before months: a tile too narrow for 12 months beside a 200px name shows
 * the latest 6.
 */
export function ItemSummaryTile({ head, rows, columns, scale, direction, noun, rule, onExpand, onOpenItem, summary: standing }: ItemSummaryTileProps) {
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label
  const byRank = [...scale].sort((a, b) => a.rank - b.rank)
  const best = byRank[0]
  const bestLabel = best?.label || best?.key || ''
  const selected = columns[columns.length - 1]
  const unit = columnUnit(selected, 1)

  const long = labelsNeedYear(columns)
  const fontsReady = useFontsReady()

  const summary = itemSummary(rows, scale)
  const unrated = rows.filter((r) => r.reported && !r.status).length

  const ownTargets = (rule?.perSubject ?? []).flatMap((p) => {
    const band = p.bands.find((b) => b.status === best?.key && b.op !== '')
    return band ? [{ name: rows.find((r) => r.id === p.subjectId)?.name ?? p.subjectId, value: band.value }] : []
  })
  const ruleText = rule
    ? thresholdText(rule, {
        format: head.format,
        direction,
        chartKind: head.chartKind,
        frequency: head.frequency,
        statusLabel,
        perSubject: ownTargets,
        noun,
        items: true,
        surface: 'tile',
      })
    : ''
  const threshold = [countNoun(summary.total, noun), ruleText].filter(Boolean).join(' · ')

  const worst = summary.worst
  const since = worst ? sinceText(worst.cells, worst.cells.length - 1, columns, statusLabel) : ''

  // Best first in words; worst first in the bar, as Health draws it.
  const parts: { key: string; text: string; spoken?: string }[] = [
    ...byRank.flatMap((s) => {
      const n = summary.counts.get(s.key) ?? 0
      return n > 0 ? [{ key: s.key, text: `${n} ${s.label || s.key}` }] : []
    }),
    ...(unrated > 0 ? [{ key: 'unrated', text: `${unrated} not rated` }] : []),
    ...(summary.notReported > 0 ? [{ key: 'none', text: `${summary.notReported} not reported` }] : []),
    ...(summary.notApplicable > 0
      ? [{ key: 'na', text: `${summary.notApplicable} n/a`, spoken: `${summary.notApplicable} not applicable` }]
      : []),
  ]
  const barParts = [...byRank]
    .reverse()
    .map((s) => ({ key: s.key, n: summary.counts.get(s.key) ?? 0 }))
    .concat([
      { key: 'unrated', n: unrated },
      { key: 'none', n: summary.notReported },
      { key: 'na', n: summary.notApplicable },
    ])
    .filter((p) => p.n > 0)

  // Measured from every row the tile could show, before the columns decide which do; again once web fonts load.
  const bestKey = best?.key
  const needs = useMemo(() => {
    const g = groupItems(rows, columns, 'worst', direction, scale)
    const candidates = [...g.reported.filter((r) => r.status !== bestKey), ...g.notReported]
    const valueOf = (r: ItemRow) =>
      r.reported ? textWidth(r.display, uiFont(600, 12)) : textWidth(lastText(r, long), uiFont(400, 11))
    return {
      name: Math.max(0, ...candidates.map((r) => textWidth(r.name, uiFont(500, 12)))) + 8,
      group: 0,
      value: Math.max(56, ...candidates.map((r) => valueOf(r) + 12)),
      extra: 0,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fontsReady` asks for a new measurement.
  }, [rows, columns, direction, scale, bestKey, long, fontsReady])
  const inner = width > 0 ? width - ROW_PAD : 0
  const layout = itemGridLayout(inner, columns.length, needs, {
    nameFloor: Math.max(NAME_FLOOR_MIN, Math.min(NAME_FLOOR, inner - INLINE_MONTHS * CELL_MIN - needs.value)),
    stackBelow: STACK_BELOW - ROW_PAD,
  })
  const offset = columns.length - layout.count
  const shownColumns = columns.slice(offset)
  const ex = tileExceptions(rows, { columns, offset, scale, direction, max: MAX_ROWS })
  const inlineColumns = `${layout.nameWidth}px ${layout.count * layout.cellWidth}px ${layout.valueWidth}px`
  const cellsStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${layout.count}, ${layout.cellWidth}px)`,
    width: layout.count * layout.cellWidth,
  }

  const rowName = (r: ItemRow) => {
    if (r.reported) return `Open ${r.name} trend: ${r.display}, ${r.status ? (statusLabel(r.status) ?? r.status) : 'not rated'}`
    if (r.current.kind === 'na') return `Open ${r.name} trend: not applicable this ${unit}${r.current.naReason ? `, ${r.current.naReason}` : ''}`
    const last = r.lastReported
      ? `last ${[lastReportedLabel(r.lastReported, columns), r.lastReported.display].filter(Boolean).join(' ')}`
      : `no reports in ${columns.length} ${columnUnit(selected, columns.length)}`
    return `Open ${r.name} trend: not reported this ${unit}, ${last}`
  }

  const rest = [
    summary.best > 0 && summary.best === summary.total ? (
      <span key="best">
        All <strong className="font-semibold">{summary.total}</strong> {summary.total === 1 ? noun.one : noun.many} {bestLabel}
      </span>
    ) : summary.best > 0 ? (
      <span key="best">
        All other <strong className="font-semibold">{summary.best}</strong> {summary.best === 1 ? noun.one : noun.many} {bestLabel}
      </span>
    ) : null,
    ex.hiddenWorse > 0 ? <span key="worse">{ex.hiddenWorse} more below {bestLabel}</span> : null,
    ex.hiddenStopped > 0 ? <span key="stopped">{ex.hiddenStopped} more stopped reporting</span> : null,
    ex.stoppedBefore > 0 ? (
      <span key="before">
        {ex.stoppedBefore} stopped before {ex.stoppedBeforeLabel}
      </span>
    ) : null,
    ex.silent > 0 ? (
      <span key="silent">
        {ex.silent} with no reports in {columns.length} {columnUnit(selected, columns.length)}
      </span>
    ) : null,
  ].filter((x) => x !== null)

  const value = worst ? (
    <span data-testid="item-tile-worst" className="contents">
      <span className="text-xs text-ink/70">Worst</span>
      <span className="text-base font-semibold">{worst.name}</span>
      <span className="text-[28px] font-semibold leading-9 tabular-nums">{worst.display}</span>
      {worst.status && (
        <span role="img" aria-label={statusLabel(worst.status) ?? worst.status} className="inline-flex self-center">
          <StatusChip status={worst.status} scale={scale} size="lg" />
        </span>
      )}
    </span>
  ) : (
    <span data-testid="item-tile-worst" className="text-sm text-ink/70">
      No {noun.many} reported for {selected?.fullLabel ?? ''}
    </span>
  )

  return (
    <TileFrame
      head={head}
      threshold={threshold}
      value={value}
      extras={since || undefined}
      onExpand={onExpand}
      state="normal"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 max-w-full items-center gap-x-3">
            {standing?.display.state === 'missing' && standing.display.canEdit ? (
              <Link to={standing.href} className="shrink-0 text-xs font-semibold text-status-r hover:underline">
                Exec summary needed <span aria-hidden="true">›</span>
              </Link>
            ) : standing ? (
              <WhyButton
                summary={standing.display}
                attribution
                subjectName={head.metricName}
                valueDisplay={worst?.display ?? ''}
                periodLabel={selected?.fullLabel ?? ''}
                nameSubject
                prefix="summary"
                onOpen={standing.onOpen}
              />
            ) : null}
            <button
              type="button"
              className="shrink-0 text-sm font-medium text-accent-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep"
              onClick={(e) => onExpand(e.currentTarget)}
            >
              See all {countNoun(summary.total, noun)} <span aria-hidden="true">›</span>
            </button>
          </span>
          <span className="text-[11px] text-ink/70">
            {['Exceptions first', layout.count < columns.length ? `last ${layout.count} ${columnUnit(selected, layout.count)}` : '', selected?.fullLabel ?? '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      }
    >
      <div>
        <div
          role="img"
          aria-label={`${parts.map((p) => p.spoken ?? p.text).join(', ')}, of ${countNoun(summary.total, noun)}`}
          className="flex h-2 gap-0.5 overflow-hidden rounded"
        >
          {barParts.map((p) => (
            <span
              key={p.key}
              className={clsx('block h-full min-w-1', p.key === 'unrated' && UNRATED_CLASS)}
              style={{ ...segmentStyle(scale, p.key), flexGrow: p.n }}
            />
          ))}
        </div>
        <p data-testid="item-tile-distribution" className="mt-1 text-xs text-ink/80">
          {parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ' · '}
              {p.key === best?.key ? <strong className="font-semibold">{p.text}</strong> : p.text}
            </span>
          ))}
        </p>
      </div>
      <div ref={measure} data-testid="item-tile-board" data-stacked={String(layout.stacked)} className="mt-2 min-w-0">
        {!layout.stacked && ex.shown.length > 0 && (
          <div
            data-testid="item-tile-months"
            aria-hidden="true"
            className="grid items-center px-1.5 text-[11px] leading-4 text-ink/70"
            style={{ gridTemplateColumns: inlineColumns }}
          >
            <span className="capitalize">{noun.one}</span>
            <span className="grid text-center" style={cellsStyle}>
              {shownColumns.map((c, i) => (
                <span key={c.key} className={clsx('truncate', i === shownColumns.length - 1 && 'font-semibold text-accent-deep')}>
                  {c.label}
                </span>
              ))}
            </span>
            <span className="text-right">{selected?.label}</span>
          </div>
        )}
        {ex.shown.map((r) => {
          const cells = (
            <span data-cells="" aria-hidden="true" className={clsx('grid', layout.stacked && 'col-span-2')} style={cellsStyle}>
              {r.cells.slice(offset).map((cell) => (
                <span key={cell.key} className="px-0.5">
                  <StatusCell cell={cell} name="" scale={scale} size="sm" decorative />
                </span>
              ))}
            </span>
          )
          const shownValue = r.reported ? (
            <span data-value="" className="whitespace-nowrap text-right font-semibold tabular-nums">
              {r.display || chartTheme(scale, r.status).label}
            </span>
          ) : (
            <span data-value="" className="whitespace-nowrap text-right text-[11px] text-ink/70">
              {lastText(r, long)}
            </span>
          )
          return (
            <button
              key={r.id}
              type="button"
              aria-label={rowName(r)}
              className={clsx(
                'grid min-h-7 w-full items-center rounded-md px-1.5 py-0.5 text-left text-xs hover:bg-ink/[0.035]',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-deep',
                layout.stacked && 'grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-1',
              )}
              style={layout.stacked ? undefined : { gridTemplateColumns: inlineColumns }}
              onClick={(e) => onOpenItem(r.id, e.currentTarget)}
            >
              <ItemName name={r.name} group={r.group} className={clsx('pr-2 font-medium', !r.reported && 'text-ink/70')} />
              {layout.stacked ? (
                <>
                  {shownValue}
                  {cells}
                </>
              ) : (
                <>
                  {cells}
                  {shownValue}
                </>
              )}
            </button>
          )
        })}
        {rest.length > 0 && (
          <p data-testid="item-tile-rest" className="px-1.5 pt-1 text-xs text-ink/80">
            {rest.map((node, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {node}
              </span>
            ))}
          </p>
        )}
      </div>
    </TileFrame>
  )
}
