import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useItemKinds, useMe, useOrgLevels, useOrgUnits, useScorecards, useVersions, useView } from '../../api/queries'
import type { components } from '../../api/schema'
import { parsePeriod, periodLabel } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { StatusChip } from '../../ui/status'
import { useAskSam } from '../assistant/useAssistant'
import { Breakdown } from './Breakdown'
import { defaultStatusScale, MOVE_CLASS } from './charts/chartTheme'
import { FOCUS_CHART_HEIGHT, MetricChart, type ChartParts } from './charts/MetricChart'
import { formatMoneyCompact } from './charts/moneyPlan'
import { buildPoints, halfChange, headerChange } from './charts/points'
import { RANGES, rangeChange, rangeColumns, rangeMonths, type RangeKey } from './charts/ranges'
import { multiSeriesHeader } from './charts/seriesLayout'
import { isSparse } from './charts/sparse'
import { useVersionMarkers } from './charts/versionMarkers'
import { buildMonthTrendColumns, windowColumns, type Column } from './columns'
import { DefinitionLine, MEASURED } from './DefinitionLine'
import { chartCsv, chartSvg, downloadBlob, metricPng } from './exports'
import { focusBodyKind } from './focusBody'
import { FocusHeader } from './FocusHeader'
import { focusRequestOptions, focusWindow } from './focusRequest'
import { focusReturnRef } from './focusTrigger'
import { formatMetricValue } from './format'
import { ItemDrillIn } from './ItemDrillIn'
import { itemGridCsv, itemGridSvg } from './itemExports'
import { ItemGrid, SegmentedControl, useItemGroups } from './ItemGrid'
import { ItemMonths } from './ItemMonths'
import { periodStatus } from './logic/coarse'
import {
  buildItemRows,
  ITEM_PARAM,
  parseItemSort,
  partitionItems,
  SORT_PARAM,
  sortItems,
  visibleItemOrder,
  type ItemSort,
} from './logic/itemGrid'
import { defaultLayout } from './logic/layout'
import { nounForms, nounFromId, valueHeader, type NounForms } from './logic/nouns'
import { cellReported, statusAtScope, type StatusScaleEntry } from './logic/statusAtScope'
import { buildBoardRow } from './logic/statusBoard'
import { columnUnit, sinceText } from './logic/statusText'
import { Kbd, MoreMenu } from './MoreMenu'
import { RangeStrip } from './RangeStrip'
import { TablePage } from './TablePage'
import { useDialogShortcuts } from './useDialogShortcuts'
import { useLevelNoun } from './useNouns'
import { cellKey, groupRows, metricScope, ratioParts } from './viewHelpers'
import { useScorecardViewRequest } from './viewRequest'

type ScorecardView = components['schemas']['ScorecardView']
type Metric = components['schemas']['Metric']
type StatusRule = components['schemas']['StatusRule']
type Frequency = components['schemas']['Frequency']

const HEADER = 'shrink-0 border-b border-ink/15 px-4 pt-3 pb-2 sm:px-6 sm:pt-4 sm:pb-3'
const BODY = 'min-h-0 flex-1 overflow-y-auto bg-cream px-4 pt-4 pb-6 sm:px-6'

/** The item grid's ranges, keys `1`–`3`. */
const ITEM_RANGES = ['6M', '12M', '24M'] as const satisfies readonly RangeKey[]
type ItemRangeKey = (typeof ITEM_RANGES)[number]

/** The dialog range as an item grid range: 3M and 6M show 6, YTD and 12M show 12, 24M 24. */
function itemRangeOf(range: RangeKey): ItemRangeKey {
  return range === '3M' || range === '6M' ? '6M' : range === '24M' ? '24M' : '12M'
}

interface LayoutMetric {
  key: string
  name: string
  category: string
  frequency: Frequency
}

function metricsInLayout(view: ScorecardView): LayoutMetric[] {
  const groups = groupRows(view)
  const metricsByCategory: Record<string, { key: string }[]> = {}
  const byKey = new Map<string, LayoutMetric>()
  for (const g of groups) {
    metricsByCategory[g.id] = g.metrics.map((m) => ({ key: m.key }))
    for (const m of g.metrics) {
      byKey.set(m.key, { key: m.key, name: m.name, category: g.name, frequency: m.rows[0]?.frequency ?? 'monthly' })
    }
  }
  return defaultLayout(view.categories, metricsByCategory)
    .filter((i) => i.id.startsWith('metric:'))
    .flatMap((i) => byKey.get(i.id.slice('metric:'.length)) ?? [])
}

/** A metric's scope row in a view; null while loading or when it has none. */
function scopeRowOf(view: ScorecardView | undefined, metricKey: string) {
  const group = view ? groupRows(view).flatMap((g) => g.metrics).find((m) => m.key === metricKey) : undefined
  return group ? (metricScope(group.rows).scope ?? null) : null
}

/** The value of the best band of each subject with its own bands, for the definition's `held to` clause. */
function ownTargets(rule: StatusRule | undefined, scale: StatusScaleEntry[], nameOf: (id: string) => string | undefined) {
  const best = [...scale].sort((a, b) => a.rank - b.rank)[0]?.key
  return (rule?.perSubject ?? []).flatMap((s) => {
    const band = s.bands.find((b) => b.status === best && b.op !== '')
    const name = nameOf(s.subjectId)
    return band && name ? [{ name, value: band.value }] : []
  })
}

/** The index of the last of `columns` where `row` has a value; -1 when none does. */
function lastValuedIndex(row: components['schemas']['ViewRow'], columns: Column[]): number {
  for (let i = columns.length - 1; i >= 0; i--) {
    const c = row.cells.find((x) => cellKey(x) === columns[i]!.key)
    if (c && c.naReason === '' && c.value != null) return i
  }
  return -1
}

