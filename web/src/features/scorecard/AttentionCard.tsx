import clsx from 'clsx'
import { useId, useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { Link } from 'react-router'
import type { components } from '../../api/schema'
import { ItemName, StatusCell, StatusChip, type StatusLevel } from '../../ui/status'
import { textWidth, uiFont, useFontsReady } from '../../ui/textWidth'
import { useElementWidth } from '../../ui/useElementWidth'
import { statusIntervals } from './charts/bands'
import { chartTheme, MOVE_CLASS, type Move } from './charts/chartTheme'
import { focusReturnRef } from './focusTrigger'
import { itemGridLayout } from './logic/itemGridLayout'
import type { RankedItem } from './logic/needsAttention'
import type { BoardCell } from './logic/statusBoard'

type Band = components['schemas']['Band']

export interface AttentionTrend {
  points: { label: string; value: number | null }[]
  goal: number | null
  /** The rule's bands, tinted behind the line by status. */
  bands: Band[]
  /** The trend in words, for the card's description. */
  summary: string
}

export interface AttentionWhy {
  /** `Lowest` (higher is better) or `Highest`. */
  lead: string
  name: string
  display: string
  status: string
  /** `2 of 4 segments Red`. */
  share: string
}

export interface AttentionItems {
  worst: { name: string; display: string; status: string } | null
  /** `18 of 24 Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported`. */
  distribution: string
  /** The worst three items, for the decorative mini board. */
  rows: { id: string; name: string; display: string; cells: BoardCell[] }[]
  /** `Webhooks: Red in 2 of the last 12 months`. */
  why: string
}

export interface AttentionMeta {
  category: string
  scale: StatusLevel[]
  /** The value shown; '' when only children have one. */
  display: string
  /** Beside the chip when there is no value: `worst of 2 segments`. */
  caption: string
  change: { text: string; move: Move } | null
  threshold: string
  trend: AttentionTrend | null
  /** The metric's status per column (the worst item's, for item metrics), with a short label each. */
  ribbon: { cells: BoardCell[]; labels: string[] }
  why: AttentionWhy | null
  /** Item metrics (Uptime): the worst item, the distribution and a mini board instead of the trend. */
  items?: AttentionItems
}

export interface AttentionCardProps {
  item: RankedItem
  meta: AttentionMeta
  /** The current query with `focus` set to the metric. */
  href: string
  /** Phones: reason, title, value and a 6-cell ribbon only. */
  compact: boolean
}

const PLOT_HEIGHT = 56
/** The mini board's name column floor before it gives up months. */
const MINI_NAME_FLOOR = 140
/** A cell narrower than this inside its gutters draws its status's shape, not its letter. */
const LETTER_MIN = 14

/** The 56px trend: bands at 9%, a dotted goal, the line and its current point. Decorative; the summary carries it. */
function TrendLine({ trend, scale }: { trend: AttentionTrend; scale: StatusLevel[] }) {
  const { points, goal } = trend
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (goal !== null) values.push(goal)
  if (values.length === 0) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(Math.abs(max) * 0.05, 1) : (max - min) * 0.18
  const lo = min - pad
  const hi = max + pad
  const n = points.length
  const x = (i: number) => ((i + 0.5) / n) * 100
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo)) * (PLOT_HEIGHT - 8)

  const runs: { i: number; v: number }[][] = []
  points.forEach((p, i) => {
    if (p.value === null) return
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1]!.i === i - 1) last.push({ i, v: p.value })
    else runs.push([{ i, v: p.value }])
  })
  const lastIndex = n - 1
  const current = points[lastIndex]?.value ?? null
  const dots = [
    ...runs.filter((r) => r.length === 1 && r[0]!.i !== lastIndex).map((r) => ({ ...r[0]!, current: false })),
    ...(current !== null ? [{ i: lastIndex, v: current, current: true }] : []),
  ]

  return (
    <div className="relative" style={{ height: PLOT_HEIGHT }} aria-hidden="true">
      <svg viewBox={`0 0 100 ${PLOT_HEIGHT}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        {statusIntervals(trend.bands, [lo, hi]).map((b) => (
          <rect
            key={`${b.status}-${b.y0}`}
            x={0}
            width={100}
            y={y(b.y1)}
            height={Math.max(0, y(b.y0) - y(b.y1))}
            fill={chartTheme(scale, b.status).color}
            fillOpacity={0.09}
          />
        ))}
        {goal !== null && (
          <line
            x1={0}
            x2={100}
            y1={y(goal)}
            y2={y(goal)}
            stroke="var(--color-ink)"
            strokeOpacity={0.4}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {runs
          .filter((r) => r.length > 1)
          .map((r) => (
            <path
              key={r[0]!.i}
              d={r.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)} ${y(p.v)}`).join(' ')}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>
      {dots.map((d) => (
        <span
          key={d.i}
          className={clsx(
            'absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent',
            d.current ? 'size-[7px] ring-[1.5px] ring-white' : 'size-1',
          )}
          style={{ left: `${x(d.i)}%`, top: y(d.v) }}
        />
      ))}
    </div>
  )
}

