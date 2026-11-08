import { describe, expect, it } from 'vitest'
import type { Methodology } from '../../api/queries'
import { metric } from '../../test/methodologyFixtures'
import { applyPreset, defaultWeights, PRESETS, presetKeys, type PresetId } from './presets'

const empty = (): Methodology => ({ categories: [{ id: 'delivery', name: 'Delivery', order: 1 }], measures: [], metrics: [] })

const GYR = [
  { status: 'G', op: '>=', value: 90 },
  { status: 'Y', op: '>=', value: 80 },
  { status: 'R', op: '', value: 0 },
]

function measure(content: Methodology, key: string) {
  const m = content.measures.find((x) => x.key === key)
  if (!m) throw new Error(`no measure ${key}`)
  return m
}

function onlyMetric(content: Methodology) {
  expect(content.metrics).toHaveLength(1)
  return content.metrics[0]!
}

describe('applyPreset', () => {
  it('On-time delivery: committed and on-time commitments, higher is better, 90 / 80 bands', () => {
    const where = "state != 'cancelled'"
    const { content, created } = applyPreset(empty(), 'on_time', { recordType: 'epic', recordTypeName: 'Epic', where })
    expect(created).toEqual(['epic_committed', 'epic_on_time', 'epic_on_time_pct'])
    expect(content.measures.map((m) => m.key)).toEqual(['epic_committed', 'epic_on_time'])
    expect(measure(content, 'epic_committed')).toMatchObject({
      source: 'derived',
      unit: 'count',
      orgAgg: 'sum',
      timeAgg: 'sum',
      derive: { recordType: 'epic', op: 'commitments', outcome: 'resolved', where },
    })
    expect(measure(content, 'epic_on_time').derive).toEqual({ recordType: 'epic', op: 'commitments', outcome: 'met', where })
    const m = onlyMetric(content)
    expect(m).toMatchObject({
      key: 'epic_on_time_pct',
      formula: 'epic_on_time / epic_committed * 100',
      direction: 'higher_better',
      format: 'percent0',
      categoryId: 'delivery',
      rule: { type: 'bands', bands: GYR },
    })
  })

  it('Weighted open items: daily weighted points and days, lower is better, change vs prior period', () => {
    const where = "category in ['bug', 'defect']"
    const weights = defaultWeights(['P1', 'P2', 'P3', 'P4'])
    expect(weights).toEqual({ P1: 64, P2: 16, P3: 4, P4: 2, none: 1 })
    const { content, created } = applyPreset(empty(), 'weighted_open', { recordType: 'defect', where, weights })
    expect(created).toEqual(['defect_points_sum', 'defect_days', 'defect_weighted_score'])
    expect(measure(content, 'defect_points_sum').derive).toEqual({
      recordType: 'defect',
      op: 'daily_open_weighted',
      weights: { P1: 64, P2: 16, P3: 4, P4: 2, none: 1 },
      where,
    })
    expect(measure(content, 'defect_days')).toMatchObject({
      source: 'derived',
      orgAgg: 'max',
      derive: { recordType: 'defect', op: 'days_in_period' },
    })
    expect(measure(content, 'defect_days').derive?.where).toBeUndefined()
    const m = onlyMetric(content)
    expect(m.formula).toBe('defect_points_sum / defect_days')
    expect(m.direction).toBe('lower_better')
    expect(m.rule.type).toBe('change')
    expect(m.rule.compare).toBe('prior_period')
    expect(m.rule.bands?.at(-1)).toEqual({ status: 'R', op: '', value: 0 })
  })

  it('pre-fills weights from any priority list, with none lowest', () => {
    expect(defaultWeights([])).toEqual({ none: 1 })
    expect(defaultWeights(['High', 'Low'])).toEqual({ High: 4, Low: 2, none: 1 })
    expect(defaultWeights(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual({ A: 1024, B: 256, C: 64, D: 16, E: 4, F: 2, none: 1 })
    expect(defaultWeights(['P1', 'P2', 'none'])).toEqual({ P1: 4, P2: 2, none: 1 })
  })

  it('Delivered within budget: measured, within budget at the tolerance, planned and actual sums', () => {
    const where = "state == 'done'"
    const { content, created } = applyPreset(empty(), 'within_budget', {
      recordType: 'concept',
      where,
      tolerance: 20,
      bucketBy: 'completedAt',
      unit: 'spend_k',
    })
    expect(created).toEqual([
      'concept_measured',
      'concept_within_budget',
      'planned_spend_k',
      'actual_spend_k',
      'concept_within_budget_pct',
    ])
    expect(measure(content, 'concept_measured').derive).toEqual({ recordType: 'concept', op: 'count', bucketBy: 'completedAt', where })
    expect(measure(content, 'concept_within_budget').derive).toEqual({
      recordType: 'concept',
      op: 'count',
      bucketBy: 'completedAt',
      where: "state == 'done' && actual <= planned * 1.2",
    })
    expect(measure(content, 'planned_spend_k').derive).toEqual({
      recordType: 'concept',
      op: 'sum',
      field: 'planned',
      bucketBy: 'completedAt',
      where,
    })
    expect(measure(content, 'actual_spend_k').derive).toEqual({
      recordType: 'concept',
      op: 'sum',
      field: 'actual',
      bucketBy: 'completedAt',
      where,
    })
    const m = onlyMetric(content)
    expect(m.formula).toBe('concept_within_budget / concept_measured * 100')
    expect(m.direction).toBe('higher_better')
    expect(m.rule).toEqual({ type: 'bands', bands: GYR })
  })

  it('Delivered within budget: defaults to 20% and keeps an OR filter together', () => {
    const { content } = applyPreset(empty(), 'within_budget', {
      recordType: 'concept',
      bucketBy: 'completedAt',
      unit: 'spend_k',
      where: "state == 'done' || status == 'Measured'",
    })
    expect(measure(content, 'concept_within_budget').derive?.where).toBe(
      "(state == 'done' || status == 'Measured') && actual <= planned * 1.2",
    )
    const none = applyPreset(empty(), 'within_budget', { recordType: 'concept', bucketBy: 'completedAt', unit: 'spend_k', tolerance: 0 })
    expect(measure(none.content, 'concept_within_budget').derive?.where).toBe('actual <= planned')
    expect(measure(none.content, 'concept_measured').derive?.where).toBeUndefined()
  })

  it('Delivered expected value: measured and delivered, bucketed by the measured date', () => {
    const { content, created } = applyPreset(empty(), 'expected_value', { recordType: 'concept', where: "state == 'done'" })
    expect(created).toEqual(['concept_ev_measured', 'concept_ev_delivered', 'concept_ev_pct'])
    expect(measure(content, 'concept_ev_measured').derive).toEqual({
      recordType: 'concept',
      op: 'count',
      bucketBy: 'measuredAt',
      where: "state == 'done'",
    })
    expect(measure(content, 'concept_ev_delivered').derive).toEqual({
      recordType: 'concept',
      op: 'count',
      bucketBy: 'measuredAt',
      where: "state == 'done' && deliveredValue >= expectedValue",
    })
    const m = onlyMetric(content)
    expect(m.formula).toBe('concept_ev_delivered / concept_ev_measured * 100')
    expect(m.direction).toBe('higher_better')
  })

  it('Average age: age sum and count from the start date, lower is better', () => {
    const { content, created } = applyPreset(empty(), 'average_age', {
      recordType: 'idea',
      ageFrom: 'createdAt',
      ageTo: 'completedAt',
    })
    expect(created).toEqual(['idea_age_days_sum', 'idea_count', 'idea_average_age'])
    expect(measure(content, 'idea_age_days_sum')).toMatchObject({
      unit: 'days',
      derive: { recordType: 'idea', op: 'age_sum', bucketBy: 'createdAt', ageFrom: 'createdAt', ageTo: 'completedAt' },
    })
    expect(measure(content, 'idea_count').derive).toEqual({ recordType: 'idea', op: 'count', bucketBy: 'createdAt' })
    const m = onlyMetric(content)
    expect(m.formula).toBe('idea_age_days_sum / idea_count')
    expect(m.direction).toBe('lower_better')
    expect(m.format).toBe('days0')
    // An empty end date means the age runs to the period end.
    const open = applyPreset(empty(), 'average_age', { recordType: 'idea', ageFrom: 'createdAt', ageTo: '' })
    expect(measure(open.content, 'idea_age_days_sum').derive?.ageTo).toBeUndefined()
  })

  it('Count and Sum create one measure and no metric', () => {
    const count = applyPreset(empty(), 'count', { recordType: 'epic', bucketBy: 'completedAt', where: "state == 'done'" })
    expect(count.created).toEqual(['epic_count'])
    expect(count.content.metrics).toEqual([])
    expect(measure(count.content, 'epic_count').derive).toEqual({
      recordType: 'epic',
      op: 'count',
      bucketBy: 'completedAt',
      where: "state == 'done'",
    })

    const sum = applyPreset(empty(), 'sum', { recordType: 'concept', field: 'expectedValue', bucketBy: 'measuredAt' })
    expect(sum.created).toEqual(['concept_expected_value_sum'])
    expect(sum.content.metrics).toEqual([])
    expect(measure(sum.content, 'concept_expected_value_sum').derive).toEqual({
      recordType: 'concept',
      op: 'sum',
      field: 'expectedValue',
      bucketBy: 'measuredAt',
    })
  })

  it('reuses existing keys instead of duplicating them', () => {
    const before: Methodology = {
      ...empty(),
      measures: [{ key: 'epic_committed', name: 'Epics committed (typed)', unit: 'epics', orgAgg: 'sum', timeAgg: 'sum' }],
      metrics: [metric('epic_on_time_pct', 'On-time delivery', { formula: 'keep / me' })],
    }
    const { content, created } = applyPreset(before, 'on_time', { recordType: 'epic' })
    expect(created).toEqual(['epic_on_time'])
    expect(content.measures.map((m) => m.key)).toEqual(['epic_committed', 'epic_on_time'])
    expect(measure(content, 'epic_committed')).toMatchObject({
      name: 'Epics committed (typed)',
      unit: 'epics',
      source: 'derived',
      derive: { recordType: 'epic', op: 'commitments', outcome: 'resolved' },
    })
    expect(content.metrics).toHaveLength(1)
    expect(content.metrics[0]?.formula).toBe('keep / me')
    // The input is not changed.
    expect(before.measures[0]?.source).toBeUndefined()

    const again = applyPreset(content, 'on_time', { recordType: 'epic' })
    expect(again.created).toEqual([])
    expect(again.content.measures).toHaveLength(2)
  })

  it('takes over an entered measure and reuses an identical derived rule without a suffix', () => {
    const before: Methodology = {
      ...empty(),
      measures: [{ key: 'epic_committed', name: 'Epics committed (typed)', unit: 'epics', orgAgg: 'sum', timeAgg: 'sum' }],
    }
    const first = applyPreset(before, 'on_time', { recordType: 'epic', where: "state != 'cancelled'" })
    expect(first.converted).toEqual(['epic_committed'])
    expect(first.kept).toEqual([])
    expect(first.created).toEqual(['epic_on_time', 'epic_on_time_pct'])

    const again = applyPreset(first.content, 'on_time', { recordType: 'epic', where: "state != 'cancelled'" })
    expect(again.reused).toEqual(['epic_committed', 'epic_on_time'])
    expect(again.created).toEqual([])
    expect(again.kept).toEqual([])
    expect(again.content).toEqual(first.content)
    // Rules match whatever order the weights were written in.
    const w1 = applyPreset(empty(), 'weighted_open', { recordType: 'defect', weights: { P1: 64, none: 1 } })
    const w2 = applyPreset(w1.content, 'weighted_open', { recordType: 'defect', weights: { none: 1, P1: 64 } })
    expect(w2.reused).toEqual(['defect_points_sum', 'defect_days'])
  })

  it('never replaces a measure derived by another rule: Count, then Average age on the same type', () => {
    const count = applyPreset(empty(), 'count', { recordType: 'idea', bucketBy: 'completedAt', where: "state == 'done'" })
    const countMeasure = structuredClone(measure(count.content, 'idea_count'))

    const age = applyPreset(count.content, 'average_age', { recordType: 'idea', ageFrom: 'createdAt', ageTo: 'completedAt' })
    expect(measure(age.content, 'idea_count')).toEqual(countMeasure)
    expect(measure(age.content, 'idea_count_2')).toMatchObject({
      name: 'idea count (2)',
      source: 'derived',
      derive: { recordType: 'idea', op: 'count', bucketBy: 'createdAt' },
    })
    expect(age.created).toEqual(['idea_age_days_sum', 'idea_count_2', 'idea_average_age'])
    expect(age.kept).toEqual([{ existing: 'idea_count', added: 'idea_count_2' }])
    expect(age.content.metrics.find((m) => m.key === 'idea_average_age')?.formula).toBe('idea_age_days_sum / idea_count_2')

    // Applying it again finds its own measure under the suffix.
    const again = applyPreset(age.content, 'average_age', { recordType: 'idea', ageFrom: 'createdAt', ageTo: 'completedAt' })
    expect(again.reused).toEqual(['idea_age_days_sum', 'idea_count_2'])
    expect(again.content.measures).toHaveLength(age.content.measures.length)

    // A third, different rule takes the next free key.
    const third = applyPreset(age.content, 'count', { recordType: 'idea', bucketBy: 'dueAt' })
    expect(third.kept).toEqual([{ existing: 'idea_count', added: 'idea_count_3' }])
  })

  it("never points one record type's budget measures at another: Within budget on two types", () => {
    const concepts = applyPreset(empty(), 'within_budget', { recordType: 'concept', bucketBy: 'completedAt', unit: 'spend_k' })
    const planned = structuredClone(measure(concepts.content, 'planned_spend_k'))
    const actual = structuredClone(measure(concepts.content, 'actual_spend_k'))

    const bets = applyPreset(concepts.content, 'within_budget', { recordType: 'bet', bucketBy: 'completedAt', unit: 'spend_k' })
    expect(measure(bets.content, 'planned_spend_k')).toEqual(planned)
    expect(measure(bets.content, 'actual_spend_k')).toEqual(actual)
    expect(measure(bets.content, 'planned_spend_k_2').derive).toMatchObject({ recordType: 'bet', op: 'sum', field: 'planned' })
    expect(measure(bets.content, 'actual_spend_k_2').derive).toMatchObject({ recordType: 'bet', op: 'sum', field: 'actual' })
    expect(bets.kept).toEqual([
      { existing: 'planned_spend_k', added: 'planned_spend_k_2' },
      { existing: 'actual_spend_k', added: 'actual_spend_k_2' },
    ])
    expect(bets.created).toEqual(['bet_measured', 'bet_within_budget', 'planned_spend_k_2', 'actual_spend_k_2', 'bet_within_budget_pct'])
  })

  it('skips the metric when asked and uses the status scale given', () => {
    const noMetric = applyPreset(empty(), 'on_time', { recordType: 'epic', withMetric: false })
    expect(noMetric.content.metrics).toEqual([])
    expect(noMetric.created).toEqual(['epic_committed', 'epic_on_time'])

    const custom = applyPreset(empty(), 'on_time', {
      recordType: 'epic',
      statusKeys: ['good', 'watch', 'bad'],
      reportedAt: [{ kind: 'level', id: 'product' }],
    })
    const m = onlyMetric(custom.content)
    expect(m.rule.bands?.map((b) => b.status)).toEqual(['good', 'watch', 'bad'])
    expect(m.reportedAt).toEqual([{ kind: 'level', id: 'product' }])
  })

  it('every preset is described in plain language and lists its keys', () => {
    const ids: PresetId[] = ['on_time', 'weighted_open', 'within_budget', 'expected_value', 'average_age', 'count', 'sum']
    expect(PRESETS.map((p) => p.id)).toEqual(ids)
    for (const p of PRESETS) {
      expect(p.label).not.toBe('')
      expect(p.sentence).not.toMatch(/where|derive|subject|revision/i)
    }
    expect(presetKeys('on_time', { recordType: 'epic' })).toEqual({
      measures: ['epic_committed', 'epic_on_time'],
      metric: 'epic_on_time_pct',
    })
    expect(presetKeys('count', { recordType: 'epic' })).toEqual({ measures: ['epic_count'] })
  })

  it('builds keys from keyPrefix while the rules still read the record type', () => {
    expect(presetKeys('on_time', { recordType: 'epic', keyPrefix: 'epics' })).toEqual({
      measures: ['epics_committed', 'epics_on_time'],
      metric: 'epics_on_time_pct',
    })
    const { content } = applyPreset(empty(), 'on_time', { recordType: 'epic', keyPrefix: 'epics' })
    expect(measure(content, 'epics_committed').derive).toMatchObject({ recordType: 'epic', outcome: 'resolved' })
    expect(onlyMetric(content).formula).toBe('epics_on_time / epics_committed * 100')
  })
})
