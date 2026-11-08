import type {
  ImportTemplate,
  Methodology,
  Metric,
  OrgUnit,
  RecordTemplate,
  RecordType,
  RecordsInspectResult,
  RecordsPreview,
  TrackedItem,
} from '../../../api/queries'
import type { components } from '../../../api/schema'
import { formatPeriod, monthOf } from '../../../lib/period'
import { slugify } from '../../admin/adminModel'
import { applyPreset, defaultWeights, presetKeys, type PresetId, type PresetParams } from '../../admin/presets'
import { recordTypeId } from '../../admin/RecordTypesPage'
import { buildAnswers, emptyAnswers, type AnswerState, type RecordAnswers, type SubjectQuestion } from '../recordsModel'

type RecordFieldMap = components['schemas']['RecordFieldMap']
export type Inspection = RecordsInspectResult['inspection']
type Guess = Inspection['guesses'][number]

// ---- Steps ------------------------------------------------------------------

export type StepId = 'type' | 'columns' | 'values' | 'products' | 'calculate' | 'preview'

/** The first-upload setup, in order (spec §7.1). */
export const SETUP_STEPS: readonly StepId[] = ['type', 'columns', 'values', 'products', 'calculate', 'preview']
/** "Edit mapping" on a saved template reopens only these. */
export const TEMPLATE_STEPS: readonly StepId[] = ['columns', 'values']

/** Short names for the step indicator: "Step 2 of 6: Columns". */
export const STEP_LABELS: Record<StepId, string> = {
  type: 'File type',
  columns: 'Columns',
  values: 'Values',
  products: 'Products and teams',
  calculate: 'Calculate',
  preview: 'Preview',
}

/** Each step's one heading. */
export const STEP_HEADINGS: Record<StepId, string> = {
  type: 'What is this file?',
  columns: 'Which column is which?',
  values: 'What do the values mean?',
  products: 'Products and teams',
  calculate: 'What should we calculate?',
  preview: 'Check the preview',
}

// ---- Fields -----------------------------------------------------------------

/** Fields shown on the columns step, most useful first. */
export const MAIN_FIELDS = ['externalId', 'subjectKey', 'title', 'category', 'priority', 'status', 'createdAt', 'dueAt', 'completedAt'] as const
/** Fields under "More fields". */
export const MORE_FIELDS = ['committedAt', 'measuredAt', 'planned', 'actual', 'expectedValue', 'deliveredValue', 'url'] as const
/** Fields every record needs a column for (state comes from the status column, or is open). */
export const REQUIRED_FIELDS = ['externalId', 'subjectKey', 'createdAt'] as const

const MANAGED = new Set<string>([...MAIN_FIELDS, ...MORE_FIELDS, 'state'])
const DATE_FIELDS = new Set(['createdAt', 'committedAt', 'dueAt', 'completedAt', 'measuredAt'])

/** A record type created in place, instead of an existing one. */
export const NEW_TYPE = '+new'

// ---- State ------------------------------------------------------------------

/** Everything the admin has told the wizard. Survives Back and Next. */
export interface WizardState {
  /** The template the guesses built, or the saved one being edited: file spec and anything the wizard does not show. */
  base: RecordTemplate
  /** An existing record type ID, or NEW_TYPE. */
  recordType: string
  newType: { name: string; priorities: string }
  source: string
  fullExport: boolean
  templateName: string
  /** Set once the admin types a name, so a type change no longer renames it. */
  nameEdited: boolean
  /** The column each field comes from; empty for none. `status` also gives the state. */
  columns: Record<string, string>
  /** The column each custom field comes from; empty for none. */
  attributes: Record<string, string>
  /** What each raw value means; empty for not answered. The blank value is the key ''. */
  maps: { priority: Record<string, string>; state: Record<string, string> }
  /** OpsVision's suggested priority meanings, restored when a type change makes them valid again. */
  suggestions: Record<string, string>
  /** Layouts that read each date column, by header. */
  dateFormats: Record<string, string[]>
  /** Date columns where day-first and month-first both fit. */
  ambiguous: string[]
  answers: AnswerState
  /** The presets chosen; null keeps the defaults. */
  presets: PresetId[] | null
  /** The scorecard previews evaluate; empty for the first one. */
  scorecardId: string
}