function Ribbon({ cells, labels, scale, compact }: { cells: BoardCell[]; labels: string[]; scale: StatusLevel[]; compact: boolean }) {
  const from = compact ? Math.max(0, cells.length - 6) : 0
  const shown = cells.slice(from)
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }
  return (
    <div>
      <div data-testid="attention-ribbon" aria-hidden="true" className="grid gap-0.5" style={grid}>
        {shown.map((cell) => (
          <StatusCell key={cell.key} cell={cell} name="" scale={scale} size="sm" decorative />
        ))}
      </div>
      {!compact && (
        <div aria-hidden="true" className="mt-0.5 grid gap-0.5 text-center text-[11px] leading-4 text-ink/70" style={grid}>
          {labels.slice(from).map((label, i) => (
            <span key={`${label}-${i}`} className={clsx(i === shown.length - 1 && 'font-semibold text-accent-deep')}>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The worst three items: name, a row of 14px cells and the value, laid out as
 * the uptime tile is (`itemGridLayout`): names keep at least 140px and the
 * months halve to fit; with no room for 6 months beside the name, each item
 * stacks. Decorative; the distribution line says it.
 */
function MiniBoard({ rows, scale }: { rows: AttentionItems['rows']; scale: StatusLevel[] }) {
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const fontsReady = useFontsReady()
  const total = rows[0]?.cells.length ?? 0
  const needs = useMemo(
    () => ({
      name: Math.max(0, ...rows.map((r) => textWidth(r.name, uiFont(500, 12)))) + 4,
      group: 0,
      value: Math.max(40, ...rows.map((r) => textWidth(r.display, uiFont(600, 12)) + 8)),
      extra: 0,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fontsReady` asks for a new measurement.
    [rows, fontsReady],
  )
  const layout = itemGridLayout(width, total, needs, { nameFloor: MINI_NAME_FLOOR, stackBelow: 0 })
  const offset = total - layout.count
  // Cells have a 1px gutter each side.
  const glyph = layout.cellWidth - 2 < LETTER_MIN ? 'shape' : 'letter'
  const cellsStyle: CSSProperties = { gridTemplateColumns: `repeat(${layout.count}, ${layout.cellWidth}px)` }
  return (
    <div
      ref={measure}
      data-testid="attention-mini-board"
      data-stacked={String(layout.stacked)}
      aria-hidden="true"
      className="mt-1 flex min-w-0 flex-col gap-1 overflow-hidden text-xs"
    >
      {rows.map((r) => {
        const cells = (
          <span data-cells="" className={clsx('grid', layout.stacked && 'col-span-2')} style={cellsStyle}>
            {r.cells.slice(offset).map((cell) => (
              <span key={cell.key} className="px-px">
                <StatusCell cell={cell} name="" scale={scale} size="xs" decorative glyph={glyph} />
              </span>
            ))}
          </span>
        )
        const value = <span className="whitespace-nowrap pl-2 text-right font-semibold tabular-nums">{r.display}</span>
        return (
          <div
            key={r.id}
            data-mini-row=""
            className={clsx('grid items-center', layout.stacked && 'grid-cols-[minmax(0,1fr)_auto] gap-y-0.5')}
            style={
              layout.stacked
                ? undefined
                : { gridTemplateColumns: `${layout.nameWidth}px ${layout.count * layout.cellWidth}px ${layout.valueWidth}px` }
            }
          >
            <ItemName name={r.name} className="pr-1 font-medium" />
            {layout.stacked ? (
              <>
                {value}
                {cells}
              </>
            ) : (
              <>
                {cells}
                {value}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A chip whose status is spoken in words; the shape and letter are for the eye. */
function SpokenChip({ status, scale, size = 'md' }: { status: string; scale: StatusLevel[]; size?: 'md' | 'lg' }) {
  return (
    <>
      <span aria-hidden="true" className="inline-flex">
        <StatusChip status={status} scale={scale} size={size} />
      </span>
      <span className="sr-only">{chartTheme(scale, status).label || status}</span>
    </>
  )
}

/**
 * One metric that needs attention (§4.3): an `article` whose `h3` link covers
 * the card (stretched link) and is described by the value row, the reason and
 * the trend's summary. Phones get a compact row: reason, title, value, a
 * 6-cell ribbon.
 */
export function AttentionCard({ item, meta, href, compact }: AttentionCardProps) {
  const base = useId()
  const ids = { title: `${base}t`, reason: `${base}r`, value: `${base}v`, summary: `${base}s`, dist: `${base}d` }
  const { scale, items } = meta
  const reasonClass = clsx('text-[11px] font-semibold leading-4', item.tier === 1 ? 'text-status-r' : 'text-status-y')
  const describedBy = [ids.value, ids.reason, !compact && (items ? ids.dist : meta.trend && ids.summary)].filter(Boolean).join(' ')
  const valueSize = compact ? 'text-xl font-semibold tabular-nums' : 'text-[28px] font-semibold leading-9 tabular-nums'

  const value = items ? (
    items.worst ? (
      <>
        {/* On phones the name takes its own line, so the value and chip stay together. */}
        {/* The name moves under `Worst` rather than shrink below 16rem beside it. */}
        <span className={clsx('flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2', compact && 'basis-full')}>
          <span className="shrink-0 text-xs text-ink/70">Worst</span>
          <span data-worst-name="" className="min-w-[min(100%,16rem)] flex-1">
            <ItemName name={items.worst.name} className={clsx('font-semibold', compact ? 'text-sm' : 'text-base')} />
          </span>
        </span>
        <span className={valueSize}>{items.worst.display}</span>
        {items.worst.status && <SpokenChip status={items.worst.status} scale={scale} size="lg" />}
      </>
    ) : (
      <span className="text-sm text-ink/70">Not reported</span>
    )
  ) : (
    <>
      {meta.display && <span className={valueSize}>{meta.display}</span>}
      <SpokenChip status={item.status} scale={scale} size="lg" />
      {!meta.display && meta.caption && <span className="text-xs text-ink/70">{meta.caption}</span>}
      {meta.change && (
        <span className={clsx('tabular-nums font-medium', compact ? 'text-xs' : 'text-sm', MOVE_CLASS[meta.change.move.tone])}>
          {meta.change.move.arrow && <span aria-hidden="true">{meta.change.move.arrow} </span>}
          {meta.change.text}
        </span>
      )}
    </>
  )

  return (
    <article
      aria-labelledby={ids.title}
      className={clsx(
        'relative flex h-full min-w-0 flex-col rounded-lg border border-ink/20 bg-white transition-colors hover:border-accent',
        'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-accent-deep',
        compact ? 'gap-1 p-3' : 'min-h-[248px] gap-1.5 p-4',
      )}
    >
      <div className={clsx('flex flex-wrap items-baseline gap-x-3', compact ? 'justify-start' : 'justify-between')}>
        {!compact && <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.04em] text-ink/70">{meta.category}</span>}
        <span id={ids.reason} className={reasonClass}>
          {item.reason}
        </span>
      </div>
      <h3 id={ids.title} className={clsx('font-semibold break-words', compact ? 'text-sm' : 'text-base')}>
        <Link
          to={href}
          aria-describedby={describedBy}
          className="after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
          onClick={(e) => {
            focusReturnRef.current = e.currentTarget
          }}
        >
          {item.name}
        </Link>
      </h3>
      <div id={ids.value} data-testid="attention-value" className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {value}
      </div>
      {!compact && items && (
        <>
          <p id={ids.dist} className="text-xs text-ink/70">
            {items.distribution}
          </p>
          <MiniBoard rows={items.rows} scale={scale} />
        </>
      )}
      {!compact && !items && meta.threshold && <p className="text-xs text-ink/70">{meta.threshold}</p>}
      {!compact && !items && meta.trend && (
        <div className="mt-1">
          <TrendLine trend={meta.trend} scale={scale} />
          <p id={ids.summary} className="sr-only">
            {meta.trend.summary}
          </p>
        </div>
      )}
      {(compact || !items) && meta.ribbon.cells.length > 0 && (
        <div className={clsx(!compact && !meta.trend && 'mt-1')}>
          <Ribbon cells={meta.ribbon.cells} labels={meta.ribbon.labels} scale={scale} compact={compact} />
        </div>
      )}
      {!compact && (items?.why || meta.why) && (
        <p data-testid="attention-why" className="mt-auto border-t border-ink/10 pt-2 text-xs text-ink/80">
          {items ? (
            items.why
          ) : (
            <>
              {meta.why!.lead}:{' '}
              <strong className="font-semibold">
                {meta.why!.name} {meta.why!.display}
              </strong>{' '}
              <span role="img" aria-label={chartTheme(scale, meta.why!.status).label || meta.why!.status} className="inline-flex align-[-3px]">
                <StatusChip status={meta.why!.status} scale={scale} />
              </span>{' '}
              · {meta.why!.share}
            </>
          )}
        </p>
      )}
    </article>
  )
}

const SM_UP = '(min-width: 640px)'

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SM_UP)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !window.matchMedia(SM_UP).matches : false
}

export interface NeedsAttentionProps {
  shown: { item: RankedItem; meta: AttentionMeta; href: string }[]
  totals: { red: number; slipping: number; middle: number }
  /** The scale's label for the worst status. */
  worstLabel: string
  /** Filters the tiles to the worst status and moves focus to the first. */
  onShowAll: () => void
}

/** What the cards show: `3 of 5 Red` when all are the worst status, else `2 Red · 1 slipping · 1 Yellow`. */
function shownText(shown: NeedsAttentionProps['shown'], totals: NeedsAttentionProps['totals'], worstLabel: string): string {
  const reds = shown.filter((s) => s.item.tier === 1).length
  if (reds === shown.length) return reds === totals.red ? `${reds} ${worstLabel}` : `${reds} of ${totals.red} ${worstLabel}`
  const parts = reds > 0 ? [`${reds} ${worstLabel}`] : []
  const slipping = shown.filter((s) => s.item.tier === 2).length
  if (slipping > 0) parts.push(`${slipping} slipping`)
  const middle = new Map<string, number>()
  for (const s of shown) if (s.item.tier === 3) middle.set(s.item.label, (middle.get(s.item.label) ?? 0) + 1)
  for (const [label, n] of middle) parts.push(`${n} ${label}`)
  return parts.join(' · ')
}

/** The Needs attention section: what is shown, Show all when more of the worst exist, and the cards. */
export function NeedsAttention({ shown, totals, worstLabel, onShowAll }: NeedsAttentionProps) {
  const headingId = useId()
  const compact = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const reds = shown.filter((s) => s.item.tier === 1).length
  return (
    <section aria-labelledby={headingId} className="pt-2">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold text-accent-deep">
          Needs attention
        </h2>
        <span className="text-xs text-ink/70">{shownText(shown, totals, worstLabel)}</span>
        {totals.red > reds && (
          <button type="button" onClick={onShowAll} className="inline-flex min-h-6 items-center text-xs font-medium text-accent-deep hover:underline">
            Show all {totals.red} {worstLabel} <span aria-hidden="true">›</span>
          </button>
        )}
      </div>
      <ul className={clsx('grid grid-cols-[minmax(0,1fr)]', compact ? 'gap-2' : 'gap-4 sm:grid-cols-2 lg:grid-cols-3')}>
        {shown.map((s) => (
          <li key={s.item.metricKey} className="min-w-0">
            <AttentionCard item={s.item} meta={s.meta} href={s.href} compact={compact} />
          </li>
        ))}
      </ul>
    </section>
  )
}
