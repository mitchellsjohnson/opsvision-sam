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
}

/** Why a record moved a number, in plain words: "slipped", "newly open P1". */
export function reasonLabel(reason: string, priority?: string): string {
  const label = REASON_LABEL[reason] ?? reason.replaceAll('_', ' ')
  return reason === 'newly_open' && priority && priority !== 'none' ? `${label} ${priority}` : label
}

/** "3 epics" from the record type name "Epic". */
export function recordNoun(typeName: string, n: number): string {
  const one = typeName.trim().toLowerCase() || 'record'
  if (n === 1) return `1 ${one}`
  return `${n} ${one.endsWith('s') ? one : `${one}s`}`
}

const IDS_SHOWN = 3

/** "3 epics slipped: BIL-12, BIL-40, BIL-77; 1 epic delivered on time: BIL-5". */
export function reasonSummary(reasons: Record<string, readonly RecordContribution[]>, typeName: string): string {
  return Object.entries(reasons)
    .filter(([, list]) => list.length > 0)
    .map(([reason, list]) => {
      const ids = list.slice(0, IDS_SHOWN).map((c) => c.externalId).join(', ')
      const more = list.length > IDS_SHOWN ? ` and ${list.length - IDS_SHOWN} more` : ''
      return `${recordNoun(typeName, list.length)} ${reasonLabel(reason)}: ${ids}${more}`
    })
    .join('; ')
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

/** One row problem in plain words, built from its fields (the server message uses internal names). */
export function problemText(p: RecordRowProblem, attributes: readonly AttributeDef[] = []): string {
  const label = fieldLabel(p.field, attributes)
  if (p.kind === 'duplicate_id') return `ID “${p.value}” is on more than one row`
  if (p.row === 0) return `The file has no “${p.column}” column, which ${label} comes from`
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

const FAILURE: Record<'read' | 'preview' | 'apply', string> = {
  read: 'We couldn’t read this file. Check that it is the export you meant, then try again.',
  preview: 'We couldn’t work out what this file changes. Try again in a moment.',
  apply: 'This file couldn’t be applied. Try again in a moment.',
}

/**
 * A failure in plain words. Server messages can name internals, so only our
 * own upload messages (plain errors) are shown as they are.
 */
export function failureText(err: unknown, step: 'read' | 'preview' | 'apply'): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only admins can import records.'
    if (err.status === 413) return 'This file is too big to read: keep it under 200,000 rows and 500 columns.'
    return FAILURE[step]
  }
  return err instanceof Error && err.message ? err.message : FAILURE[step]
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

export interface Questions {
  subjects: SubjectQuestion[]
  values: ValueQuestion[]
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
  return { subjects: [], values: [] }
}

export function emptyAnswers(): AnswerState {
  return { subjects: {}, values: {}, dateOrder: '', useRecords: [], markMissingCancelled: false }
}

/**
 * Adds the preview's questions to those already asked. Answered questions
 * drop out of the next preview, so they are kept here to stay on screen and
 * editable. A confident product match is preselected when first asked.
 */
export function mergeQuestions(
  prev: { questions: Questions; answers: AnswerState },
  preview: RecordsPreview,
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
  return { questions: { subjects, values }, answers: { ...prev.answers, subjects: chosen } }
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
