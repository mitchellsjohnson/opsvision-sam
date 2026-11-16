import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { buildMonthTrendColumns, buildTrendColumns, type Column } from '../columns'
import type { BoardCell } from './statusBoard'
import { sinceText, thresholdText, type ThresholdOptions } from './statusText'

type StatusRule = components['schemas']['StatusRule']

const label = (k: string) => ({ G: 'Green', Y: 'Yellow', R: 'Red' })[k]

function base(over: Partial<ThresholdOptions> = {}): ThresholdOptions {
  return {
    format: 'percent0',
    direction: 'higher_better',
    chartKind: 'ratio',
    frequency: 'monthly',
    statusLabel: label,
    surface: 'tile',
    ...over,
  }
}

function bands(list: [string, string, number][]): StatusRule {
  return { type: 'bands', bands: list.map(([status, op, value]) => ({ status, op, value })) }
}

const lower = (yellow: number, red: number) => bands([['G', '<=', yellow], ['Y', '<=', red], ['R', '', 0]])

function change(green: number, yellow: number): StatusRule {
  return { ...bands([['G', '>=', green], ['Y', '>=', yellow], ['R', '', 0]]), type: 'change', compare: 'prior_period' }
}

const b90_80 = bands([['G', '>=', 90], ['Y', '>=', 80], ['R', '', 0]])
const uptimeBands = bands([['G', '>=', 99.9], ['Y', '>', 99.8], ['R', '', 0]])

describe('thresholdText', () => {
  it('bands higher better', () => {
    expect(thresholdText(b90_80, base({ format: 'percent0', direction: 'higher_better', chartKind: 'ratio' }))).toBe(
      'Green at 90% or better · Red below 80%',
    )
  })

  it('lower better score', () =>
    expect(thresholdText(lower(450, 600), base({ format: 'number0', direction: 'lower_better', chartKind: 'line' }))).toBe(
      'Lower is better · Yellow above 450 · Red above 600',
    ))

  it('days', () =>
    expect(thresholdText(lower(14, 17), base({ format: 'days0', direction: 'lower_better', chartKind: 'days' }))).toBe(
      'Fewer days is better · Green at 14 days or fewer · Red above 17 days',
    ))

  it('money plan', () =>
    expect(thresholdText(lower(110, 120), base({ format: 'percent0', direction: 'lower_better', chartKind: 'money_plan' }))).toBe(
      'Under plan is fine · Yellow above 110% · Red above 120%',
    ))

  it('change rule tile and focus', () => {
    expect(thresholdText(change(0, -5), base({ chartKind: 'change', direction: 'lower_better', surface: 'tile' }))).toBe(
      'Lower is better · judged on change vs the prior month',
    )
    expect(thresholdText(change(0, -5), base({ chartKind: 'change', direction: 'lower_better', surface: 'focus' }))).toBe(
      'Lower is better · judged on change vs the prior month · Green: any improvement · Yellow: up to 5% worse · Red: more than 5% worse',
    )
  })

  it('per-subject bands', () => {
    const o = base({
      format: 'percent2',
      chartKind: 'uptime',
      perSubject: [{ name: 'Status Page', value: 99.5 }],
      noun: { one: 'service', many: 'services' },
    })
    expect(thresholdText(uptimeBands, { ...o, surface: 'tile' })).toBe('Green at 99.90% or better · 1 service has its own target')
    expect(thresholdText(uptimeBands, { ...o, surface: 'focus' })).toBe('Green at 99.90% or better; Status Page is held to 99.50%')
  })

  it('counts several per-subject targets in the plural', () => {
    const o = base({
      format: 'percent2',
      chartKind: 'uptime',
      perSubject: [
        { name: 'Status Page', value: 99.5 },
        { name: 'Webhooks', value: 99 },
      ],
      noun: { one: 'service', many: 'services' },
    })
    expect(thresholdText(uptimeBands, o)).toBe('Green at 99.90% or better · 2 services have their own targets')
  })

  it('coarse prefix', () => expect(thresholdText(b90_80, base({ frequency: 'quarterly' }))).toMatch(/^Reported quarterly · Green at 90%/))

  it('uses the tenant labels and every level of a four-level scale', () => {
    const four = (k: string) => ({ A: 'On track', B: 'Watch', C: 'At risk', D: 'Off track' })[k]
    const rule = bands([['A', '<=', 10], ['B', '<=', 20], ['C', '<=', 30], ['D', '', 0]])
    expect(thresholdText(rule, base({ format: 'number0', direction: 'lower_better', chartKind: 'line', statusLabel: four }))).toBe(
      'Lower is better · Watch above 10 · At risk above 20 · Off track above 30',
    )
  })

  it('keeps a threshold finer than the format shows', () => {
    expect(thresholdText(bands([['G', '>=', 89.5], ['R', '', 0]]), base())).toBe('Green at 89.5% or better · Red below 89.5%')
  })

  it('reads scale rules as bands', () => {
    const rule: StatusRule = {
      type: 'scale',
      scale: [
        { status: 'R', min: 0 },
        { status: 'Y', min: 80 },
        { status: 'G', min: 90 },
      ],
    }
    expect(thresholdText(rule, base())).toBe('Green at 90% or better · Red below 80%')
  })
})

const MONTHS4 = buildMonthTrendColumns('2026-M10', 4, 1)
const MONTHS12 = buildTrendColumns('2026-M10', 1)
const QUARTERS2 = buildTrendColumns('2026-Q3', 1).slice(-2)

function cells(columns: Column[], statuses: string[]): BoardCell[] {
  return columns.map((c, i) => ({
    key: c.key,
    kind: statuses[i] ? 'status' : 'missing',
    status: statuses[i] ?? '',
    display: '',
    naReason: '',
    change: null,
    caption: '',
  }))
}

describe('sinceText', () => {
  it('since: streak, capped, quarterly in months', () => {
    const cellsGYRR = cells(MONTHS4, ['G', 'Y', 'R', 'R'])
    const allRed12 = cells(MONTHS12, MONTHS12.map(() => 'R'))
    const quartersYY = cells(QUARTERS2, ['Y', 'Y'])
    const quartersGY = cells(QUARTERS2, ['G', 'Y'])
    expect(sinceText(cellsGYRR, 3, MONTHS4, label)).toBe('Red since Sep 2026 · 2 months')
    expect(sinceText(allRed12, 11, MONTHS12, label)).toBe('Red all 12 months shown')
    expect(sinceText(quartersYY, 1, QUARTERS2, label)).toBe('Yellow all 2 quarters shown')
    expect(sinceText(quartersGY, 1, QUARTERS2, label)).toBe('Yellow since Q3 FY2026 · 3 months')
  })

  it('says one month in the singular', () => {
    expect(sinceText(cells(MONTHS4, ['G', 'G', 'Y', 'R']), 3, MONTHS4, label)).toBe('Red since Oct 2026 · 1 month')
  })

  it('is empty when the cell has no status', () => {
    expect(sinceText(cells(MONTHS4, ['G', 'G', 'Y', '']), 3, MONTHS4, label)).toBe('')
  })
})
