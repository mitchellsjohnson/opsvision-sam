import { describe, expect, it } from 'vitest'
import { applyLayout, defaultLayout } from './layout'
import { distancePastWorst, needsAttention } from './needsAttention'
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
})

describe('needsAttention', () => {
  it('three off-track metrics keep only the two furthest past the threshold and the next by category order is dropped at the cap of 3', () => {
    const offTrack = (metricKey: string, categoryOrder: number, value: number) => ({
      metricKey,
      name: metricKey,
      categoryOrder,
      status: 'R',
      value,
      change: null,
      direction: 'higher_better' as const,
      rule: higherBands,
      priorStatus: 'R',
    })
    const items = [
      offTrack('a', 1, 70),
      offTrack('b', 2, 75),
      offTrack('c', 3, 80),
      {
        metricKey: 'w',
        name: 'Worsened',
        categoryOrder: 4,
        status: 'Y',
        value: 82,
        change: -3,
        direction: 'higher_better' as const,
        rule: { type: 'change' as const },
        priorStatus: 'G',
      },
    ]
    expect(distancePastWorst(items[0]!, scale)).toBeGreaterThan(distancePastWorst(items[1]!, scale))
    expect(distancePastWorst(items[2]!, scale)).toBe(0)
    const picked = needsAttention(items, scale).map((i) => i.metricKey)
    expect(picked).toEqual(['a', 'b', 'w'])
    expect(picked).not.toContain('c')
  })

  it('a worsened watch metric ranks above a stable watch metric', () => {
    const items = [
      {
        metricKey: 'stable',
        name: 'Stable',
        categoryOrder: 1,
        status: 'Y',
        value: 85,
        change: 0,
        direction: 'higher_better' as const,
        rule: higherBands,
        priorStatus: 'Y',
      },
      {
        metricKey: 'worse',
        name: 'Worse',
        categoryOrder: 2,
        status: 'Y',
        value: 82,
        change: -2,
        direction: 'higher_better' as const,
        rule: higherBands,
        priorStatus: 'G',
      },
    ]
    expect(needsAttention(items, scale).map((i) => i.metricKey)).toEqual(['worse', 'stable'])
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
