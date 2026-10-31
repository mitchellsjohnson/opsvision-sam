import type { components } from '../../api/schema'
import { parseEntryValue } from './pasteParser'

type Schemas = components['schemas']
export type EntryRow = Schemas['EntryRow']
export type DataPoint = Schemas['DataPoint']
export type DataWrite = Schemas['DataWrite']

/** The most data points one save may carry (the API rejects more). */
export const MAX_WRITES = 500
/** The API's limit on a not-applicable reason. */
export const MAX_REASON_LENGTH = 200

export type Field = 'value' | 'reason'

/** What the server holds for a row: nothing, a number, or a not-applicable reason. */
export type Saved =
  | { kind: 'blank' }
  | { kind: 'value'; value: number }
  | { kind: 'na'; reason: string }

/** The text in a row's two inputs, plus whether the row is marked not applicable. */
export interface Draft {
  value: string
  reason: string
  /** Not applicable: set by `n/a` in the value input or by a reason, cleared by typing a number. */
  na: boolean
  /**
   * The revision this edit is based on: the row's revision when editing began (or the
   * conflicting revision after Keep mine). Sent as `expectedRevision`, so a newer
   * revision that arrives by refetch is caught by the server instead of overwritten.
   */
  baseRevision: number
}

/** A number as plain digits (never `1e-7` or `1e+21`), so it always parses back. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
}

export interface RowIssue {
  field: Field
  message: string
}

export interface Analysis {
  issue?: RowIssue
  /** What to send for the row when it is valid and differs from what is saved. */
  write?: { value: number } | { naReason: string }
  dirty: boolean
}

/** A server-side state a row's saved data was replaced with (a conflict or a save). */
export interface Base {
  /** Applies while the fetched row's revision is no newer than this one. */
  supersedes: number
  revision: number
  saved: Saved
}

export function rowKey(row: Pick<EntryRow, 'measureKey' | 'subjectId' | 'period'>): string {
  return `${row.measureKey}|${row.subjectId}|${row.period}`
}

export function savedOf(point: { value?: number | null; naReason?: string }): Saved {
  if (typeof point.value === 'number') return { kind: 'value', value: point.value }
  const reason = (point.naReason ?? '').trim()
  return reason === '' ? { kind: 'blank' } : { kind: 'na', reason }
}

/** The row as it stands now: fetched data, unless a newer known state replaced it. */
export function effectiveRow(row: EntryRow, base: Base | undefined): { row: EntryRow; saved: Saved } {
  if (base && row.revision <= base.supersedes) {
    return { row: { ...row, revision: base.revision }, saved: base.saved }
  }
  return { row, saved: savedOf(row) }
}

/** The inputs' text for a saved state, based on the row's revision. */
export function draftOf(saved: Saved, baseRevision: number): Draft {
  switch (saved.kind) {
    case 'value':
      return { value: formatNumber(saved.value), reason: '', na: false, baseRevision }
    case 'na':
      return { value: '', reason: saved.reason, na: true, baseRevision }
    default:
      return { value: '', reason: '', na: false, baseRevision }
  }
}

/** Decides what a row's inputs mean: an error, a change to send, or nothing. */
export function analyze(draft: Draft, saved: Saved): Analysis {
  const parsed = parseEntryValue(draft.value)
  const reason = draft.reason.trim()
  if (parsed.kind === 'error') return { issue: { field: 'value', message: parsed.message }, dirty: false }

  if (parsed.kind === 'value') {
    if (reason !== '') {
      return {
        issue: { field: 'reason', message: 'Clear the value or the reason; a row cannot have both' },
        dirty: false,
      }
    }
    const dirty = saved.kind !== 'value' || saved.value !== parsed.value
    return { write: { value: parsed.value }, dirty }
  }

  if (parsed.kind === 'na' || draft.na || reason !== '') {
    if (reason === '') {
      return { issue: { field: 'reason', message: 'Add a reason this is not applicable' }, dirty: false }
    }
    if (reason.length > MAX_REASON_LENGTH) {
      return {
        issue: { field: 'reason', message: `The reason is too long (${reason.length} of ${MAX_REASON_LENGTH} characters)` },
        dirty: false,
      }
    }
    const dirty = saved.kind !== 'na' || saved.reason !== reason
    return { write: { naReason: reason }, dirty }
  }

  // Blank. Saved data cannot be cleared: a write needs a value or a reason.
  if (saved.kind !== 'blank') {
    return {
      issue: {
        field: 'value',
        message: 'Enter a value or mark it not applicable; saved data cannot be cleared (Escape restores it)',
      },
      dirty: false,
    }
  }
  return { dirty: false }
}

/** Settles an input on commit: `84%` becomes `84`, `n/a` becomes a not-applicable row. */
export function commitDraft(draft: Draft): Draft {
  const parsed = parseEntryValue(draft.value)
  switch (parsed.kind) {
    case 'value':
      return { ...draft, value: formatNumber(parsed.value), na: false }
    case 'na':
      return { ...draft, value: '', na: true }
    case 'empty':
      return { ...draft, value: '' }
    default:
      return draft
  }
}

/** The write to send for a dirty row, based on the revision the edit started from. */
export function toWrite(row: EntryRow, draft: Draft, analysis: Analysis): DataWrite | undefined {
  if (!analysis.dirty || !analysis.write) return undefined
  return {
    measureKey: row.measureKey,
    subjectId: row.subjectId,
    period: row.period,
    expectedRevision: draft.baseRevision,
    ...analysis.write,
  }
}

/** `42` or `not applicable (reason)` for a conflicting stored data point. */
export function describeSaved(point: DataPoint | undefined, plain: (n: number) => string): string {
  if (!point) return 'removed'
  if (typeof point.value === 'number') return plain(point.value)
  return point.naReason ? `not applicable (${point.naReason})` : 'blank'
}

/** A copy of a record without one key. */
export function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record }
  delete copy[key]
  return copy
}
