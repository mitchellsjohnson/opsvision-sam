import type { RecordType } from '../../api/queries'

/**
 * The condition builder's model: rows of field · operator · value, all of
 * which must hold. `toWhere` compiles rows to the where expression the API
 * accepts (api/internal/records/cond.go); `fromWhere` reads one back when the
 * builder can show it.
 *
 * The API's grammar has no date literals, so date operators compare a date
 * field with another date field ("completed on or before the due date").
 * Missing dates and built-in numbers never match a comparison, so a date
 * "is empty" cannot be expressed; "has a date" is `field == field`.
 */

export type ConditionOp =
  | 'is'
  | 'is_not'
  | 'one_of'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'greater'
  | 'less'
  | 'is_empty'
  | 'not_empty'

export type ConditionRow = { field: string; op: ConditionOp; value?: string | string[] | boolean }

export type FieldKind = 'text' | 'choice' | 'bool' | 'number' | 'date'

export interface ConditionField {
  key: string
  label: string
  kind: FieldKind
  /** The values a choice field can take. */
  options?: { value: string; label: string }[]
}

/** Built-in date fields; attribute dates are passed to toWhere and fromWhere's callers. */
export const DATE_FIELDS = ['createdAt', 'committedAt', 'dueAt', 'completedAt', 'measuredAt'] as const

export const DATE_LABELS: Record<string, string> = {
  createdAt: 'Created date',
  committedAt: 'Committed date',
  dueAt: 'Due date',
  completedAt: 'Completed date',
  measuredAt: 'Measured date',
}

export const NUMBER_LABELS: Record<string, string> = {
  planned: 'Planned',
  actual: 'Actual',
  expectedValue: 'Expected value',
  deliveredValue: 'Delivered value',
}

export const STATE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

/** The record type's priorities with `none`, the implicit lowest, last. */
export function allPriorities(priorities: readonly string[]): string[] {
  const out = [...new Set(priorities.filter((p) => p !== 'none'))]
  return [...out, 'none']
}

export function priorityLabel(p: string): string {
  return p === 'none' ? 'No priority' : p
}

/** The fields a condition can use for a record type, in the order the builder lists them. */
export function conditionFields(rt: RecordType): ConditionField[] {
  const attr = (kind: 'string' | 'number' | 'bool' | 'date'): FieldKind => (kind === 'string' ? 'text' : kind)
  return [
    { key: 'category', label: 'Category', kind: 'text' },
    {
      key: 'priority',
      label: 'Priority',
      kind: 'choice',
      options: allPriorities(rt.priorities).map((p) => ({ value: p, label: priorityLabel(p) })),
    },
    { key: 'state', label: 'State', kind: 'choice', options: STATE_OPTIONS },
    { key: 'status', label: 'Status', kind: 'text' },
    { key: 'subjectKey', label: 'Product or team', kind: 'text' },
    { key: 'title', label: 'Title', kind: 'text' },
    ...rt.attributes.map((a) => ({ key: a.key, label: a.name || a.key, kind: attr(a.type) })),
    ...DATE_FIELDS.map((key) => ({ key, label: DATE_LABELS[key] ?? key, kind: 'date' as const })),
    ...Object.entries(NUMBER_LABELS).map(([key, label]) => ({ key, label, kind: 'number' as const })),
  ]
}

const OP_LABELS: Record<ConditionOp, string> = {
  is: 'is',
  is_not: 'is not',
  one_of: 'is one of',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  greater: 'is more than',
  less: 'is less than',
  is_empty: 'is empty',
  not_empty: 'is not empty',
}

const OPS: Record<FieldKind, ConditionOp[]> = {
  text: ['is', 'is_not', 'one_of', 'is_empty', 'not_empty'],
  choice: ['is', 'is_not', 'one_of'],
  bool: ['is'],
  number: ['greater', 'less'],
  date: ['before', 'after', 'on_or_before', 'on_or_after', 'not_empty'],
}

/** The operators the builder offers for a kind of field, with their labels. */
export function opsFor(kind: FieldKind): { value: ConditionOp; label: string }[] {
  return OPS[kind].map((value) => ({
    value,
    label: kind === 'date' && value === 'not_empty' ? 'has a date' : OP_LABELS[value],
  }))
}

/** A new row for a field: its first operator and a starting value. */
export function newRow(field: ConditionField, fields: readonly ConditionField[]): ConditionRow {
  const op = OPS[field.kind][0] ?? 'is'
  return { field: field.key, op, value: defaultValue(field, op, fields) }
}

