import { describe, expect, it } from 'vitest'
import { defectsPreview, epicsPreview } from '../../test/recordsFixtures'
import {
  MAX_UPLOAD_BYTES,
  answersFor,
  buildAnswers,
  columnNotice,
  duplicateNotes,
  emptyAnswers,
  fieldLabel,
  longDate,
  mergeQuestions,
  missingText,
  noQuestions,
  partitionFiles,
  problemText,
  reasonLabel,
  reasonSummary,
  recognitionParts,
  todayISO,
  visibleProblems,
} from './recordsModel'

function file(name: string, size = 10) {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('partitionFiles', () => {
  it('accepts .csv and .xlsx up to 20 MB and explains the rest', () => {
    const { accepted, rejected } = partitionFiles([
      file('defects.CSV'),
      file('epics.xlsx'),
      file('notes.pdf'),
      file('huge.csv', MAX_UPLOAD_BYTES + 1),
    ])
    expect(accepted.map((f) => f.name)).toEqual(['defects.CSV', 'epics.xlsx'])
    expect(rejected).toEqual([
      '“notes.pdf” isn’t a .csv or .xlsx file.',
      '“huge.csv” is larger than 20 MB. Split it or export fewer columns.',
    ])
  })
})

describe('copy', () => {
  it('builds the recognition line, with the last upload date when known', () => {
    expect(recognitionParts({ name: 'Defects export', rows: 1204, changed: 37 })).toEqual({
      lead: 'Looks like your ',
      name: 'Defects export',
      rest: ': 1,204 rows, 37 changed since your last upload.',
    })
    expect(recognitionParts({ name: 'Defects export', rows: 1, changed: 0, lastUpload: '2026-10-31', today: '2026-11-08' }).rest).toBe(
      ': 1 row, 0 changed since your October 31 upload.',
    )
    expect(recognitionParts({ name: 'Defects export', rows: 9, changed: 2, lastUpload: '2025-12-30', today: '2026-01-05' }).rest).toBe(
      ': 9 rows, 2 changed since your December 30, 2025 upload.',
    )
  })

  it('formats dates and today as calendar dates', () => {
    expect(longDate('2026-10-31', '2026-11-08')).toBe('October 31')
    expect(longDate('2025-10-31', '2026-11-08')).toBe('October 31, 2025')
    expect(todayISO(new Date(2026, 10, 8, 23, 30))).toBe('2026-11-08')
  })

  it('labels reasons in plain words', () => {
    expect(reasonLabel('slipped')).toBe('slipped')
    expect(reasonLabel('met')).toBe('delivered on time')
    expect(reasonLabel('newly_open', 'P1')).toBe('newly open P1')
    expect(reasonLabel('newly_open', 'none')).toBe('newly open')
    expect(reasonLabel('removed')).toBe('no longer counted')
    expect(reasonLabel('priority_changed')).toBe('priority changed')
  })

  it('summarizes a story line by reason, with the record IDs', () => {
    const line = epicsPreview().story.lines[0]!
    expect(reasonSummary(line.reasons, 'Epic')).toBe('3 epics slipped: BIL-12, BIL-40, BIL-77')
    const many = { met: ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map((id) => ({ ...line.reasons.slipped![0]!, externalId: id })) }
    expect(reasonSummary(many, 'Epic')).toBe('5 epics delivered on time: A-1, A-2, A-3 and 2 more')
  })

  it('maps field keys to friendly labels', () => {
    expect(fieldLabel('subjectKey')).toBe('Product or team')
    expect(fieldLabel('externalId')).toBe('ID')
    expect(fieldLabel('dueAt')).toBe('Due date')
    expect(fieldLabel('customerTicket', [{ key: 'customerTicket', name: 'Customer ticket', type: 'bool' }])).toBe(
      'Customer ticket',
    )
    expect(fieldLabel('linkedTickets')).toBe('Linked tickets')
  })

  it('describes row problems from their fields, never the server message', () => {
    const [unreadable] = defectsPreview().problems
    expect(problemText(unreadable!)).toBe('Couldn’t read “31/02/2026” as Created')
    expect(problemText({ row: 3, kind: 'error', column: 'Product', field: 'subjectKey', value: '', message: 'subjectKey is required' })).toBe(
      'Product or team is empty',
    )
    expect(
      problemText({ row: 0, kind: 'error', column: 'Resolved', field: 'completedAt', value: '', message: 'column "Resolved" (for completedAt) is not in the file' }),
    ).toBe('The file has no “Resolved” column, which Completed comes from')
    expect(
      problemText({ row: 9, kind: 'duplicate_id', column: 'Issue key', field: 'externalId', value: 'CHK-9', message: '"CHK-9" is also on row 10' }),
    ).toBe('ID “CHK-9” is on more than one row')
    expect(visibleProblems(defectsPreview().problems).map((p) => p.row)).toEqual([12])
  })

  it('describes column changes and missing records calmly', () => {
    expect(columnNotice(['Sprint', 'Labels'], ['Linked tickets'])).toBe(
      'This file has 2 new columns and is missing “Linked tickets”. We used what we could.',
    )
    expect(columnNotice(['Sprint'], [])).toBe('This file has 1 new column. We used what we could.')
    expect(columnNotice([], ['A', 'B'])).toBe('This file is missing “A” and “B”. We used what we could.')
    expect(columnNotice([], [])).toBeNull()
    expect(missingText(3)).toBe('3 open records weren’t in this file')
    expect(missingText(1)).toBe('1 open record wasn’t in this file')
  })
})

describe('answers', () => {
  it('keeps every question once asked, preselecting confident product matches', () => {
    const first = mergeQuestions({ questions: noQuestions(), answers: emptyAnswers() }, defectsPreview(), 'sc-main')
    expect(first.questions.subjects.map((s) => s.value)).toEqual(['Checkout Svc', 'Pmt Gateway'])
    expect(first.questions.values).toEqual([{ field: 'priority', value: 'Urgent', count: 3, suggested: '' }])
    expect(first.answers.subjects).toEqual({ 'Checkout Svc': 'to:checkout' })

    // Answered questions leave the next preview but stay on screen.
    const answered = { ...first, answers: { ...first.answers, subjects: { 'Checkout Svc': 'ignore' } } }
    const again = mergeQuestions(answered, { ...defectsPreview(), unmatched: [] }, 'sc-main')
    expect(again.questions.subjects.map((s) => s.value)).toEqual(['Checkout Svc', 'Pmt Gateway'])
    expect(again.answers.subjects).toEqual({ 'Checkout Svc': 'ignore' })
  })

  it('keeps typed values the admin chose to replace, and only those, after the preview stops listing them', () => {
    const cell = { measureKey: 'epics_on_time', subjectId: 'billing', period: '2026-M10' }
    const first = mergeQuestions({ questions: noQuestions(), answers: emptyAnswers() }, epicsPreview(), 'sc-main')
    expect(first.questions.typed.map((t) => t.subjectId)).toEqual(['billing'])
    const unlisted = { ...epicsPreview(), story: { ...epicsPreview().story, typed: [] } }

    // Not chosen: it goes when the preview no longer lists it.
    expect(mergeQuestions(first, unlisted, 'sc-main').questions.typed).toEqual([])

    // Chosen: the preview stops listing it, but it stays, still chosen.
    const chosen = { ...first, answers: { ...first.answers, useRecords: [cell] } }
    const kept = mergeQuestions(chosen, unlisted, 'sc-main')
    expect(kept.questions.typed.map((t) => t.subjectId)).toEqual(['billing'])
    expect(kept.answers.useRecords).toEqual([cell])

    // Another scorecard starts typed values over; until its preview arrives the old choices do not apply.
    expect(answersFor(chosen, 'sc-ops').useRecords).toEqual([])
    expect(answersFor(chosen, 'sc-main').useRecords).toEqual([cell])
    const other = mergeQuestions(chosen, unlisted, 'sc-ops')
    expect(other.questions.typed).toEqual([])
    expect(other.answers.useRecords).toEqual([])
  })

  it('describes rows that share an ID', () => {
    const dup = (row: number, value: string) => ({ row, kind: 'duplicate_id', column: 'Key', field: 'externalId', value, message: '' })
    expect(duplicateNotes([dup(40, 'CHK-9'), dup(12, 'CHK-9'), dup(3, 'BIL-1'), dup(7, 'BIL-1'), dup(9, 'BIL-1')])).toEqual([
      'These rows share an ID: CHK-9 (rows 12 and 40). Fix them in the export and upload again.',
      'These rows share an ID: BIL-1 (rows 3, 7 and 9). Fix them in the export and upload again.',
    ])
    expect(duplicateNotes(defectsPreview().problems)).toEqual([])
  })

  it('builds the API answers, leaving out what is unanswered', () => {
    expect(buildAnswers(emptyAnswers())).toEqual({})
    expect(
      buildAnswers({
        subjects: { 'Pmt Gateway': 'to:billing', 'Checkout Svc': 'to:checkout', Old: 'ignore', Commerce: 'shared:commerce', Later: '' },
        values: { priority: { Urgent: 'P1', Someday: '' } },
        dateOrder: 'dmy',
        useRecords: [{ measureKey: 'epics_on_time', subjectId: 'billing', period: '2026-M10' }],
        markMissingCancelled: true,
      }),
    ).toEqual({
      sourceKeys: { 'Checkout Svc': 'checkout', Commerce: 'commerce', 'Pmt Gateway': 'billing' },
      ignoreValues: ['Old'],
      createShared: ['commerce'],
      valueMaps: { priority: { Urgent: 'P1' } },
      dateOrder: 'dmy',
      useRecords: [{ measureKey: 'epics_on_time', subjectId: 'billing', period: '2026-M10' }],
      markMissingCancelled: true,
    })
  })
})