function parseList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== 'none'))]
}

/** "Defects" for "Defect". */
export function pluralName(name: string): string {
  const n = name.trim() || 'Record'
  return /s$/i.test(n) ? n : `${n}s`
}

function guessed(ins: Inspection, field: string): Guess | undefined {
  return ins.guesses.find((g) => g.field === field)
}

/** A name for a type created in place, from what the file holds: priorities and resolved dates, or due dates. */
function newTypeName(ins: Inspection): string {
  if (guessed(ins, 'priority') && guessed(ins, 'completedAt')) return 'Defect'
  if (guessed(ins, 'dueAt')) return 'Epic'
  return ''
}

/** The priorities the file's values suggest, highest first. */
function filePriorities(ins: Inspection): string[] {
  const out = new Set<string>()
  for (const v of ins.values.priority ?? []) if (v.suggested && v.suggested !== 'none') out.add(v.suggested)
  return [...out].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

export function typeName(state: WizardState, types: readonly RecordType[]): string {
  if (state.recordType === NEW_TYPE) return state.newType.name.trim() || 'Record'
  return types.find((t) => t.id === state.recordType)?.name ?? state.recordType
}

/** The chosen type's priorities, highest first (without `none`). */
export function typePriorities(state: WizardState, types: readonly RecordType[]): string[] {
  if (state.recordType === NEW_TYPE) return parseList(state.newType.priorities)
  return types.find((t) => t.id === state.recordType)?.priorities ?? []
}

/** The chosen record type as the API stores it; a new one is not saved yet (revision 0). */
export function chosenType(state: WizardState, types: readonly RecordType[]): RecordType | undefined {
  if (state.recordType !== NEW_TYPE) return types.find((t) => t.id === state.recordType)
  return {
    id: recordTypeId(state.newType.name),
    name: state.newType.name.trim(),
    priorities: parseList(state.newType.priorities),
    attributes: [],
    trackedFrom: {},
    revision: 0,
  }
}

function withValidPriorities(state: WizardState, priorities: readonly string[]): WizardState {
  const allowed = new Set([...priorities, 'none'])
  const priority: Record<string, string> = {}
  for (const [raw, meaning] of Object.entries(state.maps.priority)) {
    const suggested = state.suggestions[raw] ?? ''
    priority[raw] = allowed.has(meaning) ? meaning : allowed.has(suggested) ? suggested : ''
  }
  return { ...state, maps: { ...state.maps, priority } }
}

/** Switches the record type; custom-field columns follow the new type's fields, matched by header. */
export function chooseType(state: WizardState, id: string, types: readonly RecordType[], headers: readonly string[] = []): WizardState {
  const rt = id === NEW_TYPE ? undefined : types.find((t) => t.id === id)
  const attributes = attributeColumns(rt, headers, undefined)
  for (const key of Object.keys(attributes)) if (state.attributes[key]) attributes[key] = state.attributes[key]
  const next = { ...state, recordType: id, attributes }
  return withValidPriorities(next, typePriorities(next, types))
}

export function setNewType(state: WizardState, patch: Partial<WizardState['newType']>, types: readonly RecordType[]): WizardState {
  const next = { ...state, newType: { ...state.newType, ...patch } }
  return withValidPriorities(next, typePriorities(next, types))
}

/** Picks a unique template name and ID: "Defects export 2" when "Defects export" is taken. */
export function uniqueTemplate(name: string, templates: readonly ImportTemplate[]): { id: string; name: string } {
  const names = new Set(templates.map((t) => t.name.trim().toLowerCase()))
  const ids = new Set(templates.map((t) => t.id))
  const base = name.trim() || 'Records export'
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`
    const id = slugify(candidate) || `records-export-${n}`
    if (!names.has(candidate.toLowerCase()) && !ids.has(id)) return { id, name: candidate }
  }
}

/** Renames the template after its type ("Incidents export"), unless the admin named it. */
export function renameDefault(state: WizardState, types: readonly RecordType[], templates: readonly ImportTemplate[]): WizardState {
  if (state.nameEdited) return state
  return { ...state, templateName: uniqueTemplate(`${pluralName(typeName(state, types))} export`, templates).name }
}

function attributeColumns(rt: RecordType | undefined, headers: readonly string[], saved: RecordTemplate['attributes']) {
  const out: Record<string, string> = {}
  for (const a of rt?.attributes ?? []) {
    const label = (a.name || a.key).trim().toLowerCase()
    out[a.key] = saved?.[a.key]?.column ?? headers.find((h) => h.trim().toLowerCase() === label) ?? ''
  }
  return out
}

function columnsOf(t: RecordTemplate): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of [...MAIN_FIELDS, ...MORE_FIELDS]) out[f] = t.fields[f]?.column ?? ''
  out.status = t.fields.status?.column ?? t.fields.state?.column ?? ''
  return out
}

/** A field's map from the template, plus every value in the file it does not cover (with its suggestion). */
function mapOf(t: RecordTemplate, ins: Inspection, field: 'priority' | 'state'): Record<string, string> {
  const fm = t.fields[field]
  const out: Record<string, string> = { ...fm?.map }
  if (fm?.default) out[''] = fm.default
  const sameColumn = guessed(ins, field)?.column === (field === 'state' ? (t.fields.state?.column ?? t.fields.status?.column) : fm?.column)
  if (sameColumn) for (const v of ins.values[field] ?? []) out[v.value] ??= v.suggested
  return out
}

function suggestionsOf(ins: Inspection): Record<string, string> {
  return Object.fromEntries((ins.values.priority ?? []).map((v) => [v.value, v.suggested]))
}

/** The wizard's starting point for a new file: every field at OpsVision's guess. */
export function initialState({
  result,
  recordTypes,
  units,
  items,
  templates,
}: {
  result: RecordsInspectResult
  recordTypes: readonly RecordType[]
  units: readonly OrgUnit[]
  items: readonly TrackedItem[]
  templates: readonly ImportTemplate[]
}): WizardState {
  const ins = result.inspection
  const draft = ins.draft
  const rt = recordTypes.find((t) => t.id === ins.suggestedType)
  const subjects: Record<string, string> = {}
  for (const q of productQuestions(result.subjects, units, items).asks) {
    if (q.suggestedId !== '') subjects[q.value] = `to:${q.suggestedId}`
  }
  const state: WizardState = {
    base: draft,
    recordType: rt ? rt.id : NEW_TYPE,
    // A name is only suggested when no existing type fits; otherwise it would name that type again.
    newType: { name: rt ? '' : newTypeName(ins), priorities: filePriorities(ins).join(', ') },
    source: draft.source || 'tracker',
    fullExport: draft.fullExport,
    templateName: '',
    nameEdited: false,
    columns: columnsOf(draft),
    attributes: attributeColumns(rt, ins.headers, draft.attributes),
    maps: { priority: mapOf(draft, ins, 'priority'), state: mapOf(draft, ins, 'state') },
    suggestions: suggestionsOf(ins),
    dateFormats: { ...ins.dateFormats },
    ambiguous: [...ins.ambiguousDates],
    answers: { ...emptyAnswers(), subjects },
    presets: null,
    scorecardId: '',
  }
  return renameDefault(withValidPriorities(state, typePriorities(state, recordTypes)), recordTypes, templates)
}

/** The wizard's starting point for "Edit mapping": the saved template, read against a recent export. */
export function stateFromTemplate({
  template,
  result,
  recordTypes,
}: {
  template: ImportTemplate
  result: RecordsInspectResult
  recordTypes: readonly RecordType[]
}): WizardState {
  const body = template.body as unknown as RecordTemplate
  const ins = result.inspection
  const rt = recordTypes.find((t) => t.id === body.recordType)
  const attributes: Record<string, string> = {}
  for (const a of rt?.attributes ?? []) attributes[a.key] = body.attributes?.[a.key]?.column ?? ''
  return {
    base: body,
    recordType: body.recordType,
    newType: { name: '', priorities: '' },
    source: body.source,
    fullExport: body.fullExport,
    templateName: template.name,
    nameEdited: true,
    columns: columnsOf(body),
    attributes,
    maps: { priority: mapOf(body, ins, 'priority'), state: mapOf(body, ins, 'state') },
    suggestions: suggestionsOf(ins),
    dateFormats: { ...ins.dateFormats },
    ambiguous: [...ins.ambiguousDates],
    answers: emptyAnswers(),
    presets: null,
    scorecardId: '',
  }
}

// ---- Columns ----------------------------------------------------------------

export type Confidence = 'likely' | 'check' | 'chosen' | 'none'

/** How sure the wizard is of a field's column: "likely" from 0.7, "check" below, the admin's own choice, or none. */
export function confidenceOf(field: string, column: string, guesses: readonly Guess[]): Confidence {
  if (column === '') return 'none'
  const g = guesses.find((x) => x.field === field)
  if (!g || g.column !== column) return 'chosen'
  return g.confidence >= 0.7 ? 'likely' : 'check'
}

function columnValues(column: string, ins: Inspection): string[] {
  const at = ins.headers.findIndex((h) => h.trim() === column.trim())
  if (at < 0) return []
  return ins.samples.map((row) => (row[at] ?? '').trim())
}

/** Up to three distinct sample values from a column. */
export function samplesFor(field: string, column: string, ins: Inspection): string[] {
  if (column === '') return []
  const g = ins.guesses.find((x) => x.field === field && x.column === column)
  if (g && g.samples.length > 0) return g.samples.slice(0, 3)
  return [...new Set(columnValues(column, ins).filter((v) => v !== ''))].slice(0, 3)
}

export function missingRequired(state: WizardState): string[] {
  return REQUIRED_FIELDS.filter((f) => !state.columns[f])
}

// ---- Values -----------------------------------------------------------------

/**
 * The distinct values of the priority or status column with row counts. When
 * the admin picked another column than the guess, only the sample rows are
 * known, so the counts come from those (`fromSamples`).
 */
export function valueRows(field: 'priority' | 'state', state: WizardState, ins: Inspection): { fromSamples: boolean; rows: { value: string; count: number }[] } {
  const column = field === 'state' ? state.columns.status : state.columns[field]
  if (!column) return { fromSamples: false, rows: [] }
  const known = ins.values[field]
  if (known && guessed(ins, field)?.column === column) {
    return { fromSamples: false, rows: known.map((v) => ({ value: v.value, count: v.count })) }
  }
  const counts = new Map<string, number>()
  for (const v of columnValues(column, ins)) if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1)
  const blanks = columnValues(column, ins).filter((v) => v === '').length
  const rows = [...counts].map(([value, count]) => ({ value, count }))
  if (blanks > 0) rows.push({ value: '', count: blanks })
  return { fromSamples: true, rows }
}

/** The ambiguous date columns a mapped date field reads. */
export function ambiguousInUse(state: WizardState): string[] {
  const used = new Set([...DATE_FIELDS].map((f) => state.columns[f]).filter(Boolean))
  return state.ambiguous.filter((c) => used.has(c))
}

// ---- Products and teams -----------------------------------------------------

/**
 * Splits the file's product and team values into those already linked to a
 * leaf unit or tracked item (nothing to ask) and those to ask about. A value
 * that is, or probably means, a unit with units under it is asked with that
 * unit as `parentUnitId`, so "Create '<name> (shared)'" is offered.
 */
export function productQuestions(
  subjects: RecordsInspectResult['subjects'],
  units: readonly OrgUnit[],
  items: readonly TrackedItem[],
): { linked: { value: string; rows: number; name: string }[]; asks: SubjectQuestion[] } {
  const parents = new Set(units.map((u) => u.parentId).filter(Boolean))
  const holders = new Map<string, { id: string; name: string; parent: boolean }>()
  for (const u of units) for (const k of u.sourceKeys) holders.set(k, { id: u.id, name: u.name, parent: parents.has(u.id) })
  for (const i of items) for (const k of i.sourceKeys) holders.set(k, { id: i.id, name: i.name, parent: false })
  const linked: { value: string; rows: number; name: string }[] = []
  const asks: SubjectQuestion[] = []
  for (const s of subjects) {
    const h = holders.get(s.value)
    if (h && !h.parent) linked.push({ value: s.value, rows: s.rows, name: h.name })
    else if (h) asks.push({ value: s.value, rows: s.rows, suggestedId: '', candidates: [], parentUnitId: h.id })
    else if (parents.has(s.subjectId)) {
      asks.push({ value: s.value, rows: s.rows, suggestedId: '', candidates: s.candidates.filter((c) => !parents.has(c)), parentUnitId: s.subjectId })
    } else asks.push({ value: s.value, rows: s.rows, suggestedId: s.subjectId, candidates: s.candidates })
  }
  return { linked, asks }
}

// ---- Calculate --------------------------------------------------------------

/** The presets the mapped columns can feed. */
export function offeredPresets(state: WizardState, types: readonly RecordType[]): PresetId[] {
  const has = (f: string) => Boolean(state.columns[f])
  const out: PresetId[] = []
  if (has('dueAt')) out.push('on_time')
  if (typePriorities(state, types).length > 0) out.push('weighted_open')
  if (has('planned') && has('actual')) out.push('within_budget')
  if (has('measuredAt') && has('expectedValue') && has('deliveredValue')) out.push('expected_value')
  out.push('average_age', 'count')
  return out
}

export interface PresetChoiceInfo {
  id: PresetId
  /** The key prefix whose measures the methodology already has, else the record type. */
  keyPrefix: string
  /** Measures of the methodology the preset would use. */
  existing: string[]
}

/** For each offered preset, the measures the methodology already has for it, under the type's key or its plural. */
export function presetChoices(content: Methodology | undefined, typeId: string, offered: readonly PresetId[]): PresetChoiceInfo[] {
  const have = new Set((content?.measures ?? []).map((m) => m.key))
  return offered.map((id) => {
    for (const keyPrefix of [typeId, `${typeId}s`]) {
      const existing = presetKeys(id, { recordType: typeId, keyPrefix }).measures.filter((k) => k.startsWith(`${keyPrefix}_`) && have.has(k))
      if (existing.length > 0) return { id, keyPrefix, existing }
    }
    return { id, keyPrefix: typeId, existing: [] }
  })
}

/** The presets on by default: those whose measures the methodology already has. */
export function defaultPresets(choices: readonly PresetChoiceInfo[]): PresetId[] {
  return choices.filter((c) => c.existing.length > 0).map((c) => c.id)
}

function usesKey(formula: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(formula)
}

/**
 * The draft's content with the chosen presets added: their measures (existing
 * ones derived in place) and, unless a metric already uses all of them, their
 * metric.
 */
export function draftContent(
  content: Methodology,
  picks: readonly { id: PresetId; keyPrefix: string }[],
  ctx: {
    recordType: string
    recordTypeName: string
    priorities: readonly string[]
    statusKeys: readonly string[]
    reportedAt: Metric['reportedAt']
    /** Whether the file has a completed date, which ages run to. */
    hasCompleted?: boolean
  },
): Methodology {
  let next = content
  for (const pick of picks) {
    const params: PresetParams = {
      recordType: ctx.recordType,
      recordTypeName: ctx.recordTypeName,
      keyPrefix: pick.keyPrefix,
      weights: defaultWeights(ctx.priorities),
      bucketBy: 'completedAt',
      ageFrom: 'createdAt',
      ageTo: ctx.hasCompleted === false ? '' : 'completedAt',
      statusKeys: ctx.statusKeys,
      reportedAt: ctx.reportedAt,
    }
    const keys = presetKeys(pick.id, params).measures
    const covered = next.metrics.some((m) => keys.every((k) => usesKey(m.formula, k)))
    next = applyPreset(next, pick.id, { ...params, withMetric: !covered }).content
  }
  return next
}

// ---- Template and answers ---------------------------------------------------

function formatsFor(state: WizardState, field: string, column: string): string[] {
  const known = state.dateFormats[column] ?? []
  if (state.ambiguous.includes(column) && known.length >= 2) {
    return [(state.answers.dateOrder === 'dmy' ? known[1] : known[0]) as string]
  }
  if (known.length > 0) return [...known]
  const prev = state.base.fields[field]
  return prev?.column === column ? [...(prev.dateFormats ?? [])] : []
}

/** A map without unanswered values; the blank value becomes the default. */
function splitMap(m: Record<string, string>): { map: Record<string, string>; blank: string } {
  const map: Record<string, string> = {}
  for (const [raw, meaning] of Object.entries(m)) if (raw !== '' && meaning !== '') map[raw] = meaning
  return { map, blank: m[''] ?? '' }
}

/** The template the wizard's answers describe. */
export function templateFrom(state: WizardState): RecordTemplate {
  const base = state.base
  const fields: Record<string, RecordFieldMap> = {}
  for (const field of [...MAIN_FIELDS, ...MORE_FIELDS]) {
    const column = state.columns[field] ?? ''
    const prev = base.fields[field]
    if (column === '') {
      // A link built from a pattern, or a constant, has no column to choose; keep it.
      if (prev && !prev.column) fields[field] = { ...prev }
      continue
    }
    const fm: RecordFieldMap = prev?.column === column ? { ...prev } : { column }
    if (DATE_FIELDS.has(field)) {
      const formats = formatsFor(state, field, column)
      if (formats.length > 0) fm.dateFormats = formats
      else delete fm.dateFormats
    }
    if (field === 'priority') {
      const { map, blank } = splitMap(state.maps.priority)
      if (Object.keys(map).length > 0) fm.map = map
      else delete fm.map
      fm.default = blank || 'none'
    }
    fields[field] = fm
  }

  const status = state.columns.status ?? ''
  if (status !== '') {
    const { map, blank } = splitMap(state.maps.state)
    const fm: RecordFieldMap = { column: status, map: { '*': 'open', ...map } }
    if (blank) fm.default = blank
    fields.state = fm
  } else {
    fields.state = base.fields.state?.constant ? { ...base.fields.state } : { constant: 'open' }
  }

  for (const [field, fm] of Object.entries(base.fields)) if (!MANAGED.has(field)) fields[field] = { ...fm }

  const attributes: Record<string, RecordFieldMap> = {}
  for (const [key, column] of Object.entries(state.attributes)) {
    if (column === '') continue
    const prev = base.attributes?.[key]
    attributes[key] = prev?.column === column ? { ...prev } : { column }
  }

  const t: RecordTemplate = {
    name: state.templateName.trim(),
    recordType: state.recordType === NEW_TYPE ? recordTypeId(state.newType.name) : state.recordType,
    source: state.source.trim(),
    file: { ...base.file },
    fullExport: state.fullExport,
    fields,
  }
  if (Object.keys(attributes).length > 0) t.attributes = attributes
  if (base.skipRows && base.skipRows.length > 0) t.skipRows = base.skipRows.map((r) => ({ ...r, in: [...r.in] }))
  return t
}

/** The answers the wizard sends with the preview and Apply. */
export function answersFrom(state: WizardState): RecordAnswers {
  return buildAnswers(state.answers)
}

// ---- Steps' shared props ----------------------------------------------------

/** A message per field a step could not accept, keyed by field. */
export type StepErrors = Record<string, string>

export interface StepProps {
  state: WizardState
  update: (change: (s: WizardState) => WizardState) => void
  result: RecordsInspectResult
  recordTypes: readonly RecordType[]
  errors: StepErrors
}

// ---- After Apply ------------------------------------------------------------

/** How many scorecard numbers a preview changes. */
export function metricsChanged(preview: RecordsPreview): number {
  return preview.story.lines.length + preview.story.more
}

/**
 * "Your defects are in. 12 metrics updated." When the numbers come from
 * calculations still in a draft, they change once it is published.
 */
export function successText(name: string, changed: number, { waitsForPublish = false } = {}): string {
  const head = `Your ${pluralName(name).toLowerCase()} are in.`
  if (changed === 0) return `${head} No scorecard numbers changed.`
  const n = `${changed.toLocaleString('en-US')} ${changed === 1 ? 'metric' : 'metrics'}`
  if (waitsForPublish) return `${head} ${n} ${changed === 1 ? 'updates' : 'update'} when you publish.`
  return `${head} ${n} updated.`
}

/** The month derived values start from: the type's tracked-from month for the source, else the as-of date's month. */
export function trackedFromMonth(rt: RecordType | undefined, source: string, asOf: string, fiscalYearStartMonth: number): string {
  const saved = rt?.trackedFrom[source]
  if (saved) return saved
  return formatPeriod(monthOf(new Date(`${asOf}T00:00:00`), fiscalYearStartMonth))
}
