import clsx from 'clsx'
import type { CSSProperties } from 'react'
import type { components } from '../../api/schema'
import { HATCH, StatusCell, StatusChip, UNRATED_CLASS, type StatusLevel } from '../../ui/status'
import { useElementWidth } from '../../ui/useElementWidth'
import { chartTheme, statusFill } from './charts/chartTheme'
import type { Column } from './columns'
import { exceptionsFirst, itemSummary, type ItemRow } from './logic/itemGrid'
import { itemGridLayout } from './logic/itemGridLayout'
import { countNoun, type NounForms } from './logic/nouns'
import { columnUnit, sinceText, thresholdText } from './logic/statusText'
import { TileFrame } from './TileFrame'

type ViewRow = components['schemas']['ViewRow']
type Direction = components['schemas']['Direction']
type StatusRule = components['schemas']['StatusRule']

/** Rows pad 6px each side inside the tile. */
const ROW_PAD = 12
const MAX_ROWS = 5

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
}

function segmentStyle(scale: StatusLevel[], key: string): CSSProperties {
  if (key === 'none') return { ...HATCH, backgroundColor: 'white', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 15%, transparent)' }
  if (key === 'unrated') return {}
  const fill = statusFill(scale, key)
  const color = scale.find((s) => s.key === key)?.color ?? 'var(--color-ink)'
  if (fill.tier === 'solid') return { backgroundColor: fill.background }
  const edge = fill.tier === 'outline' ? (fill.border ?? color) : `color-mix(in srgb, ${color} 25%, transparent)`
  return { backgroundColor: fill.background, boxShadow: `inset 0 0 0 1px ${edge}` }
}

/**
 * An item metric's tile (§6.4): the worst item and since when, how the items
 * are spread across statuses, then the exceptions first, one button per item
 * (not at the best status, then not reported), at most five, and how many
 * others are fine.
 */
export function ItemSummaryTile({ head, rows, columns, scale, direction, noun, rule, onExpand, onOpenItem }: ItemSummaryTileProps) {
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label
  const byRank = [...scale].sort((a, b) => a.rank - b.rank)
  const best = byRank[0]
  const bestLabel = best?.label || best?.key || ''
  const selected = columns[columns.length - 1]
  const unit = columnUnit(selected, 1)

  const summary = itemSummary(rows, scale)
  const ex = exceptionsFirst(rows, scale, direction, MAX_ROWS)
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
        surface: 'tile',
      })
    : ''
  const threshold = [countNoun(summary.total, noun), ruleText].filter(Boolean).join(' · ')

  const worst = summary.worst
  const since = worst ? sinceText(worst.cells, worst.cells.length - 1, columns, statusLabel) : ''

  // Best first in words; worst first in the bar, as Health draws it.
  const parts = [
    ...byRank.flatMap((s) => {
      const n = summary.counts.get(s.key) ?? 0
      return n > 0 ? [{ key: s.key, text: `${n} ${s.label || s.key}` }] : []
    }),
    ...(unrated > 0 ? [{ key: 'unrated', text: `${unrated} not rated` }] : []),
    ...(summary.notReported > 0 ? [{ key: 'none', text: `${summary.notReported} not reported` }] : []),
  ]
  const barParts = [...byRank]
    .reverse()
    .map((s) => ({ key: s.key, n: summary.counts.get(s.key) ?? 0 }))
    .concat([
      { key: 'unrated', n: unrated },
      { key: 'none', n: summary.notReported },
    ])
    .filter((p) => p.n > 0)

  const layout = itemGridLayout(width > 0 ? width - ROW_PAD : 0, columns.length, { valueWidth: 72, nameMin: 80 })
  const offset = columns.length - layout.count
  const shownColumns = columns.slice(offset)
  const inlineColumns = `${layout.nameWidth}px ${layout.count * layout.cellWidth}px ${layout.valueWidth}px`
  const cellsStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${layout.count}, ${layout.cellWidth}px)`,
    width: layout.count * layout.cellWidth,
  }

  const rowName = (r: ItemRow) => {
    if (r.reported) return `Open ${r.name} trend: ${r.display}, ${r.status ? (statusLabel(r.status) ?? r.status) : 'not rated'}`
    if (r.current.kind === 'na') return `Open ${r.name} trend: not applicable this ${unit}${r.current.naReason ? `, ${r.current.naReason}` : ''}`
    const last = r.lastReported
      ? `last ${r.lastReported.label} ${r.lastReported.display}`
      : `no reports in ${columns.length} ${columnUnit(selected, columns.length)}`
    return `Open ${r.name} trend: not reported this ${unit}, ${last}`
  }

  const rest = [
    ex.hiddenWorse > 0 ? <span key="worse">{ex.hiddenWorse} more below {bestLabel}</span> : null,
    ex.hiddenNotReported > 0 ? <span key="missing">{ex.hiddenNotReported} more not reported</span> : null,
    summary.best > 0 && summary.best === summary.total ? (
      <span key="best">
        All <strong className="font-semibold">{summary.total}</strong> {summary.total === 1 ? noun.one : noun.many} {bestLabel}
      </span>
    ) : summary.best > 0 ? (
      <span key="best">
        All other <strong className="font-semibold">{summary.best}</strong> {summary.best === 1 ? noun.one : noun.many} {bestLabel}
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
          <button
            type="button"
            className="text-sm font-medium text-accent-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep"
            onClick={(e) => onExpand(e.currentTarget)}
          >
            See all {countNoun(summary.total, noun)} <span aria-hidden="true">›</span>
          </button>
          <span className="text-[11px] text-ink/70">Exceptions first · {selected?.fullLabel ?? ''}</span>
        </div>
      }
    >
      <div>
        <div
          role="img"
          aria-label={`${parts.map((p) => p.text).join(', ')}, of ${countNoun(summary.total, noun)}`}
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
                <span key={c.key} className={clsx(i === shownColumns.length - 1 && 'font-semibold text-accent-deep')}>
                  {/^[A-Z][a-z]{2}$/.test(c.label) ? c.label[0] : c.label}
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
            <span className="text-right font-semibold tabular-nums">{r.display || chartTheme(scale, r.status).label}</span>
          ) : (
            <span className="whitespace-nowrap text-right text-[11px] text-ink/70">{r.current.kind === 'na' ? 'Not applicable' : 'Not reported'}</span>
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
              <span className={clsx('line-clamp-2 min-w-0 break-words pr-2 font-medium', !r.reported && 'text-ink/70')}>{r.name}</span>
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