/** The value a row starts with when its field or operator changes. */
export function defaultValue(
  field: ConditionField,
  op: ConditionOp,
  fields: readonly ConditionField[],
  previous?: ConditionRow['value'],
): ConditionRow['value'] {
  if (op === 'is_empty' || op === 'not_empty') return undefined
  if (field.kind === 'bool') return typeof previous === 'boolean' ? previous : true
  if (field.kind === 'date') {
    if (typeof previous === 'string' && previous !== field.key && fields.some((f) => f.key === previous && f.kind === 'date')) {
      return previous
    }
    return fields.find((f) => f.kind === 'date' && f.key !== field.key)?.key ?? ''
  }
  const first = typeof previous === 'string' ? previous : Array.isArray(previous) ? (previous[0] ?? '') : ''
  if (op === 'one_of') return Array.isArray(previous) ? previous : first === '' ? [] : [first]
  if (field.kind === 'choice') {
    const known = field.options?.some((o) => o.value === first)
    return known ? first : (field.options?.[0]?.value ?? '')
  }
  return first
}

// ---- Compiling --------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUMBER = /^-?\d+(\.\d+)?$/

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const COMPARE: Partial<Record<ConditionOp, string>> = {
  before: '<',
  after: '>',
  on_or_before: '<=',
  on_or_after: '>=',
  greater: '>',
  less: '<',
}

/** One row as an expression, or '' when the row is not finished. */
function rowWhere(row: ConditionRow, dateFields: readonly string[]): string {
  const f = row.field
  if (!IDENT.test(f)) return ''
  const v = row.value
  switch (row.op) {
    case 'is':
      if (typeof v === 'boolean') return v ? f : `!${f}`
      return typeof v === 'string' && v !== '' ? `${f} == ${quote(v)}` : ''
    case 'is_not':
      return typeof v === 'string' && v !== '' ? `${f} != ${quote(v)}` : ''
    case 'one_of': {
      const list = Array.isArray(v) ? v.filter((x) => x !== '') : []
      return list.length > 0 ? `${f} in [${list.map(quote).join(', ')}]` : ''
    }
    case 'before':
    case 'after':
    case 'on_or_before':
    case 'on_or_after':
      return typeof v === 'string' && IDENT.test(v) ? `${f} ${COMPARE[row.op]} ${v}` : ''
    case 'greater':
    case 'less':
      return typeof v === 'string' && NUMBER.test(v.trim()) ? `${f} ${COMPARE[row.op]} ${v.trim()}` : ''
    case 'is_empty':
      return dateFields.includes(f) ? '' : `${f} == ''`
    case 'not_empty':
      return dateFields.includes(f) ? `${f} == ${f}` : `${f} != ''`
  }
}

/**
 * Compiles rows to a where expression: each finished row, joined with &&.
 * Unfinished rows (no value yet) are left out, so the result always compiles.
 * `dateFields` names the date fields (date attributes included).
 */
export function toWhere(rows: readonly ConditionRow[], dateFields: readonly string[] = DATE_FIELDS): string {
  return rows
    .map((r) => rowWhere(r, dateFields))
    .filter((s) => s !== '')
    .join(' && ')
}

/** Whether a row compiles to something (has a value where it needs one). */
export function isComplete(row: ConditionRow, dateFields: readonly string[] = DATE_FIELDS): boolean {
  return rowWhere(row, dateFields) !== ''
}

// ---- Reading back -------------------------------------------------------------

type Token =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'op'; v: string }

function tokenize(src: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      let s = ''
      i++
      let closed = false
      while (i < src.length) {
        const d = src[i] ?? ''
        if (d === '\\') {
          const next = src[i + 1]
          if (next === undefined) return null
          s += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        if (d === c) {
          closed = true
          i++
          break
        }
        s += d
        i++
      }
      if (!closed) return null
      out.push({ t: 'str', v: s })
      continue
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = /^(&&|\|\||==|!=|<=|>=|[<>!()[\],+\-*/%])/.exec(src.slice(i))
    if (op) {
      out.push({ t: 'op', v: op[0] })
      i += op[0].length
      continue
    }
    return null
  }
  return out
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'nil', 'matches', 'contains'])
const BOUNDARY = new Set(['&&', 'and', ')'])

class Reader {
  private i = 0
  constructor(private readonly tokens: Token[]) {}
  peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset]
  }
  next(): Token | undefined {
    return this.tokens[this.i++]
  }
  done(): boolean {
    return this.i >= this.tokens.length
  }
  isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t !== undefined && (t.t === 'op' || t.t === 'id') && t.v === v
  }
}

function isBoundary(t: Token | undefined): boolean {
  return t === undefined || ((t.t === 'op' || t.t === 'id') && BOUNDARY.has(t.v))
}

