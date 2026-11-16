import { describe, expect, it } from 'vitest'
import { buildTrendColumns, coarseColumns } from '../columns'
import { applyLayout, defaultLayout } from './layout'
import { distancePastWorst, needsAttention, streakMonths, type NeedsAttentionItem } from './needsAttention'
import type { BoardCell } from './statusBoard'
import { sinceText } from './statusText'
import { statusAtScope } from './statusAtScope'
import { periodWindowSize, windowStart } from './window'

const scale = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]

function cell(over: { period: string; ytd?: boolean; value?: number | null; status?: string; naReason?: string }) {
  return {
    period: over.period,
    ytd: over.ytd ?? false,
    value: over.value ?? null,
    status: over.status ?? '',
    naReason: over.naReason ?? '',
  }
}

const higherBands = {
  type: 'bands' as const,
  bands: [
    { status: 'G', op: '>=', value: 90 },
    { status: 'Y', op: '>=', value: 80 },
    { status: 'R', op: '', value: 0 },
  ],
}

describe('statusAtScope', () => {
  it('a scope cell with no value and two reported children returns the worse status and caption worst of 2 segments', () => {
    const scope = {
      cells: [cell({ period: '2026-M10', value: null, status: '' })],
    }
    const children = [
      { cells: [cell({ period: '2026-M10', value: 92, status: 'G' })] },
      { cells: [cell({ period: '2026-M10', value: 70, status: 'R' })] },
    ]
    expect(statusAtScope({ scope, children, columnKey: '2026-M10', scale, noun: 'segments' })).toEqual({
      status: 'R',
      caption: 'worst of 2 segments',
    })
  })

  it('says "worst of 1 service" for a single reported child', () => {
    const scope = { cells: [] }
    const children = [{ cells: [cell({ period: '2026-M10', value: 99.2, status: 'R' })] }]
    expect(statusAtScope({ scope, children, columnKey: '2026-M10', scale, noun: 'services' }).caption).toBe('worst of 1 service')
  })

  it('adds how many children did not report', () => {
    const reported = Array.from({ length: 21 }, (_, i) => ({
      cells: [cell({ period: '2026-M10', value: 99.9, status: i === 0 ? 'R' : 'G' })],
    }))
    const silent = [
      { cells: [cell({ period: '2026-M10' })] },
      { cells: [cell({ period: '2026-M10', naReason: 'Retired' })] },
      { cells: [] },
    ]
    expect(
      statusAtScope({ scope: { cells: [] }, children: [...reported, ...silent], columnKey: '2026-M10', scale, noun: 'services' }),
    ).toEqual({ status: 'R', caption: 'worst of 21 services · 3 not reported' })
  })
})

describe('applyLayout', () => {
  it('drops an unknown saved id and appends a metric the save omitted, directly after the last item of its section', () => {
    const fallback = defaultLayout(
      [{ id: 'delivery' }, { id: 'quality' }],
      {
        delivery: [{ key: 'on_time' }, { key: 'spend' }],
        quality: [{ key: 'defects' }],
      },
    )
    const saved = [
      { id: 'widget:health', size: 'wide' as const, hidden: false },
      { id: 'metric:removed', size: 'small' as const, hidden: false },
      { id: 'section:delivery', size: 'wide' as const, hidden: false },
      { id: 'metric:on_time', size: 'small' as const, hidden: false },
    ]
    const merged = applyLayout(fallback, saved)
    expect(merged.map((i) => i.id)).not.toContain('metric:removed')
    const spendIdx = merged.findIndex((i) => i.id === 'metric:spend')
    const onTimeIdx = merged.findIndex((i) => i.id === 'metric:on_time')
    const deliveryIdx = merged.findIndex((i) => i.id === 'section:delivery')
    expect(spendIdx).toBeGreaterThan(onTimeIdx)
    expect(spendIdx).toBeGreaterThan(deliveryIdx)
  })

  it('appends omitted widgets and sections after saved items, not by fallback index', () => {
    const fallback = defaultLayout([{ id: 'a' }, { id: 'b' }], {
      a: [{ key: 'm1' }],
      b: [{ key: 'm2' }],
    })
    const saved = [
      { id: 'widget:health', size: 'wide' as const, hidden: false },
      { id: 'section:a', size: 'wide' as const, hidden: false },
      { id: 'metric:m1', size: 'small' as const, hidden: false },
    ]
    const merged = applyLayout(fallback, saved)
    const ids = merged.map((i) => i.id)
    const lastSavedIdx = ids.findIndex((id) => id === 'metric:m1')
    expect(ids.indexOf('widget:needs')).toBeGreaterThan(lastSavedIdx)
    expect(ids.indexOf('section:b')).toBeGreaterThan(lastSavedIdx)
    expect(ids.indexOf('metric:m2')).toBeGreaterThan(ids.indexOf('section:b'))
    expect(ids.slice(0, saved.length)).toEqual(saved.map((i) => i.id))
  })
})

