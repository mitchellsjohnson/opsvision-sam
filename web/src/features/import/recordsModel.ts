import { ApiError } from '../../api/errors'
import type { components } from '../../api/schema'
import { XLSX_TYPE, plural } from '../admin/importModel'

type Schemas = components['schemas']
export type RecordAnswers = Schemas['RecordAnswers']
export type RecordCellRef = Schemas['RecordCellRef']
export type RecordContribution = Schemas['RecordContribution']
export type RecordRowProblem = Schemas['RecordRowProblem']
export type RecordsPreview = Schemas['RecordsPreview']
export type AttributeDef = Schemas['AttributeDef']

export const CSV_TYPE = 'text/csv'
/** The per-file upload limit (20 MiB), as for the workbook import. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

// ---- Files ------------------------------------------------------------------

export function fileKind(name: string): 'csv' | 'xlsx' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

export function contentTypeFor(file: File): string {
  return fileKind(file.name) === 'csv' ? CSV_TYPE : XLSX_TYPE
}

/** Splits files into those the import takes and a message for each it does not. */
export function partitionFiles(files: readonly File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = []
  const rejected: string[] = []
  for (const f of files) {
    if (fileKind(f.name) === null) rejected.push(`“${f.name}” isn’t a .csv or .xlsx file.`)
    else if (f.size > MAX_UPLOAD_BYTES) rejected.push(`“${f.name}” is larger than 20 MB. Split it or export fewer columns.`)
    else accepted.push(f)
  }
  return { accepted, rejected }
}

// ---- Dates and numbers ------------------------------------------------------

/** Today's local calendar date, `YYYY-MM-DD`. */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** How far back a file's last-modified date can be and still be its as-of date. */
const AS_OF_WINDOW_DAYS = 60

/**
 * The as-of date a dropped file starts with: its last-modified date, as a
 * calendar date, when that is within the last 60 days and not in the future;
 * otherwise today. A re-exported file a few days old keeps its own date.
 */