/** `Aug–Oct`, `Oct`: the columns after the last value. */
function spanLabel(columns: Column[]): string {
  if (columns.length === 0) return ''
  return columns.length === 1 ? columns[0]!.label : `${columns[0]!.label}–${columns[columns.length - 1]!.label}`
}

/**
 * The item kind's noun for a metric reported for tracked items, from the kind's name, else its id
 * (`deployments`); mounted only then, so other metrics never ask for item kinds.
 */
function ItemNoun({ metric, children }: { metric: Metric; children: (noun: NounForms) => ReactNode }) {
  const kinds = useItemKinds()
  const kindId = metric.reportedAt.find((s) => s.kind === 'item_kind')?.id
  const name = kindId ? kinds.data?.find((k) => k.id === kindId)?.name : undefined
  return children(name ? nounForms(name, 'item') : kindId ? nounFromId(kindId) : nounForms(undefined, 'item'))
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()

/**
 * A sparse ratio metric's parts column (§7): the denominator measure's first word
 * (`Postmortems due` → `Postmortems`), and for the value what the metric name, or
 * else the numerator measure's name, says after that word (`… postmortems on time` →
 * `On time`); the metric name's last word when neither repeats it.
 */
function chartParts(metricName: string, numerator: { key: string; name: string }, denominator: { key: string; name: string }): ChartParts {
  const denominatorLabel = capitalized(denominator.name.trim().split(/\s+/)[0] || denominator.key)
  const after = (name: string) => {
    const words = name.trim().split(/\s+/)
    const at = words.findIndex((w) => w.toLowerCase() === denominatorLabel.toLowerCase())
    return at >= 0 && at < words.length - 1 ? words.slice(at + 1).join(' ') : ''
  }
  const value = after(metricName) || after(numerator.name) || (metricName.trim().split(/\s+/).at(-1) ?? '')
  return { valueLabel: capitalized(value), denominatorLabel, numerator: numerator.key, denominator: denominator.key }
}

/** How long an announcement stays in the live region before it gives way (to `Loading chart`, say). */
const ANNOUNCE_MS = 4000

/** One polite region for the dialog; repeating the same message still announces it, and each clears after a few seconds. */
function useAnnouncer(): [string, (message: string) => void, () => void] {
  const [message, setMessage] = useState('')
  const shown = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const clear = useCallback(() => {
    clearTimeout(timer.current)
    shown.current = ''
    setMessage('')
  }, [])
  const announce = useCallback(
    (next: string) => {
      clearTimeout(timer.current)
      const show = () => {
        shown.current = next
        setMessage(next)
        timer.current = setTimeout(clear, ANNOUNCE_MS)
      }
      if (shown.current !== next) return show()
      shown.current = ''
      setMessage('')
      timer.current = setTimeout(show, 50)
    },
    [clear],
  )
  return [message, announce, clear]
}

function MetricFocus({
  metricKey,
  layout,
  frameRef,
  escapeRef,
}: {
  metricKey: string
  layout: LayoutMetric[]
  frameRef: RefObject<HTMLDivElement | null>
  /** What Escape does before closing the dialog; true when it handled the key. */
  escapeRef: RefObject<(() => boolean) | null>
}) {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const navigate = useNavigate()
  const [period, updatePeriod] = usePeriodState()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [range, setRange] = useState<RangeKey>('12M')
  const [exportError, setExportError] = useState('')
  const [announcement, announce, clearAnnouncement] = useAnnouncer()
  const [toast, setToast] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  // Item views: the filter, the silent group's open state and the grid's scroll position live here, so they survive the drill-in.
  const [filter, setFilter] = useState('')
  const [silentOpen, setSilentOpen] = useState(false)
  const [restoreId, setRestoreId] = useState('')
  const gridScroll = useRef(0)
  // A drill-in's Monthly values stay open or shut for the dialog session.
  const [monthsOpen, setMonthsOpen] = useState(false)
  // The item whose drill-in was last on screen: a change into a drill-in moves focus to its heading (§6.6),
  // except a step to the previous or next item, which keeps focus where it was.
  const shownSubject = useRef('')
  const stepping = useRef('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const groupOf = useItemGroups()
  const sam = useAskSam()
  const me = useMe()
  const orgUnits = useOrgUnits()
  const levels = useOrgLevels()
  const versions = useVersions(scorecardId)
  const fy = period.fiscalYearStartMonth
  const scale: StatusScaleEntry[] = useMemo(
    () =>
      me.data?.tenant?.statusScale?.map((s) => ({ key: s.key, rank: s.rank })) ??
      defaultStatusScale().map((s) => ({ key: s.key, rank: s.rank })),
    [me.data?.tenant?.statusScale],
  )
  const statusColors = useMemo(() => me.data?.tenant?.statusScale ?? defaultStatusScale(), [me.data?.tenant?.statusScale])
  const statusLabel = (key: string) => statusColors.find((s) => s.key === key)?.label
  const canEnter = me.data?.role === 'admin' || me.data?.role === 'contributor'

  // Ranges are months; other grains, and metrics coarser than the selected grain, keep their own trend window.
  const monthGrain = parsePeriod(period.period)?.grain === 'month'
  const rangeSpan = rangeMonths(range, period.period)
  const frequency = layout.find((m) => m.key === metricKey)?.frequency ?? 'monthly'
  const requested = focusWindow(range, period.period, frequency)
  // 12 months share the Overview's request and cache; 24 months, and a coarse
  // metric's own grain, ask for this metric's rows only.
  const { request, ready } = useScorecardViewRequest(focusRequestOptions(requested, metricKey, period.period))
  const view = useView(ready ? scorecardId : undefined, request, { keepPrevious: true })
  // The window of the data on screen: while another window loads, the chart keeps the one it has data for.
  const [shownWindow, setShownWindow] = useState(requested)
  if (view.data && !view.isPlaceholderData && (shownWindow.grain !== requested.grain || shownWindow.count !== requested.count)) {
    setShownWindow(requested)
  }
  const monthWindow = shownWindow.grain === 'month'
  const asked24 = requested.grain === 'month' && requested.count === 24
  // After 24 months have been asked for this metric, read them from the cache so the 24M change stays shown.
  const [longFor, setLongFor] = useState('')
  const long = useScorecardViewRequest({ months: 24, metrics: [metricKey] })
  const longView = useView(long.ready && (asked24 || longFor === metricKey) ? scorecardId : undefined, long.request)
  const longColumns = useMemo(() => buildMonthTrendColumns(period.period, 24, fy), [period.period, fy])
  const longScope = scopeRowOf(longView.data, metricKey)
  const selectRange = (key: RangeKey) => {
    if (asked24 || rangeMonths(key, period.period) > 12) setLongFor(metricKey)
    setRange(key)
  }
  const shownColumns = useMemo(
    () => windowColumns(period.period, shownWindow.grain, shownWindow.count, fy),
    [period.period, fy, shownWindow.grain, shownWindow.count],
  )
  const trendColumns = useMemo(
    () => (monthWindow ? shownColumns.slice(-rangeSpan) : shownColumns),
    [monthWindow, shownColumns, rangeSpan],
  )
  const itemRange = itemRangeOf(range)
  const itemColumns = useMemo(
    () => (monthWindow ? shownColumns.slice(-rangeMonths(itemRange, period.period)) : shownColumns),
    [monthWindow, shownColumns, itemRange, period.period],
  )
  const selectedColumn = trendColumns[trendColumns.length - 1]
  const columnKey = selectedColumn?.key ?? ''

  const groups = view.data ? groupRows(view.data) : []
  const metricGroup = groups.flatMap((g) => g.metrics).find((m) => m.key === metricKey)
  const measured = metricGroup ? metricScope(metricGroup.rows) : null
  const head = measured?.head
  const scope = measured?.scope ?? null
  const children = measured?.children ?? []
  const bodyKind = metricGroup ? focusBodyKind(metricGroup.rows) : 'chart'
  const isItems = bodyKind === 'items'

  // Item views: the sort and the item drilled into live in the URL (`item`, not the view's `subject` filter); stale values fall back (and are cleaned below).
  const subject = params.get(ITEM_PARAM) ?? ''
  const sortParam = params.get(SORT_PARAM)
  const sort = parseItemSort(sortParam)
  // Kept per response and window, so the grid's memoized rows skip when the filter or an announcement changes.
  const itemRows = useMemo(() => {
    const rows = view.data ? groupRows(view.data).flatMap((g) => g.metrics).find((m) => m.key === metricKey)?.rows : undefined
    return isItems && rows ? buildItemRows(rows, itemColumns, scale, groupOf, fy) : []
  }, [view.data, metricKey, isItems, itemColumns, scale, groupOf, fy])
  const subjectRow = isItems && subject ? metricGroup?.rows.find((r) => r.subjectKind === 'item' && r.subjectId === subject) : undefined
  const drillRow = subjectRow ? buildItemRows([subjectRow], trendColumns, scale, groupOf, fy)[0] : undefined
  const drilling = drillRow !== undefined
  const gridShown = isItems && !drilling
  const settled = view.data !== undefined && !view.isPlaceholderData && metricGroup !== undefined
  const hasSubjectRow = subjectRow !== undefined

  useEffect(() => {
    if (!settled) return
    const staleSubject = subject !== '' && !hasSubjectRow
    const staleSort = sortParam !== null && (!isItems || parseItemSort(sortParam) === 'worst')
    if (!staleSubject && !staleSort) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (staleSubject) next.delete(ITEM_PARAM)
        if (staleSort) next.delete(SORT_PARAM)
        return next
      },
      { replace: true },
    )
  }, [settled, subject, hasSubjectRow, sortParam, isItems, setParams])

  // Into a drill-in, however it came (the grid, a tile row, a link, Forward): focus its heading. Back to the
  // grid: the scroll position it had (the grid refocuses the item). Undecided until the metric's rows are in.
  useLayoutEffect(() => {
    if (!metricGroup) return
    const was = shownSubject.current
    shownSubject.current = drilling ? subject : ''
    const body = bodyRef.current
    const stepped = stepping.current !== '' && stepping.current === subject
    if (stepped) stepping.current = ''
    if (drilling && was !== subject && headingRef.current && !stepped) {
      if (body) body.scrollTop = 0
      headingRef.current.focus()
    } else if (!drilling && was !== '' && body) {
      body.scrollTop = gridScroll.current
    }
  })

  const openItem = (id: string) => {
    gridScroll.current = bodyRef.current?.scrollTop ?? 0
    stepping.current = ''
    setRestoreId(id)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set(ITEM_PARAM, id)
        return next
      },
      { state: { itemGrid: true } },
    )
  }
  const backToGrid = () => {
    // The grid then focuses this item's cell, so focus never falls back to the frame (where ← → change metric).
    setRestoreId(subject)
    // Opened from the grid: the same as browser Back. Opened from a link: drop the item in place.
    if ((location.state as { itemGrid?: boolean } | null)?.itemGrid) {
      void navigate(-1)
      return
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete(ITEM_PARAM)
        return next
      },
      { replace: true },
    )
  }
  // The grid's visible order (sort, filter, the silent group only while open) is the order the drill-in steps through (§4).
  const allSilent = itemRows.length > 0 && partitionItems(itemRows, itemColumns).silent.length === itemRows.length
  const itemOrder = isItems
    ? visibleItemOrder(itemRows, {
        columns: itemColumns,
        filter,
        sort,
        direction: head?.direction ?? 'higher_better',
        scale,
        silentOpen: silentOpen || allSilent,
      })
    : []
  const itemName = (id: string) => itemRows.find((r) => r.id === id)?.name ?? id
  const neighbour = (id: string | undefined) => (id ? { id, name: itemName(id) } : undefined)
  const at = drilling ? itemOrder.indexOf(subject) : -1
  const position = {
    index: at >= 0 ? at : null,
    total: itemOrder.length,
    prev: neighbour(at > 0 ? itemOrder[at - 1] : undefined),
    // Not in the order: Next goes to its first item.
    next: neighbour(at >= 0 ? itemOrder[at + 1] : itemOrder[0]),
  }
  // Replaces the drill-in's history entry and keeps its state, so Back still returns to the grid in one step.
  const stepTo = (id: string) => {
    stepping.current = id
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set(ITEM_PARAM, id)
        return next
      },
      { replace: true, state: location.state },
    )
    announce(`${itemName(id)}, ${itemOrder.indexOf(id) + 1} of ${itemOrder.length}`)
  }
  useLayoutEffect(() => {
    escapeRef.current = drilling
      ? () => {
          backToGrid()
          return true
        }
      : null
    return () => {
      escapeRef.current = null
    }
  })

  const changeSort = (next: ItemSort) =>
    setParams(
      (prev) => {
        const q = new URLSearchParams(prev)
        if (next === 'worst') q.delete(SORT_PARAM)
        else q.set(SORT_PARAM, next)
        return q
      },
      { replace: true },
    )
  const sortedItems = () => {
    const s = sortItems(itemRows, sort, head?.direction ?? 'higher_better', scale)
    return [...s.reported, ...s.notReported, ...s.notApplicable]
  }

  // A metric with no org-unit row (item-only) has no scope value to chart.
  const chartRow = scope ?? (head ? { ...head, subjectId: '', subjectName: '', cells: [] } : undefined)
  const cell = scope?.cells.find((c) => cellKey(c) === columnKey)
  const scopeReported = cellReported(cell)
  const reportedChildren = children.filter((ch) => cellReported(ch.cells.find((c) => cellKey(c) === columnKey)))
  const chartChildren = !scopeReported && reportedChildren.length > 0
  const chartRows = drillRow ? [drillRow.row] : chartChildren ? reportedChildren : chartRow ? [chartRow] : []
  // The board row and coarse status here keep the old noun strings; the value row's caption and worst-line count use `withNouns`.
  const noun = children.some((ch) => ch.subjectKind === 'item') ? 'items' : scope && children.length > 0 ? 'segments' : 'items'
  const scopeStatus = (forms: NounForms) => statusAtScope({ scope: scope ?? { cells: [] }, children, columnKey, scale, noun: forms })
  const atScope = head ? scopeStatus(nounForms(undefined, 'item')) : null

  // The metric as defined in the version in force for the selected column.
  const versionId = (cell ?? children.map((ch) => ch.cells.find((c) => cellKey(c) === columnKey)).find(Boolean))?.versionId
  const versionContent = versions.data?.versions.find((v) => v.id === versionId)?.content
  const metric = versionContent?.metrics.find((m) => m.key === metricKey)
  const reported = metric?.reportedAt[0]
  const reportedLevel = reported?.kind === 'level' ? levels.data?.find((l) => l.id === reported.id)?.name : undefined
  const levelNoun = nounForms(reportedLevel, 'unit')
  const childLevelNoun = useLevelNoun(children[0]?.depth ?? (scope ? scope.depth + 1 : 1))
  const childrenAreItems = children.some((ch) => ch.subjectKind === 'item')
  const withNouns = (render: (nouns: { reported: NounForms; children: NounForms }) => ReactNode) =>
    metric && reported?.kind === 'item_kind' ? (
      <ItemNoun metric={metric}>{(n) => render({ reported: n, children: n })}</ItemNoun>
    ) : (
      render({ reported: levelNoun, children: childrenAreItems ? nounForms(undefined, 'item') : childLevelNoun })
    )

  const tableLink = useMemo(() => {
    const q = new URLSearchParams(params)
    q.delete('focus')
    const search = q.size > 0 ? `?${q.toString()}` : ''
    return {
      pathname: `/scorecards/${scorecardId}/table`,
      search,
      hash: `#metric-${metricKey}`,
    }
  }, [params, scorecardId, metricKey])

  const idx = layout.findIndex((m) => m.key === metricKey)
  const prevMetric = idx >= 0 ? layout[idx > 0 ? idx - 1 : layout.length - 1] : undefined
  const nextMetric = idx >= 0 ? layout[idx < layout.length - 1 ? idx + 1 : 0] : undefined

  const goTo = (target: LayoutMetric | undefined) => {
    if (!target || target.key === metricKey) return
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('focus', target.key)
      next.delete(ITEM_PARAM)
      next.delete(SORT_PARAM)
      return next
    })
    setFilter('')
    setSilentOpen(false)
    setRestoreId('')
    announce(`${target.name}, ${layout.indexOf(target) + 1} of ${layout.length}`)
  }

  const exportCsv = () => {
    if (!head) return
    if (gridShown) return downloadBlob(`${head.metricKey}.csv`, 'text/csv', itemGridCsv(sortedItems(), itemColumns))
    if (chartRows.length === 0) return
    downloadBlob(`${head.metricKey}.csv`, 'text/csv', chartCsv(trendColumns, chartRows))
  }

  const unitName = (id: string) => orgUnits.data?.units.find((u) => u.id === id)?.name
  const exportScope = (() => {
    if (period.subjects.length > 0) {
      const names = period.subjects.map((id) => unitName(id) ?? id)
      return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
    }
    if (period.scope) return unitName(period.scope) ?? 'Selected unit'
    return `All of ${me.data?.tenant?.name ?? 'the company'}`
  })()
  const restatedName = period.restate
    ? (versions.data?.versions.find((v) => v.id === period.restate)?.name ?? 'the selected methodology version')
    : ''
  // The item grid exports as the grid; a drill-in, as the item's chart.
  const exportedChart = (m: NonNullable<typeof head>) =>
    gridShown
      ? itemGridSvg({
          title: m.metricName,
          scope: [exportScope, restatedName ? `restated under ${restatedName}` : ''].filter(Boolean).join(' · '),
          rows: sortedItems(),
          columns: itemColumns,
          scale: statusColors,
        })
      : chartSvg({
          title: drillRow ? `${m.metricName}: ${drillRow.name}` : m.metricName,
          scope: exportScope,
          restatedUnder: restatedName,
          format: m.format,
          columns: trendColumns,
          rows: chartRows,
          scale: statusColors,
        })
  const exportable = gridShown ? itemRows.length > 0 : chartRows.length > 0

  const exportSvg = () => {
    if (!head || !exportable) return
    downloadBlob(`${head.metricKey}.svg`, 'image/svg+xml', exportedChart(head))
  }

  const exportPng = async () => {
    if (!head || !exportable) return
    setExportError('')
    try {
      await metricPng(exportedChart(head), `${head.metricKey}.png`)
    } catch {
      setExportError('We couldn’t make the image. Try SVG or CSV.')
    }
  }

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const copyLink = async (): Promise<boolean> => {
    let ok = true
    try {
      await navigator.clipboard.writeText(window.location.href)
    } catch {
      ok = false
    }
    const message = ok ? 'Link copied' : 'Couldn’t copy the link'
    announce(message)
    setToast(message)
    return ok
  }

  const present = () => {
    const el = bodyRef.current
    if (el?.requestFullscreen) void el.requestFullscreen()
  }

  const openTable = () => void navigate(tableLink)

  const stripRow = drillRow?.row ?? chartRow
  const points = stripRow ? buildPoints(stripRow, trendColumns, fy) : []
  const sparse = head ? isSparse(head.chartKind, points.map((p) => p.kind)) : false
  const monthly = monthGrain && (head?.frequency ?? 'monthly') === 'monthly'
  // The range strip goes with a chart of one line (a drill-in included); the item grid has its own 6M · 12M · 24M control.
  const multiSeries = !drillRow && chartRows.length > 1

  // Nothing to answer with in the selected column, by the rule the Overview counts with, so the dialog says
  // what the tile says: no reports in the window (§7.9), stopped reporting (§7.8), or not applicable.
  const selectedGrain = parsePeriod(period.period)?.grain ?? 'month'
  const coarseShown = shownWindow.grain !== selectedGrain
  const periodColumn = coarseShown ? windowColumns(period.period, selectedGrain, 1, fy).at(-1) : selectedColumn
  const standing =
    head && periodColumn && !isItems && !multiSeries
      ? periodStatus({
          scope,
          children,
          frequency: head.frequency,
          selected: periodColumn,
          coarse: coarseShown ? shownColumns : [],
          scale,
          noun,
          fy,
        })
      : null
  const unreported = standing?.notReported ?? null
  const noReports = unreported?.kind === 'window'
  const stopped = (unreported?.kind === 'stopped' || unreported?.kind === 'overdue') && !cellReported(cell)
  const lastShownAt = stopped && chartRow ? lastValuedIndex(chartRow, trendColumns) : -1
  const lastShown = lastShownAt >= 0 ? trendColumns[lastShownAt] : undefined
  // A stopped metric's range change runs to its last value, not to the empty months after it.
  const stripTo = lastShown ?? selectedColumn
  // Ending earlier, its longer ranges reach back past the months shown.
  if (lastShown && longFor !== metricKey) setLongFor(metricKey)

  const rangeShown = monthly && !sparse && !gridShown && !multiSeries && !noReports
  const itemRangeShown = monthly && gridShown
  /** A range's row and columns, ending at the strip's last month (YTD: that month's year to date); null until known. */
  const rangeWindow = (key: RangeKey): { row: components['schemas']['ViewRow']; columns: Column[] } | null => {
    const span = rangeMonths(key, stripTo?.period ?? period.period)
    // In a drill-in, the item's own.
    const row = drillRow?.row ?? scope
    const shown = rangeColumns(shownColumns, span, stripTo?.key)
    if (shown.length === span) return row ? { row, columns: shown } : null
    // Longer than the window shown: known once 24 months have loaded.
    const longRow = drillRow ? longView.data?.rows.find((r) => r.metricKey === metricKey && r.subjectId === drillRow.id) : longScope
    return longRow ? { row: longRow, columns: rangeColumns(longColumns, span, stripTo?.key) } : null
  }

  const shortcuts = useDialogShortcuts(
    frameRef,
    {
      prev: () => goTo(prevMetric),
      next: () => goTo(nextMetric),
      range: itemRangeShown
        ? (n) => {
            const key = ITEM_RANGES[n - 1]
            if (key) selectRange(key)
          }
        : rangeShown
          ? (n) => selectRange(RANGES[n - 1]!.key)
          : undefined,
      table: openTable,
      copyLink: () => void copyLink(),
      present,
      nextItem: drilling ? () => position.next && stepTo(position.next.id) : undefined,
      prevItem: drilling ? () => position.prev && stepTo(position.prev.id) : undefined,
    },
    { rangeKeys: gridShown ? 3 : 5 },
  )

  const waiting = view.isPending || (view.isPlaceholderData && !metricGroup)
  const busy = waiting || view.isPlaceholderData
  // When a load that followed a move settles, its announcement has done its job.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) clearAnnouncement()
    wasBusy.current = busy
  }, [busy, clearAnnouncement])

  const boardCells = head
    ? buildBoardRow({
        key: metricKey,
        category: { id: head.categoryId, name: '' },
        scope,
        head,
        children,
        noun,
        columns: trendColumns,
        scale,
        fyStart: fy,
      }).cells
    : []
  const since = sinceText(boardCells, boardCells.length - 1, trendColumns, statusLabel)
  const change = scope && cell?.display ? halfChange(headerChange(scope, cell, fy), columnKey) : null
  const goal = head && cell?.target != null ? formatMetricValue(head.format, cell.target) : ''
  const ytd = scope?.cells.find((c) => c.ytd && c.period === selectedColumn?.period)?.display ?? ''
  const unitOf = (measure: string) => versionContent?.measures.find((m) => m.key === measure)?.unit ?? ''
  const nameOfMeasure = (measure: string) => versionContent?.measures.find((m) => m.key === measure)?.name ?? measure
  // `$12.7M spent of $12.2M planned`, when a money plan's formula is a ratio of the cell's two measures (§6).
  const moneyParts = head?.chartKind === 'money_plan' && cell ? ratioParts(metric?.formula, cell.components) : null
  const planned =
    moneyParts && cell
      ? `${formatMoneyCompact(cell.components[moneyParts[0]]!, unitOf(moneyParts[0]))} spent of ${formatMoneyCompact(cell.components[moneyParts[1]]!, unitOf(moneyParts[1]))} planned`
      : ''
  // A sparse ratio metric's parts column (§7), from its latest cell that is a ratio of the formula's two measures.
  const ratio =
    sparse && chartRow && metric
      ? ([...chartRow.cells]
          .reverse()
          .map((c) => (c.ytd ? null : ratioParts(metric.formula, c.components)))
          .find((r) => r !== null) ?? null)
      : null
  const parts = ratio
    ? chartParts(metric?.name ?? head?.metricName ?? '', { key: ratio[0], name: nameOfMeasure(ratio[0]) }, { key: ratio[1], name: nameOfMeasure(ratio[1]) })
    : undefined
  const status = atScope?.status ?? ''
  // No company value: the value row leads with the worst of the lines shown (§7.6); its count names them with `withNouns`, as the tile does.
  const worstSeries = multiSeries ? multiSeriesHeader(chartRows, columnKey, statusColors, (k) => statusLabel(k) ?? k, noun) : null
  const markers = useVersionMarkers(trendColumns, metricKey)

  let chartArea
  let details = null
  if (view.isError) {
    chartArea = (
      <div role="alert" className="rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
        <p>We couldn’t load this chart: {view.error.message}</p>
        <button
          type="button"
          className="mt-2 rounded border border-ink/40 bg-white px-2 py-1 text-sm font-medium"
          onClick={() => void view.refetch()}
        >
          Try again
        </button>
      </div>
    )
  } else if (waiting) {
    chartArea = <div data-chart-region="" className={`mt-4 ${FOCUS_CHART_HEIGHT}`} aria-busy="true" />
  } else if (!chartRow || !head) {
    chartArea = <p role="alert">This metric has no rows for this selection.</p>
  } else if (noReports) {
    const first = shownColumns[0]
    const last = shownColumns[shownColumns.length - 1]
    const parsed = parsePeriod(period.period)
    chartArea = (
      <div
        data-chart-region=""
        data-testid="focus-no-reports"
        className={`flex flex-col items-center justify-center gap-1 px-4 text-center ${FOCUS_CHART_HEIGHT}`}
      >
        <p className="text-sm font-medium">
          No reports in the last {shownColumns.length} {columnUnit(last, shownColumns.length)}
        </p>
        {withNouns(({ reported }) => (
          <p className="max-w-[640px] text-balance text-xs text-ink/70">
            Nothing has been entered for {first?.fullLabel ?? ''} – {last?.fullLabel ?? ''}. Measured {MEASURED[head.frequency]}
            {metric ? `, by ${reported.one}` : ''}.
          </p>
        ))}
        {canEnter && (
          <Link to={`/entry?period=${period.period}`} className="mt-1 text-sm font-medium text-accent-deep hover:underline">
            Enter {parsed ? periodLabel(parsed, fy) : period.period} data<span aria-hidden="true"> ›</span>
          </Link>
        )}
      </div>
    )
  } else if (isItems) {
    const total = itemRows.length
    chartArea = (
      <div data-chart-region="" aria-busy={view.isPlaceholderData || undefined}>
        {withNouns(({ children: itemNoun }) =>
          drillRow ? (
            <ItemDrillIn
              head={head}
              row={drillRow}
              columns={trendColumns}
              scale={statusColors}
              noun={itemNoun}
              total={total}
              onBack={backToGrid}
              headingRef={headingRef}
              fy={fy}
              markers={markers}
              position={position}
              onStep={stepTo}
            />
          ) : (
            <ItemGrid
              head={scope ?? head}
              rows={itemRows}
              columns={itemColumns}
              scale={statusColors}
              direction={head.direction}
              noun={itemNoun}
              sort={sort}
              onSort={changeSort}
              filter={filter}
              onFilter={setFilter}
              onOpenItem={openItem}
              restoreId={restoreId}
              announce={announce}
              silentOpen={silentOpen}
              onSilentOpen={setSilentOpen}
              range={
                itemRangeShown
                  ? {
                      control: (
                        <SegmentedControl
                          label="Range"
                          options={ITEM_RANGES.map((key) => ({ value: key, label: key }))}
                          value={itemRange}
                          onChange={selectRange}
                        />
                      ),
                      minCount: rangeMonths(ITEM_RANGES[0], period.period),
                      maxCount: rangeMonths(ITEM_RANGES[ITEM_RANGES.length - 1]!, period.period),
                    }
                  : undefined
              }
            />
          ),
        )}
      </div>
    )
  } else {
    chartArea = (
      <>
        <div data-testid="focus-value-row" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {worstSeries?.worst ? (
            <>
              <span className="text-xs text-ink/70">Worst</span>
              <span className="text-base font-semibold">{worstSeries.worst.name}</span>
              <span className="text-[28px] leading-9 font-semibold tabular-nums">{worstSeries.worst.display}</span>
              {worstSeries.worst.status && (
                <span
                  role="img"
                  aria-label={statusLabel(worstSeries.worst.status) ?? worstSeries.worst.status}
                  title={statusLabel(worstSeries.worst.status)}
                  className="inline-flex self-center"
                >
                  <StatusChip status={worstSeries.worst.status} scale={statusColors} size="lg" />
                </span>
              )}
              {worstSeries.count &&
                withNouns(({ children: forms }) => (
                  <span className="text-sm text-ink/70">
                    {multiSeriesHeader(chartRows, columnKey, statusColors, (k) => statusLabel(k) ?? k, forms.many).count}
                  </span>
                ))}
            </>
          ) : stopped ? (
            // The last value as history, with no current chip (§7.8).
            lastShown ? (
              <>
                <span className="text-[28px] leading-9 font-semibold tabular-nums text-ink/70">
                  {chartRow.cells.find((c) => cellKey(c) === lastShown.key)?.display}
                </span>
                <span data-testid="stopped-since" className="text-sm text-ink/80">
                  Last reported {lastShown.fullLabel}
                  {/* A no-break space keeps the `·` off the start of a wrapped line. */}
                  {lastShownAt < trendColumns.length - 1 && (
                    <span className="text-ink/70">{`\u00a0· nothing for ${spanLabel(trendColumns.slice(lastShownAt + 1))}`}</span>
                  )}
                </span>
              </>
            ) : (
              <span className="text-xl font-semibold text-ink/80">{unreported?.text}</span>
            )
          ) : unreported?.kind === 'na' ? (
            <span className="text-xl font-semibold text-ink/80">{unreported.text}</span>
          ) : (
            <>
              <span className="text-[28px] leading-9 font-semibold tabular-nums">{cell?.display || '—'}</span>
              {status && (
                <span role="img" aria-label={statusLabel(status) ?? status} title={statusLabel(status)} className="inline-flex self-center">
                  <StatusChip status={status} scale={statusColors} size="lg" />
                </span>
              )}
              {change && (
                <span data-tone={change.move.tone} className={`text-base font-medium tabular-nums ${MOVE_CLASS[change.move.tone]}`}>
                  {change.move.arrow && <span aria-hidden="true">{change.move.arrow} </span>}
                  <span>{change.text}</span>
                </span>
              )}
              {atScope?.caption &&
                withNouns(({ children: forms }) => <span className="text-sm text-ink/70">{scopeStatus(forms).caption}</span>)}
            </>
          )}
          {since && !worstSeries?.worst && <span className="text-sm text-ink/70">{since}</span>}
          {goal && <span className="text-sm text-ink/70">Goal {goal}</span>}
          {ytd && <span className="text-sm text-ink/70">YTD {ytd}</span>}
          {planned && <span className="text-sm text-ink/70">{planned}</span>}
        </div>
        <div data-chart-region="" className="mt-2" aria-busy={view.isPlaceholderData || undefined}>
          <MetricChart
            size="focus"
            row={chartRow}
            chartRows={chartRows}
            columns={trendColumns}
            currentColumnKey={columnKey}
            currentDisplay={cell?.display ?? ''}
            currentStatus={status}
            statusLabel={statusLabel}
            scale={statusColors}
            tableTo={tableLink}
            fiscalYearStartMonth={fy}
            header={false}
            markers={markers}
            parts={parts}
            selectedPeriod={monthGrain ? period.period : undefined}
          />
        </div>
      </>
    )
    details =
      children.length > 0 &&
      withNouns((nouns) => (
        <Breakdown
          head={head}
          children={children}
          columns={shownColumns.slice(-12)}
          columnKey={columnKey}
          scale={statusColors}
          direction={head.direction}
          noun={nouns.children}
          onScope={(id) => updatePeriod({ scope: id })}
          fyStart={fy}
        />
      ))
  }

  const nameOf = (id: string) => metricGroup?.rows.find((r) => r.subjectId === id)?.subjectName ?? unitName(id)
  const title = layout[idx]?.name ?? head?.metricName ?? metricKey

  return (
    <>
      <header className={HEADER}>
        <FocusHeader
          eyebrow={layout[idx]?.category ?? ''}
          title={title}
          position={{ index: idx + 1, total: layout.length }}
          prev={{ name: prevMetric?.name ?? '', onGo: () => goTo(prevMetric) }}
          next={{ name: nextMetric?.name ?? '', onGo: () => goTo(nextMetric) }}
          samOpen={sam.isOpen}
          onAskSam={() =>
            sam.open({
              page: 'focus',
              scorecardId,
              metricKey,
              ...(period.ready ? { period: period.period } : {}),
              ...(period.scope ? { scope: period.scope } : {}),
            })
          }
          menu={
            <MoreMenu
              onCopyLink={copyLink}
              onTable={openTable}
              onPresent={present}
              onExport={(format) => (format === 'png' ? void exportPng() : format === 'svg' ? exportSvg() : exportCsv())}
              shortcuts={{ enabled: shortcuts.enabled, onToggle: shortcuts.setEnabled }}
            />
          }
        />
        {head &&
          withNouns((nouns) => (
            <DefinitionLine
              metric={metric}
              rule={cell?.rule ?? metric?.rule}
              row={head}
              statusLabel={statusLabel}
              isAdmin={me.data?.role === 'admin'}
              noun={nouns.reported}
              perSubject={ownTargets(metric?.rule, scale, nameOf)}
            />
          ))}
      </header>
      <div ref={bodyRef} data-body={bodyKind} className={BODY}>
        <p role="status" data-testid="dialog-live" className="sr-only">
          {announcement || (busy ? 'Loading chart' : '')}
        </p>
        {exportError && (
          <p role="alert" className="mb-2 text-sm text-status-r">
            {exportError}
          </p>
        )}
        {chartArea}
        <RangeStrip
          selected={range}
          onSelect={selectRange}
          hidden={!rangeShown}
          caption={stripTo ? `Change from the first month in each range to ${stripTo.fullLabel}` : ''}
          changeFor={(key) => {
            const w = rangeWindow(key)
            return w ? rangeChange(w.row, w.columns) : null
          }}
          noDataFor={
            drillRow
              ? (key) => {
                  const w = rangeWindow(key)
                  const first = w?.columns[0]
                  const c = first ? w.row.cells.find((x) => cellKey(x) === first.key) : undefined
                  return w !== null && !(c && c.naReason === '' && c.value != null)
                }
              : undefined
          }
        />
        {drillRow && head && (
          <ItemMonths
            row={drillRow.row}
            columns={trendColumns}
            scale={statusColors}
            format={head.format}
            valueLabel={valueHeader(head.metricName)}
            open={monthsOpen}
            onOpenChange={setMonthsOpen}
          />
        )}
        {!isItems && details}
        {/* The switch shows at every width; the key hints only where there is a keyboard to use them. */}
        <div data-hints="" className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-4 text-ink/70">
          {shortcuts.enabled && (
            <>
              <span data-hint="" className="hidden sm:inline">
                <Kbd>←</Kbd> <Kbd>→</Kbd> previous / next metric
              </span>
              {drilling &&
                withNouns(({ children: forms }) => (
                  <span data-hint="" className="hidden sm:inline">
                    <Kbd>J</Kbd> <Kbd>K</Kbd> next / previous {forms.one}
                  </span>
                ))}
              {(rangeShown || itemRangeShown) && (
                <span data-hint="" className="hidden sm:inline">
                  <Kbd>1</Kbd>–<Kbd>{itemRangeShown ? '3' : '5'}</Kbd> range
                </span>
              )}
              <span data-hint="" className="hidden sm:inline">
                <Kbd>T</Kbd> table
              </span>
              <span data-hint="" className="hidden sm:inline">
                <Kbd>L</Kbd> copy link
              </span>
            </>
          )}
          <span data-hint="" className="hidden sm:inline">
            <Kbd>Esc</Kbd> {drilling ? withNouns(({ children: forms }) => `back to all ${forms.many}`) : 'close'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={shortcuts.enabled}
            className="h-6 rounded-md px-1.5 font-medium text-ink/80 hover:bg-ink/5"
            onClick={() => shortcuts.setEnabled(!shortcuts.enabled)}
          >
            Shortcuts: {shortcuts.enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>
      {toast && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md bg-ink px-3 py-1.5 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      )}
    </>
  )
}