const LABELS: Record<string, string> = { G: 'Green', Y: 'Yellow', R: 'Red' }

/** A needs-attention input with no history beyond the selected period unless overridden. */
function attention(over: Partial<NeedsAttentionItem> & { metricKey: string; status: string }): NeedsAttentionItem {
  return {
    name: over.metricKey,
    categoryOrder: 1,
    value: null,
    change: null,
    direction: 'higher_better',
    rule: higherBands,
    priorStatus: over.status,
    streakMonths: 1,
    priorLabel: LABELS[over.priorStatus ?? over.status] ?? '',
    label: LABELS[over.status] ?? over.status,
    since: '',
    ...over,
  }
}

/**
 * A Red metric `distance` band widths past the Red line (80, one width 10);
 * a New Red fell from Green, any other has held for `streakMonths`.
 */
function red(metricKey: string, o: { streakMonths?: number; distance?: number; newRed?: boolean } = {}): NeedsAttentionItem {
  const prior = o.newRed ? 'G' : 'R'
  const streakMonths = o.newRed ? 1 : (o.streakMonths ?? 1)
  return attention({ metricKey, status: 'R', value: 80 - (o.distance ?? 0) * 10, priorStatus: prior, priorLabel: LABELS[prior]!, streakMonths })
}

describe('needsAttention', () => {
  it('three off-track metrics with distances 2, 1, and 0 beat a worsened watch metric at the cap of 3', () => {
    const offTrack = (metricKey: string, categoryOrder: number, value: number) =>
      attention({ metricKey, categoryOrder, status: 'R', value, priorStatus: 'R' })
    const items = [
      offTrack('a', 1, 60),
      offTrack('b', 2, 70),
      offTrack('c', 3, 80),
      attention({ metricKey: 'w', categoryOrder: 4, status: 'Y', value: 82, change: -3, rule: { type: 'change' }, priorStatus: 'G' }),
    ]
    expect(distancePastWorst(items[0]!, scale)).toBe(2)
    expect(distancePastWorst(items[1]!, scale)).toBe(1)
    expect(distancePastWorst(items[2]!, scale)).toBe(0)
    const { shown, totals } = needsAttention(items, scale)
    expect(shown.map((i) => i.metricKey)).toEqual(['a', 'b', 'c'])
    expect(totals).toEqual({ red: 3, slipping: 1, middle: 0 })
  })

  it('four off-track metrics at cap 3 keep distance 3, distance 2, then lowest category order at distance 0', () => {
    const offTrack = (metricKey: string, categoryOrder: number, value: number) =>
      attention({ metricKey, categoryOrder, status: 'R', value, priorStatus: 'R' })
    const items = [offTrack('far', 5, 50), offTrack('mid', 4, 60), offTrack('tieA', 1, 80), offTrack('tieB', 2, 80)]
    expect(distancePastWorst(items[0]!, scale)).toBe(3)
    expect(distancePastWorst(items[1]!, scale)).toBe(2)
    expect(distancePastWorst(items[2]!, scale)).toBe(0)
    expect(distancePastWorst(items[3]!, scale)).toBe(0)
    expect(needsAttention(items, scale).shown.map((i) => i.metricKey)).toEqual(['far', 'mid', 'tieA'])
  })

  it('a worsened watch metric ranks above a stable watch metric', () => {
    const items = [
      attention({ metricKey: 'stable', categoryOrder: 1, status: 'Y', value: 85, change: 0, priorStatus: 'Y' }),
      attention({ metricKey: 'worse', categoryOrder: 2, status: 'Y', value: 82, change: -2, priorStatus: 'G' }),
    ]
    const { shown, totals } = needsAttention(items, scale)
    expect(shown.map((i) => i.metricKey)).toEqual(['worse', 'stable'])
    expect(shown.map((i) => i.tier)).toEqual([2, 3])
    expect(totals).toEqual({ red: 0, slipping: 1, middle: 1 })
  })

  it('one slot for the most severe New Red, the rest by streak then distance', () => {
    const r = needsAttention(
      [
        red('backlog', { streakMonths: 4, distance: 0.5 }),
        red('defects', { streakMonths: 2, distance: 3 }),
        red('epics', { newRed: true, distance: 0.1 }),
        red('uptime', { newRed: true, distance: 2.4 }),
        red('csat', { newRed: true, distance: 0.8 }),
      ],
      scale,
    )
    expect(r.shown.map((i) => i.metricKey)).toEqual(['backlog', 'defects', 'uptime'])
    expect(r.shown.map((i) => i.newRed)).toEqual([false, false, true])
    expect(r.shown.map((i) => i.streakMonths)).toEqual([4, 2, 1])
    expect(r.shown[2]!.distance).toBeCloseTo(2.4)
    expect(r.totals.red).toBe(5)
  })

  it('with no New Red, every slot goes by streak, then distance, then category order', () => {
    const r = needsAttention(
      [
        red('short-far', { streakMonths: 1, distance: 5 }),
        red('long', { streakMonths: 6, distance: 0.2 }),
        attention({ metricKey: 'tie-b', status: 'R', categoryOrder: 3, value: 70, streakMonths: 3 }),
        attention({ metricKey: 'tie-a', status: 'R', categoryOrder: 2, value: 70, streakMonths: 3 }),
      ],
      scale,
    )
    expect(r.shown.map((i) => i.metricKey)).toEqual(['long', 'tie-a', 'tie-b'])
  })

  it('a Red with no prior period is not a New Red', () => {
    const r = needsAttention([attention({ metricKey: 'fresh', status: 'R', priorStatus: '', priorLabel: '', since: 'Red in the only month shown' })], scale)
    expect(r.shown[0]!.newRed).toBe(false)
    expect(r.shown[0]!.reason).toBe('Red in the only month shown')
  })

  it('reasons', () => {
    const months = buildTrendColumns('2026-M10', 1)
    const run = (statuses: string[]): BoardCell[] =>
      statuses.map((status, i) => ({ key: months[i]!.key, kind: 'status', status, display: '', naReason: '', change: null, caption: '' }))
    const label = (k: string) => LABELS[k]
    // Red from Jul through Oct: a streak of 4.
    const fromJul = run(['G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'R', 'R', 'R', 'R'])
    const allRed = run(Array.from({ length: 12 }, () => 'R'))
    const yellow = run(['G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'Y', 'Y'])
    const r = needsAttention(
      [
        attention({ metricKey: 'jul', status: 'R', streakMonths: 4, since: sinceText(fromJul, 11, months, label) }),
        attention({ metricKey: 'window', status: 'R', streakMonths: 12, categoryOrder: 2, since: sinceText(allRed, 11, months, label) }),
        attention({ metricKey: 'new', status: 'R', priorStatus: 'G', priorLabel: 'Green', since: 'Red since Oct 2026 · 1 month' }),
      ],
      scale,
    )
    expect(Object.fromEntries(r.shown.map((i) => [i.metricKey, i.reason]))).toEqual({
      jul: 'Red since Jul 2026 · 4 months',
      window: 'Red all 12 months shown',
      new: 'New Red · fell from Green',
    })
    const lower = needsAttention(
      [
        attention({ metricKey: 'slipping', status: 'Y', priorStatus: 'G', priorLabel: 'Green', since: 'Yellow since Oct 2026 · 1 month' }),
        attention({ metricKey: 'watch', status: 'Y', streakMonths: 2, since: sinceText(yellow, 11, months, label) }),
      ],
      scale,
    )
    expect(lower.shown.map((i) => i.reason)).toEqual(['Fell from Green', 'Yellow since Sep 2026 · 2 months'])
  })

  it('an item metric names how many items share its status', () => {
    const r = needsAttention([attention({ metricKey: 'uptime', status: 'R', priorStatus: 'G', priorLabel: 'Green', countReason: '1 service Red' })], scale)
    expect(r.shown[0]!.reason).toBe('1 service Red')
  })

  it('a custom scale: the worst rank is tier 1 and labels come from the item', () => {
    const four = [
      { key: 'A', rank: 1 },
      { key: 'B', rank: 2 },
      { key: 'C', rank: 3 },
      { key: 'D', rank: 4 },
    ]
    const r = needsAttention(
      [
        attention({ metricKey: 'off', status: 'D', label: 'Off track', priorStatus: 'B', priorLabel: 'Good', rule: { type: 'bands' } }),
        attention({ metricKey: 'watch', status: 'C', label: 'Watch', priorStatus: 'C', priorLabel: 'Watch', since: 'Watch since Aug 2026 · 3 months' }),
        attention({ metricKey: 'great', status: 'A', label: 'Great' }),
      ],
      four,
    )
    expect(r.shown.map((i) => [i.metricKey, i.tier, i.reason])).toEqual([
      ['off', 1, 'New Off track · fell from Good'],
      ['watch', 3, 'Watch since Aug 2026 · 3 months'],
    ])
    expect(r.totals).toEqual({ red: 1, slipping: 0, middle: 1 })
  })
})

describe('streakMonths', () => {
  it('monthly: the run of the status ending at the index', () => {
    const months = buildTrendColumns('2026-M10', 1)
    const cells: BoardCell[] = months.map((c, i) => ({
      key: c.key,
      kind: 'status',
      status: i >= 8 ? 'R' : 'G',
      display: '',
      naReason: '',
      change: null,
      caption: '',
    }))
    expect(streakMonths(cells, 11, months)).toBe(4)
    expect(streakMonths(cells, 7, months)).toBe(8)
  })

  it('quarterly streaks are measured in months', () => {
    const quarters = coarseColumns('2026-M10', 'quarter', 4, 1)
    const cells: BoardCell[] = quarters.map((c, i) => ({
      key: c.key,
      kind: 'status',
      status: i >= 2 ? 'R' : 'Y',
      display: '',
      naReason: '',
      change: null,
      caption: '',
    }))
    expect(streakMonths(cells, 3, quarters)).toBe(6)
    expect(streakMonths(cells, 1, quarters)).toBe(6)
  })

  it('no status, no streak', () => {
    const months = buildTrendColumns('2026-M10', 1)
    const cells: BoardCell[] = months.map((c) => ({ key: c.key, kind: 'missing', status: '', display: '', naReason: '', change: null, caption: '' }))
    expect(streakMonths(cells, 11, months)).toBe(0)
  })
})

describe('periodWindowSize', () => {
  it('periodWindowSize(960) === 6', () => {
    expect(periodWindowSize(960)).toBe(6)
  })

  it('periodWindowSize(1700) === 12', () => {
    expect(periodWindowSize(1700)).toBe(12)
  })
})

describe('windowStart', () => {
  it('the window ending at the selected month does not include later months', () => {
    const columnCount = 12
    const visible = periodWindowSize(960)
    const selectedIndex = 8
    const start = windowStart(columnCount, visible, selectedIndex)
    const end = start + visible
    expect(end - 1).toBe(selectedIndex)
    expect(end).toBeLessThanOrEqual(columnCount)
    expect(selectedIndex).toBeLessThan(columnCount - 1)
  })
})