export function defaultAsOf(file: File | undefined, now: Date = new Date()): string {
  const today = todayISO(now)
  if (!file || !file.lastModified) return today
  const modified = todayISO(new Date(file.lastModified))
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - AS_OF_WINDOW_DAYS)
  return modified <= today && modified >= todayISO(earliest) ? modified : today
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** `October 31` for `2026-10-31`, with the year only when it is not this year's: `December 30, 2025`. */
export function longDate(iso: string, today: string = todayISO()): string {
  const [y, m, d] = iso.split('-').map(Number)
  const day = `${MONTHS[(m ?? 1) - 1]} ${d}`
  return iso.slice(0, 4) === today.slice(0, 4) ? day : `${day}, ${y}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

// ---- Copy -------------------------------------------------------------------

/** "Looks like your *Defects export*: 1,204 rows, 37 changed since your October 31 upload." */
export function recognitionParts({
  name,
  rows,
  changed,
  lastUpload,
  today,
}: {
  name: string
  rows: number
  changed: number
  /** The as-of date of the last upload of this export, when there was one. */
  lastUpload?: string
  today?: string
}): { lead: string; name: string; rest: string } {
  const since = lastUpload ? `your ${longDate(lastUpload, today)} upload` : 'your last upload'
  return {
    lead: 'Looks like your ',
    name,
    rest: `: ${formatCount(rows)} ${rows === 1 ? 'row' : 'rows'}, ${formatCount(changed)} changed since ${since}.`,
  }
}

const REASON_LABEL: Record<string, string> = {
  slipped: 'slipped',
  met: 'delivered on time',
  missed: 'missed',
  newly_open: 'newly open',
  closed: 'closed',
  priority_changed: 'priority changed',
  added: 'added',
  removed: 'no longer counted',
  matched: 'counted',
  pending: 'still due',
}

/** Why a record moved a number, in plain words: "slipped", "newly open P1". */
export function reasonLabel(reason: string, priority?: string): string {
  const label = REASON_LABEL[reason] ?? reason.replaceAll('_', ' ')
  return reason === 'newly_open' && priority && priority !== 'none' ? `${label} ${priority}` : label
}

/** "defect" from "Defects" or "Defect"; "story" from "Stories". */
function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (/[^s]s$/.test(word)) return word.slice(0, -1)
  return word
}

/** "defects" from "Defect" or "Defects"; "stories" from "Story". */
function pluralOf(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  return word.endsWith('s') ? word : `${word}s`
}

/** "3 epics" or "1 epic" from the record type name "Epic" or "Epics". */
export function recordNoun(typeName: string, n: number): string {
  const one = singular(typeName.trim().toLowerCase() || 'record')
  return n === 1 ? `1 ${one}` : `${formatCount(n)} ${pluralOf(one)}`
}

const IDS_SHOWN = 3

/** Contributions newly open, by priority in first-seen order; others as one group. */
function reasonGroups(reason: string, list: readonly RecordContribution[]): [string, RecordContribution[]][] {
  if (reason !== 'newly_open') return [[reasonLabel(reason), [...list]]]
  const groups = new Map<string, RecordContribution[]>()
  for (const c of list) {
    const label = reasonLabel(reason, c.priority)
    groups.set(label, [...(groups.get(label) ?? []), c])
  }
  return [...groups]
}

/** "3 epics slipped: BIL-12, BIL-40, BIL-77; 1 defect newly open P1: CHK-5". */
export function reasonSummary(reasons: Record<string, readonly RecordContribution[]>, typeName: string): string {
  return Object.entries(reasons)
    .filter(([, list]) => list.length > 0)
    .flatMap(([reason, list]) => reasonGroups(reason, list))
    .map(([label, list]) => {
      const ids = list.slice(0, IDS_SHOWN).map((c) => c.externalId).join(', ')
      const more = list.length > IDS_SHOWN ? ` and ${list.length - IDS_SHOWN} more` : ''
      return `${recordNoun(typeName, list.length)} ${label}: ${ids}${more}`
    })
    .join('; ')
}

/** "Same records as your October 31 upload. Only the date moves: this data now runs through November 4." */
export function sameRecordsText(previousAsOf: string, asOf: string, today: string = todayISO()): string {
  return `Same records as your ${longDate(previousAsOf, today)} upload. Only the date moves: this data now runs through ${longDate(asOf, today)}.`
}

const FIELD_LABEL: Record<string, string> = {
  externalId: 'ID',
  title: 'Title',
  subjectKey: 'Product or team',
  category: 'Type',
  priority: 'Priority',
  status: 'Status',
  state: 'Open or closed',
  createdAt: 'Created',
  committedAt: 'Committed',
  dueAt: 'Due date',
  priorDueDates: 'Earlier due dates',
  completedAt: 'Completed',
  measuredAt: 'Measured',
  url: 'Link',
}

/** A record field or attribute key as people say it. */
export function fieldLabel(field: string, attributes: readonly AttributeDef[] = []): string {
  const known = FIELD_LABEL[field] ?? attributes.find((a) => a.key === field)?.name
  if (known) return known
  const words = field.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Problems shown in the table; values no map covers are asked instead. */
export function visibleProblems(problems: readonly RecordRowProblem[]): RecordRowProblem[] {
  return problems.filter((p) => p.kind !== 'unmapped_value')
}

/** What a missing column leaves unknown, by field. */
const MISSING_COLUMN: Record<string, string> = {
  externalId: 'which item each row is',
  title: 'what each item is called',
  subjectKey: 'which product or team each item belongs to',
  category: 'what type each item is',
  priority: 'each item’s priority',
  status: 'each item’s status',
  state: 'whether items are open or closed',
  createdAt: 'when items were created',
  committedAt: 'when items were committed',
  dueAt: 'when items are due',
  priorDueDates: 'when items were due before',
  completedAt: 'when items were completed',
  measuredAt: 'when items were measured',
  url: 'where each item links to',
}

/** One row problem in plain words, built from its fields (the server message uses internal names). */
export function problemText(p: RecordRowProblem, attributes: readonly AttributeDef[] = []): string {
  const label = fieldLabel(p.field, attributes)
  if (p.kind === 'duplicate_id') return `ID “${p.value}” is on more than one row`
  if (p.row === 0) {
    const unknown = MISSING_COLUMN[p.field] ?? `each item’s ${label.toLowerCase()}`
    return `The file has no “${p.column}” column, so we can’t tell ${unknown}`
  }
  if (p.value === '') return `${label} is empty`
  return `Couldn’t read “${p.value}” as ${label}`
}

function quotedList(names: readonly string[]): string {
  const q = names.map((n) => `“${n}”`)
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`
}

/** "This file has 2 new columns and is missing “Linked tickets”. We used what we could." */
export function columnNotice(added: readonly string[], missing: readonly string[]): string | null {
  const parts: string[] = []
  if (added.length > 0) parts.push(`has ${plural(added.length, 'new column', 'new columns')}`)
  if (missing.length > 0) parts.push(`is missing ${quotedList(missing)}`)
  return parts.length === 0 ? null : `This file ${parts.join(' and ')}. We used what we could.`
}

/** Only open records are listed missing. */
export function missingText(n: number): string {
  return n === 1 ? '1 open record wasn’t in this file' : `${formatCount(n)} open records weren’t in this file`
}