/** Full-screen focus dialog for a metric chart or the scorecard table. */
export function FocusDialog() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const scorecards = useScorecards()
  const scorecardName = scorecards.data?.scorecards.find((s) => s.id === scorecardId)?.name ?? 'Scorecard'
  const focusId = params.get('focus') ?? ''
  const open = focusId !== ''

  const { request: layoutRequest, ready } = useScorecardViewRequest()
  const layoutView = useView(ready && open && focusId !== 'table' ? scorecardId : undefined, layoutRequest)
  const layout = useMemo(() => (layoutView.data ? metricsInLayout(layoutView.data) : []), [layoutView.data])

  const frameRef = useRef<HTMLDivElement>(null)
  const escapeRef = useRef<(() => boolean) | null>(null)

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('focus')
      // The drill-in and the grid's sort belong to the dialog.
      next.delete(ITEM_PARAM)
      next.delete(SORT_PARAM)
      return next
    })
  }, [setParams])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/50" />
        <Dialog.Content
          ref={frameRef}
          aria-describedby={undefined}
          // The dialog itself takes focus, so its name is read first and no control shows a ring before it is used;
          // unless focus already moved inside, to a drill-in heading.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            if (!frameRef.current?.contains(document.activeElement)) frameRef.current?.focus()
          }}
          // Escape in a filter with text clears the filter (the field does that); in a drill-in it goes back to
          // the grid; only then does it close the dialog.
          onEscapeKeyDown={(e) => {
            const t = e.target
            if (t instanceof HTMLInputElement && t.type === 'search' && t.value !== '') e.preventDefault()
            else if (escapeRef.current?.()) e.preventDefault()
          }}
          onCloseAutoFocus={(e) => {
            if (focusReturnRef.current) {
              e.preventDefault()
              focusReturnRef.current.focus()
              focusReturnRef.current = null
            }
          }}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden rounded-none bg-cream shadow-xl outline-none md:inset-8 md:rounded-lg"
        >
          {focusId === 'table' ? (
            <>
              <header className={HEADER}>
                <div className="flex items-start gap-3">
                  <Dialog.Title className="min-w-0 flex-1 text-xl font-semibold text-accent-deep">{scorecardName} table</Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      title="Close (Esc)"
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink/80 hover:bg-ink/5"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </Dialog.Close>
                </div>
              </header>
              <div className={BODY}>
                <TablePage scorecardId={scorecardId} scorecardName={scorecardName} measureWidth={1600} embeddedInFocus />
              </div>
            </>
          ) : focusId ? (
            <MetricFocus metricKey={focusId} layout={layout} frameRef={frameRef} escapeRef={escapeRef} />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