function field(t: Token | undefined): string | null {
  return t?.t === 'id' && !KEYWORDS.has(t.v) ? t.v : null
}

/** conj := atom (('&&' | 'and') atom)* */
function readConj(r: Reader): ConditionRow[] | null {
  const rows: ConditionRow[] = []
  for (;;) {
    const atom = readAtom(r)
    if (!atom) return null
    rows.push(...atom)
    if (r.isOp('&&') || r.isOp('and')) {
      r.next()
      continue
    }
    return rows
  }
}

function readAtom(r: Reader): ConditionRow[] | null {
  if (r.isOp('(')) {
    r.next()
    const inner = readConj(r)
    if (!inner || !r.isOp(')')) return null
    r.next()
    return inner
  }
  if (r.isOp('!')) {
    r.next()
    const f = field(r.next())
    if (!f || !isBoundary(r.peek())) return null
    return [{ field: f, op: 'is', value: false }]
  }
  const f = field(r.next())
  if (!f) return null
  const op = r.peek()
  if (isBoundary(op)) return [{ field: f, op: 'is', value: true }]
  r.next()
  if (op?.v === '==' || op?.v === '!=') {
    const rhs = r.next()
    if (!isBoundary(r.peek())) return null
    const eq = op.v === '=='
    if (rhs?.t === 'str') {
      if (rhs.v === '') return [{ field: f, op: eq ? 'is_empty' : 'not_empty' }]
      return [{ field: f, op: eq ? 'is' : 'is_not', value: rhs.v }]
    }
    if (rhs?.t === 'id' && (rhs.v === 'true' || rhs.v === 'false')) {
      return [{ field: f, op: 'is', value: (rhs.v === 'true') === eq }]
    }
    if (rhs?.t === 'id' && rhs.v === f && eq) return [{ field: f, op: 'not_empty' }]
    return null
  }
  if (op?.v === '<' || op?.v === '<=' || op?.v === '>' || op?.v === '>=') {
    let rhs = r.next()
    let negative = false
    if (rhs?.t === 'op' && rhs.v === '-') {
      negative = true
      rhs = r.next()
    }
    if (!isBoundary(r.peek())) return null
    if (rhs?.t === 'num') {
      if (op.v === '>') return [{ field: f, op: 'greater', value: `${negative ? '-' : ''}${rhs.v}` }]
      if (op.v === '<') return [{ field: f, op: 'less', value: `${negative ? '-' : ''}${rhs.v}` }]
      return null
    }
    const other = negative ? null : field(rhs)
    if (!other) return null
    const ops = { '<': 'before', '<=': 'on_or_before', '>': 'after', '>=': 'on_or_after' } as const
    return [{ field: f, op: ops[op.v], value: other }]
  }
  if (op?.t === 'id' && op.v === 'in') {
    if (!r.isOp('[')) return null
    r.next()
    const values: string[] = []
    while (!r.isOp(']')) {
      const v = r.next()
      if (v?.t !== 'str') return null
      values.push(v.v)
      if (r.isOp(',')) r.next()
      else if (!r.isOp(']')) return null
    }
    r.next()
    if (!isBoundary(r.peek()) || values.length === 0) return null
    return [{ field: f, op: 'one_of', value: values }]
  }
  return null
}

/**
 * Reads a where expression back into rows, or null when the builder cannot
 * show it (|| or !(…) groups, arithmetic, `not in`, number equality, …).
 * Such expressions are edited under Advanced only.
 */
export function fromWhere(src: string): ConditionRow[] | null {
  if (src.trim() === '') return []
  const tokens = tokenize(src)
  if (!tokens || tokens.length === 0) return null
  const r = new Reader(tokens)
  const rows = readConj(r)
  return rows && r.done() ? rows : null
}

/**
 * The rows for a where expression when every row fits the record type's
 * fields and operators, or null (Advanced only).
 */
export function rowsFor(src: string, fields: readonly ConditionField[]): ConditionRow[] | null {
  const rows = fromWhere(src)
  if (!rows) return null
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const fits = rows.every((row) => {
    const f = byKey.get(row.field)
    if (!f || !OPS[f.kind].includes(row.op)) return false
    if (f.kind === 'bool') return typeof row.value === 'boolean'
    if (typeof row.value === 'boolean') return false
    if (f.kind === 'date' && row.op !== 'not_empty') return byKey.get(String(row.value))?.kind === 'date'
    return true
  })
  return fits ? rows : null
}

/** The date fields (built-in and date attributes) of a record type, for toWhere. */
export function dateFieldsOf(fields: readonly ConditionField[]): string[] {
  return fields.filter((f) => f.kind === 'date').map((f) => f.key)
}