const FAILURE: Record<'upload' | 'read' | 'preview' | 'apply', string> = {
  upload: 'We couldn’t upload this file. Check your connection and try again.',
  read: 'We couldn’t read this file. Check that it is the export you meant, then try again.',
  preview: 'We couldn’t work out what this file changes. Try again in a moment.',
  apply: 'This file couldn’t be applied. Try again in a moment.',
}

/**
 * A failure in plain words. Server, browser and HTTP messages can name
 * internals, so none is shown as it is: `upload` covers getting the upload
 * address and sending the file, `read` looking at it afterwards.
 */
export function failureText(err: unknown, step: 'upload' | 'read' | 'preview' | 'apply'): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only admins can import records.'
    if (err.status === 413) return 'This file is too big to read: keep it under 200,000 rows and 500 columns.'
  }
  return FAILURE[step]
}

/** What a records apply 409 means for the file: applied already, a stale preview, or a race to retry. */
export function applyConflict(err: unknown): 'already_applied' | 'preview_out_of_date' | 'conflict' | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  if (err.code === 'already_applied' || err.code === 'preview_out_of_date') return err.code
  return 'conflict'
}

/** The message for an apply that conflicted, by kind. */
export const APPLY_CONFLICT_TEXT: Record<'already_applied' | 'preview_out_of_date' | 'conflict', string> = {
  already_applied: 'Already applied',
  preview_out_of_date: 'This preview was out of date, so we refreshed it. Check it, then apply again.',
  conflict: 'Something changed while this file was being applied. Try applying again.',
}

/** Is the "date order" question worth asking, and how: the first day-and-month-both-fit value of an ambiguous column. */
export function dateQuestion(
  ambiguous: readonly string[],
  headers: readonly string[],
  samples: readonly (readonly string[])[],
): { column: string; example: string; monthFirst: string; dayFirst: string } | null {
  const column = ambiguous[0]
  if (column === undefined) return null
  const at = headers.indexOf(column)
  const pattern = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/
  let a = 3
  let b = 4
  let example = '03/04/2026'
  for (const row of samples) {
    const m = pattern.exec((at >= 0 ? row[at] : '')?.trim() ?? '')
    if (m && Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2]) {
      a = Number(m[1])
      b = Number(m[2])
      example = m[0]
      break
    }
  }
  return { column, example, monthFirst: `${MONTHS[a - 1]} ${b}`, dayFirst: `${MONTHS[b - 1]} ${a}` }
}

// ---- Questions and answers --------------------------------------------------

/** A product or team value the preview could not place, or one that names a group. */
export interface SubjectQuestion {
  value: string
  rows: number
  /** The best match, preselected; empty for none. */
  suggestedId: string
  candidates: string[]
  /** Set when the value matches a parent unit. */
  parentUnitId?: string
}

/** A raw value no map covers, for one field or attribute. */
export interface ValueQuestion {
  field: string
  value: string
  count: number
  suggested: string
}

export type TypedVsRecords = RecordsPreview['story']['typed'][number]

export interface Questions {
  subjects: SubjectQuestion[]
  values: ValueQuestion[]
  /**
   * Typed values that differ from records: the latest preview's, plus any the
   * admin chose to replace (the preview stops listing a cell once it is in
   * `useRecords`, but the choice must stay visible to be undone).
   */
  typed: TypedVsRecords[]
  /** The scorecard `typed` and the `useRecords` answers belong to; empty before the first preview. */
  typedFor: string
}

/**
 * The admin's choices. A subject choice is `to:<id>` (the unit or item the
 * value means), `shared:<unitId>` (a new "<name> (shared)" child), `ignore`,
 * or empty for not answered yet.
 */
export interface AnswerState {
  subjects: Record<string, string>
  values: Record<string, Record<string, string>>
  dateOrder: '' | 'mdy' | 'dmy'
  useRecords: RecordCellRef[]
  markMissingCancelled: boolean
}

export function noQuestions(): Questions {
  return { subjects: [], values: [], typed: [], typedFor: '' }
}

export function emptyAnswers(): AnswerState {
  return { subjects: {}, values: {}, dateOrder: '', useRecords: [], markMissingCancelled: false }
}

/**
 * Adds the preview's questions to those already asked. Answered questions
 * drop out of the next preview, so they are kept here to stay on screen and
 * editable. A confident product match is preselected when first asked.
 * Typed values follow the latest preview, keeping the ones chosen in
 * `useRecords`; a preview for another scorecard starts them over.
 */
