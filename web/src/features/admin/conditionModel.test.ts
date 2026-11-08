import { describe, expect, it } from 'vitest'
import { recordTypes } from '../../test/recordsFixtures'
import { conditionFields, fromWhere, opsFor, rowsFor, toWhere, type ConditionRow } from './conditionModel'

const defect = recordTypes[0]!

// One row per operator, with the expression each must produce.
const CASES: [ConditionRow, string][] = [
  [{ field: 'category', op: 'is', value: 'bug' }, "category == 'bug'"],
  [{ field: 'category', op: 'is_not', value: 'feature' }, "category != 'feature'"],
  [{ field: 'category', op: 'one_of', value: ['bug', 'defect'] }, "category in ['bug', 'defect']"],
  [{ field: 'completedAt', op: 'before', value: 'dueAt' }, 'completedAt < dueAt'],
  [{ field: 'completedAt', op: 'after', value: 'dueAt' }, 'completedAt > dueAt'],
  [{ field: 'completedAt', op: 'on_or_before', value: 'dueAt' }, 'completedAt <= dueAt'],
  [{ field: 'completedAt', op: 'on_or_after', value: 'createdAt' }, 'completedAt >= createdAt'],
  [{ field: 'planned', op: 'greater', value: '100' }, 'planned > 100'],
  [{ field: 'actual', op: 'less', value: '-2.5' }, 'actual < -2.5'],
  [{ field: 'status', op: 'is_empty' }, "status == ''"],
  [{ field: 'status', op: 'not_empty' }, "status != ''"],
  [{ field: 'dueAt', op: 'not_empty' }, 'dueAt == dueAt'],
  [{ field: 'customerTicket', op: 'is', value: true }, 'customerTicket'],
  [{ field: 'customerTicket', op: 'is', value: false }, '!customerTicket'],
  [{ field: 'priority', op: 'one_of', value: ['P1', 'none'] }, "priority in ['P1', 'none']"],
]

describe('toWhere', () => {
  it.each(CASES)('%o compiles to %s', (row, where) => {
    expect(toWhere([row])).toBe(where)
  })

  it('joins rows with AND', () => {
    expect(
      toWhere([
        { field: 'category', op: 'one_of', value: ['bug', 'defect'] },
        { field: 'customerTicket', op: 'is', value: true },
      ]),
    ).toBe("category in ['bug', 'defect'] && customerTicket")
    expect(toWhere([])).toBe('')
  })

  it('quotes text safely', () => {
    expect(toWhere([{ field: 'title', op: 'is', value: "it's a \\ path" }])).toBe("title == 'it\\'s a \\\\ path'")
  })

  it('leaves out rows that are not finished, so the expression always compiles', () => {
    expect(
      toWhere([
        { field: 'category', op: 'one_of', value: [] },
        { field: 'category', op: 'is', value: '' },
        { field: 'planned', op: 'greater', value: 'lots' },
        { field: 'completedAt', op: 'before', value: '' },
        { field: 'completedAt', op: 'before', value: "dueAt'" },
        { field: 'bad field', op: 'is_empty' },
        { field: 'state', op: 'is', value: 'done' },
      ]),
    ).toBe("state == 'done'")
  })

  it('treats a date attribute as a date when told', () => {
    expect(toWhere([{ field: 'reviewedAt', op: 'not_empty' }], ['reviewedAt'])).toBe('reviewedAt == reviewedAt')
  })
})

describe('fromWhere', () => {
  it.each(CASES)('round trips %o', (row) => {
    expect(fromWhere(toWhere([row]))).toEqual([row])
  })

  it('round trips every operator together', () => {
    const rows = CASES.map(([row]) => row)
    expect(fromWhere(toWhere(rows))).toEqual(rows)
    expect(toWhere(fromWhere(toWhere(rows)) ?? [])).toBe(toWhere(rows))
  })

  it('round trips quoted text', () => {
    const rows: ConditionRow[] = [{ field: 'title', op: 'is', value: "it's a \\ path" }]
    expect(fromWhere(toWhere(rows))).toEqual(rows)
  })

  it('reads the empty condition as no rows', () => {
    expect(fromWhere('')).toEqual([])
    expect(fromWhere('   ')).toEqual([])
  })

  it('reads hand-written forms the builder can show', () => {
    expect(fromWhere('(category == "bug") and customerTicket == true')).toEqual([
      { field: 'category', op: 'is', value: 'bug' },
      { field: 'customerTicket', op: 'is', value: true },
    ])
    expect(fromWhere("state == 'done' && (customerTicket && priority != 'P4')")).toEqual([
      { field: 'state', op: 'is', value: 'done' },
      { field: 'customerTicket', op: 'is', value: true },
      { field: 'priority', op: 'is_not', value: 'P4' },
    ])
  })

  it('returns null for anything the builder cannot show', () => {
    expect(fromWhere('a || b')).toBeNull()
    expect(fromWhere("category == 'bug' or state == 'done'")).toBeNull()
    expect(fromWhere("!(category == 'bug' && customerTicket)")).toBeNull()
    expect(fromWhere('actual <= planned * 1.2')).toBeNull()
    expect(fromWhere("category not in ['bug']")).toBeNull()
    expect(fromWhere('planned >= 3')).toBeNull()
    expect(fromWhere('dueAt == createdAt')).toBeNull()
    expect(fromWhere('severity == 2')).toBeNull()
    expect(fromWhere('dueAt in priorDueDates')).toBeNull()
    expect(fromWhere("category == 'bug' &&")).toBeNull()
    expect(fromWhere("category == 'unterminated")).toBeNull()
  })
})

describe('conditionFields', () => {
  it('lists plain-language fields for a record type, attributes included', () => {
    const fields = conditionFields(defect)
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('customerTicket')).toMatchObject({ label: 'Customer ticket', kind: 'bool' })
    expect(byKey.get('dueAt')).toMatchObject({ label: 'Due date', kind: 'date' })
    expect(byKey.get('subjectKey')).toMatchObject({ label: 'Product or team', kind: 'text' })
    expect(byKey.get('priority')?.options?.map((o) => o.value)).toEqual(['P1', 'P2', 'P3', 'P4', 'none'])
    expect(byKey.get('state')?.options?.map((o) => o.value)).toEqual(['open', 'done', 'cancelled'])
    expect(fields.some((f) => f.key === 'url' || f.key === 'priorDueDates')).toBe(false)
    expect(opsFor('number').map((o) => o.value)).toEqual(['greater', 'less'])
    expect(opsFor('date').map((o) => o.value)).toContain('on_or_before')
  })

  it('shows a condition in the builder only when every row fits the record type', () => {
    const fields = conditionFields(defect)
    expect(rowsFor("category == 'bug' && customerTicket", fields)).toEqual([
      { field: 'category', op: 'is', value: 'bug' },
      { field: 'customerTicket', op: 'is', value: true },
    ])
    expect(rowsFor("nope == 'x'", fields)).toBeNull()
    expect(rowsFor("planned == 'x'", fields)).toBeNull()
    expect(rowsFor('a || b', fields)).toBeNull()
  })
})
