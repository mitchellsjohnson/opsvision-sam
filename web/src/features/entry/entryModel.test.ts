import { describe, expect, it } from 'vitest'
import { analyze, draftOf, formatNumber, toWrite, type EntryRow } from './entryModel'
import { parseEntryValue } from './pasteParser'

describe('formatNumber', () => {
  it.each([1e-7, 1e21, 1.5e-10, 123456789.125, -0.000001, 0, 42, 0.1 + 0.2, 1e20])(
    '%d is plain digits that parse back to the same number',
    (n) => {
      const text = formatNumber(n)
      expect(text).not.toMatch(/e/i)
      expect(parseEntryValue(text)).toEqual({ kind: 'value', value: n })
    },
  )
})

describe('toWrite', () => {
  const row = { measureKey: 'closed', subjectId: 'unit-a', period: '2026-M10', revision: 4 } as EntryRow

  it('uses the revision the edit was based on, not the row\'s current one', () => {
    const saved = { kind: 'value', value: 40 } as const
    const draft = { ...draftOf(saved, 3), value: '45' }
    const analysis = analyze(draft, saved)
    expect(toWrite(row, draft, analysis)).toEqual({
      measureKey: 'closed',
      subjectId: 'unit-a',
      period: '2026-M10',
      expectedRevision: 3,
      value: 45,
    })
  })

  it('sends nothing for an unchanged row', () => {
    const saved = { kind: 'value', value: 40 } as const
    const draft = draftOf(saved, 3)
    expect(toWrite(row, draft, analyze(draft, saved))).toBeUndefined()
  })
})