export function mergeQuestions(
  prev: { questions: Questions; answers: AnswerState },
  preview: RecordsPreview,
  scorecardId: string,
): { questions: Questions; answers: AnswerState } {
  const subjects = [...prev.questions.subjects]
  const values = [...prev.questions.values]
  const chosen = { ...prev.answers.subjects }
  const seen = new Set(subjects.map((s) => s.value))
  for (const u of preview.unmatched) {
    if (seen.has(u.value)) continue
    seen.add(u.value)
    subjects.push({ value: u.value, rows: u.rows, suggestedId: u.subjectId, candidates: u.candidates })
    if (u.subjectId !== '' && chosen[u.value] === undefined) chosen[u.value] = `to:${u.subjectId}`
  }
  for (const p of preview.parents) {
    if (seen.has(p.value)) continue
    seen.add(p.value)
    subjects.push({ value: p.value, rows: p.rows, suggestedId: '', candidates: [], parentUnitId: p.unitId })
  }
  const seenValues = new Set(values.map((v) => `${v.field}\u0000${v.value}`))
  for (const field of Object.keys(preview.newValues).sort()) {
    for (const vc of preview.newValues[field] ?? []) {
      const key = `${field}\u0000${vc.value}`
      if (seenValues.has(key)) continue
      seenValues.add(key)
      values.push({ field, value: vc.value, count: vc.count, suggested: vc.suggested })
    }
  }
  const sameScorecard = prev.questions.typedFor === scorecardId
  const useRecords = sameScorecard ? prev.answers.useRecords : []
  const listed = preview.story.typed
  const kept = (sameScorecard ? prev.questions.typed : []).filter(
    (t) => useRecords.some((c) => sameCell(c, t)) && !listed.some((l) => sameCell(l, t)),
  )
  return {
    questions: { subjects, values, typed: [...listed, ...kept], typedFor: scorecardId },
    answers: { ...prev.answers, subjects: chosen, useRecords },
  }
}

/** The answers that apply to `scorecardId`: typed-value choices made for another scorecard do not. */
export function answersFor(q: { questions: Questions; answers: AnswerState }, scorecardId: string): AnswerState {
  const stale = q.questions.typedFor !== '' && q.questions.typedFor !== scorecardId
  return stale ? { ...q.answers, useRecords: [] } : q.answers
}

/** "These rows share an ID: CHK-9 (rows 12 and 40). Fix them in the export and upload again." */
export function duplicateNotes(problems: readonly RecordRowProblem[]): string[] {
  const rows = new Map<string, number[]>()
  for (const p of problems) {
    if (p.kind !== 'duplicate_id') continue
    const list = rows.get(p.value) ?? []
    if (!list.includes(p.row)) list.push(p.row)
    rows.set(p.value, list)
  }
  return [...rows].map(([id, list]) => {
    const nums = list.sort((a, b) => a - b).map(String)
    const where = nums.length === 1 ? `row ${nums[0]}` : `rows ${nums.slice(0, -1).join(', ')} and ${nums.at(-1)}`
    return `These rows share an ID: ${id} (${where}). Fix them in the export and upload again.`
  })
}

function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort()
}

/** The API answers for the choices, leaving out what is unanswered, in a stable order. */
export function buildAnswers(s: AnswerState): RecordAnswers {
  const sourceKeys: Record<string, string> = {}
  const ignoreValues: string[] = []
  const createShared: string[] = []
  for (const value of sortedKeys(s.subjects)) {
    const choice = s.subjects[value] ?? ''
    if (choice === 'ignore') ignoreValues.push(value)
    else if (choice.startsWith('to:')) sourceKeys[value] = choice.slice(3)
    else if (choice.startsWith('shared:')) {
      const unit = choice.slice(7)
      sourceKeys[value] = unit
      if (!createShared.includes(unit)) createShared.push(unit)
    }
  }
  const valueMaps: Record<string, Record<string, string>> = {}
  for (const field of sortedKeys(s.values)) {
    const m: Record<string, string> = {}
    const raw = s.values[field] ?? {}
    for (const v of sortedKeys(raw)) if (raw[v]) m[v] = raw[v]
    if (Object.keys(m).length > 0) valueMaps[field] = m
  }
  const out: RecordAnswers = {}
  if (Object.keys(sourceKeys).length > 0) out.sourceKeys = sourceKeys
  if (ignoreValues.length > 0) out.ignoreValues = ignoreValues
  if (createShared.length > 0) out.createShared = createShared.sort()
  if (Object.keys(valueMaps).length > 0) out.valueMaps = valueMaps
  if (s.dateOrder) out.dateOrder = s.dateOrder
  if (s.useRecords.length > 0) out.useRecords = s.useRecords
  if (s.markMissingCancelled) out.markMissingCancelled = true
  return out
}

/** Whether answers change how the template reads the file, so applying should save them to it. */
export function answersUpdateTemplate(a: RecordAnswers): boolean {
  return a.valueMaps !== undefined || a.dateOrder !== undefined
}

export function sameCell(a: RecordCellRef, b: RecordCellRef): boolean {
  return a.measureKey === b.measureKey && a.subjectId === b.subjectId && a.period === b.period
}
