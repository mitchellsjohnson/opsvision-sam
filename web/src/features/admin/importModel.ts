import type { ChangeSetPreview } from '../../api/queries'
import type { components } from '../../api/schema'

type Schemas = components['schemas']
export type ImportFinding = Schemas['ImportFinding']
export type ImportChange = Schemas['ImportChange']
export type Severity = ImportFinding['severity']

/** The only file type the import accepts, and the type the upload is sent as. */
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warn: 'Warning', info: 'Info' }

export type SeverityFilter = 'all' | Severity

export function filterFindings(findings: readonly ImportFinding[], filter: SeverityFilter): ImportFinding[] {
  return filter === 'all' ? [...findings] : findings.filter((f) => f.severity === filter)
}

export function countBySeverity(findings: readonly ImportFinding[]): Record<SeverityFilter, number> {
  const out: Record<SeverityFilter, number> = { all: findings.length, error: 0, warn: 0, info: 0 }
  for (const f of findings) out[f.severity] += 1
  return out
}

/** "1 data point", "2 data points". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What applying a preview writes, in words, for the confirmation. */
export function describeCounts(c: ChangeSetPreview['counts']): string {
  return [
    plural(c.dataPoints, 'data point', 'data points'),
    plural(c.overrides, 'override', 'overrides'),
    plural(c.versionText, 'methodology text change', 'methodology text changes'),
    plural(c.legacyNotes, 'legacy note', 'legacy notes'),
  ].join(', ')
}

export interface SampleRow {
  kind: string
  target: string
  subject: string
  period: string
  change: string
}

const KIND_LABEL: Record<string, string> = {
  data_point: 'Data point',
  override: 'Override',
  version_text: 'Methodology text',
}

/** One sample change as table cells. */
export function sampleRow(c: ImportChange): SampleRow {
  const kind = KIND_LABEL[c.kind] ?? c.kind
  switch (c.kind) {
    case 'data_point':
      return {
        kind,
        target: c.measureKey ?? '',
        subject: c.subjectId ?? '',
        period: c.period ?? '',
        change: c.naReason ? `Not applicable: ${c.naReason}` : String(c.value ?? ''),
      }
    case 'override':
      return {
        kind,
        target: c.metricKey ?? '',
        subject: c.subjectId ?? '',
        period: c.period ?? '',
        change: [c.value !== undefined ? String(c.value) : '', c.status ? `status ${c.status}` : '']
          .filter(Boolean)
          .join(', '),
      }
    default:
      return { kind, target: c.metricKey ?? '', subject: '', period: '', change: `${c.field ?? ''}: ${c.text ?? ''}` }
  }
}

/** Sends the workbook to the pre-signed URL. No Authorization header: the URL carries its own permission. */
export function putWorkbook(url: string, file: File): Promise<void> {
  return putFile(url, file, XLSX_TYPE)
}

/** Sends a file to a pre-signed URL as `contentType`, the type the URL was signed for. */
export async function putFile(url: string, file: File, contentType: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file })
  } catch {
    throw new Error('The file could not be sent. Check your connection and try again.')
  }
  if (!res.ok) throw new Error(`The upload was refused (status ${res.status}). Upload the file again.`)
}

/** `1.2 MB`, `340 KB`. */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export type TemplateBodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/** Parses the template body text: it must be a JSON object. */
export function parseTemplateBody(text: string): TemplateBodyResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : 'could not be parsed'}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The body must be a JSON object with "sheets", "rows" and "methodology".' }
  }
  return { ok: true, value: raw as Record<string, unknown> }
}
