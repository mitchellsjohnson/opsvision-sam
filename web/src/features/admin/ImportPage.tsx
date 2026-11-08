import * as Tabs from '@radix-ui/react-tabs'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import {
  useApplyImport,
  useCreateImportUpload,
  useImportTemplates,
  useMe,
  useParseImport,
  usePutImportTemplate,
  type ChangeSetPreview,
  type ImportTemplate,
} from '../../api/queries'
import { getConfig } from '../../config'
import { RecordsImport } from '../import/RecordsImport'
import { ID_PATTERN, NO_ERRORS, errorsFrom, forField, slugify, unclaimed, type FormErrors } from './adminModel'
import {
  FormActions,
  FormDialog,
  FormError,
  QueryState,
  SelectField,
  TextAreaField,
  TextField,
  primaryButton,
  secondaryButton,
  useFocusOnError,
} from './formUi'
import {
  SEVERITY_LABEL,
  XLSX_TYPE,
  countBySeverity,
  describeCounts,
  fileSize,
  filterFindings,
  parseTemplateBody,
  plural,
  putWorkbook,
  sampleRow,
  type Severity,
  type SeverityFilter,
} from './importModel'

const NEW_TEMPLATE_BODY = JSON.stringify({ sheets: [], rows: [], methodology: [] }, null, 2)

// ---- Templates --------------------------------------------------------------

function TemplateForm({
  template,
  close,
  onSaved,
}: {
  template?: ImportTemplate
  close: () => void
  onSaved: (message: string) => void
}) {
  const put = usePutImportTemplate()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState(template?.name ?? '')
  const [id, setId] = useState(template?.id ?? '')
  const [idEdited, setIdEdited] = useState(false)
  const [body, setBody] = useState(() => (template ? JSON.stringify(template.body, null, 2) : NEW_TEMPLATE_BODY))
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const local: FormErrors = { fields: {}, general: [] }
    if (name.trim() === '') local.fields.name = ['Enter a name.']
    if (!ID_PATTERN.test(id)) local.fields.id = ["Use 1 to 64 letters, digits, '-' or '_'."]
    const parsed = parseTemplateBody(body)
    if (!parsed.ok) local.fields.body = [parsed.error]
    if (Object.keys(local.fields).length > 0 || !parsed.ok) {
      setErrors(local)
      focusErrors()
      return
    }
    try {
      await put.mutateAsync({ id, name: name.trim(), profile: 'legacy_workbook', body: parsed.value })
      onSaved(`Saved the template ${name.trim()}.`)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Name"
        value={name}
        errors={forField(errors, 'name')}
        onChange={(e) => {
          setName(e.target.value)
          if (!template && !idEdited) setId(slugify(e.target.value))
        }}
      />
      <TextField
        label="ID"
        hint={template ? 'The ID of a saved template cannot change.' : "Letters, digits, '-' and '_'."}
        value={id}
        readOnly={template !== undefined}
        errors={forField(errors, 'id')}
        onChange={(e) => {
          setId(e.target.value)
          setIdEdited(true)
        }}
      />
      <SelectField
        label="Profile"
        hint="Only legacy workbooks (.xlsx) can be imported today."
        value="legacy_workbook"
        options={[{ value: 'legacy_workbook', label: 'Legacy workbook' }]}
        onChange={() => {}}
      />
      <TextAreaField
        label="Mapping (JSON)"
        hint='An object with "sheets", "rows" and "methodology", and optionally "scorecardId".'
        rows={14}
        spellCheck={false}
        className="font-mono"
        value={body}
        errors={forField(errors, 'body')}
        onChange={(e) => setBody(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['name', 'id', 'body'])} />
      <FormActions submitLabel="Save template" pending={put.isPending} onCancel={close} />
    </form>
  )
}

/** Records templates belong to the records import and are not edited as workbook mappings. */
function useLegacyTemplates() {
  const templates = useImportTemplates()
  const data = templates.data?.filter((t) => t.profile !== 'records')
  return { ...templates, data }
}

function TemplatesSection({ onNotice }: { onNotice: (message: string) => void }) {
  const templates = useLegacyTemplates()
  const rows = templates.data ?? []
  return (
    <section aria-labelledby="templates-h" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="templates-h" className="text-lg font-semibold">
          Templates
        </h2>
        <FormDialog
          triggerLabel="New template"
          title="New template"
          description="A template says where a workbook keeps its rows, periods and methodology text, and which metrics and org units they belong to."
          wide
        >
          {(close) => <TemplateForm close={close} onSaved={onNotice} />}
        </FormDialog>
      </div>
      <QueryState isPending={templates.isPending} error={templates.error} what="templates" />
      {templates.data && rows.length === 0 && <p className="text-sm">No templates yet. Add one to map a workbook.</p>}
      {rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Import templates</caption>
          <thead>
            <tr className="border-b border-ink/20">
              <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
              <th scope="col" className="py-2 pr-4 font-semibold">ID</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Profile</th>
              <th scope="col" className="py-2 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b border-ink/10">
                <th scope="row" className="py-2 pr-4 font-medium">{t.name}</th>
                <td className="py-2 pr-4">{t.id}</td>
                <td className="py-2 pr-4">{t.profile === 'legacy_workbook' ? 'Legacy workbook' : t.profile}</td>
                <td className="py-2">
                  <FormDialog
                    triggerLabel="Edit"
                    triggerAriaLabel={`Edit template ${t.name}`}
                    title={`Edit ${t.name}`}
                    description="Change the name or the mapping. Imports parsed later use the saved mapping."
                    wide
                  >
                    {(close) => <TemplateForm template={t} close={close} onSaved={onNotice} />}
                  </FormDialog>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ---- Import flow ------------------------------------------------------------

const SEVERITY_ICON: Record<Severity, typeof Info> = { error: XCircle, warn: AlertTriangle, info: Info }
const SEVERITY_CLASS: Record<Severity, string> = {
  error: 'text-status-r',
  warn: 'text-status-y',
  info: 'text-ink',
}

function SeverityLabel({ severity }: { severity: Severity }) {
  const Icon = SEVERITY_ICON[severity]
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${SEVERITY_CLASS[severity]}`}>
      <Icon aria-hidden="true" className="size-4" />
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

function Counts({ counts }: { counts: ChangeSetPreview['counts'] }) {
  const items = [
    ['Data points', counts.dataPoints],
    ['Overrides', counts.overrides],
    ['Methodology text changes', counts.versionText],
    ['Legacy notes', counts.legacyNotes],
  ] as const
  return (
    <dl className="grid gap-3 sm:grid-cols-4">
      {items.map(([label, n]) => (
        <div key={label} className="rounded-md border border-ink/20 p-3">
          <dt className="text-sm">{label}</dt>
          <dd className="text-2xl font-semibold">{n}</dd>
        </div>
      ))}
    </dl>
  )
}

function Findings({ preview }: { preview: ChangeSetPreview }) {
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const n = countBySeverity(preview.findings)
  const shown = filterFindings(preview.findings, filter)
  return (
    <section aria-labelledby="findings-h" className="space-y-2">
      <h3 id="findings-h" className="font-semibold">
        Findings
      </h3>
      {preview.findings.length === 0 ? (
        <p className="text-sm">No findings.</p>
      ) : (
        <>
          <SelectField
            label="Show"
            className="max-w-xs"
            value={filter}
            options={[
              { value: 'all', label: `All (${n.all})` },
              { value: 'error', label: `Errors (${n.error})` },
              { value: 'warn', label: `Warnings (${n.warn})` },
              { value: 'info', label: `Info (${n.info})` },
            ]}
            onChange={(e) => setFilter(e.target.value as SeverityFilter)}
          />
          <p role="status" className="text-sm">
            Showing {shown.length} of {preview.findings.length} findings.
          </p>
          {shown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Findings from parsing the workbook</caption>
                <thead>
                  <tr className="border-b border-ink/20">
                    <th scope="col" className="py-2 pr-4 font-semibold">Severity</th>
                    <th scope="col" className="py-2 pr-4 font-semibold">Sheet</th>
                    <th scope="col" className="py-2 pr-4 font-semibold">Cell</th>
                    <th scope="col" className="py-2 font-semibold">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((f, i) => (
                    <tr key={`${i}-${f.sheet}-${f.cell}`} className="border-b border-ink/10 align-top">
                      <td className="py-2 pr-4">
                        <SeverityLabel severity={f.severity} />
                      </td>
                      <td className="py-2 pr-4">{f.sheet}</td>
                      <td className="py-2 pr-4">{f.cell}</td>
                      <td className="py-2">{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Sample({ preview }: { preview: ChangeSetPreview }) {
  const total = preview.counts.dataPoints + preview.counts.overrides + preview.counts.versionText
  return (
    <section aria-labelledby="sample-h" className="space-y-2">
      <h3 id="sample-h" className="font-semibold">
        Sample of changes
      </h3>
      {preview.sample.length === 0 ? (
        <p className="text-sm">The import would not change anything.</p>
      ) : (
        <>
          <p className="text-sm">
            Showing {preview.sample.length} of {total} changes.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sample of the changes the import would make</caption>
              <thead>
                <tr className="border-b border-ink/20">
                  <th scope="col" className="py-2 pr-4 font-semibold">Kind</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Measure or metric</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Subject</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Period</th>
                  <th scope="col" className="py-2 font-semibold">Change</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((c, i) => {
                  const r = sampleRow(c)
                  return (
                    <tr key={i} className="border-b border-ink/10 align-top">
                      <td className="py-2 pr-4">{r.kind}</td>
                      <td className="py-2 pr-4">{r.target}</td>
                      <td className="py-2 pr-4">{r.subject}</td>
                      <td className="py-2 pr-4">{r.period}</td>
                      <td className="py-2">{r.change}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function ApplyForm({
  importId,
  preview,
  close,
  onApplied,
}: {
  importId: string
  preview: ChangeSetPreview
  close: () => void
  onApplied: (p: ChangeSetPreview) => void
}) {
  const apply = useApplyImport()
  const { formRef, focusErrors } = useFocusOnError()
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      onApplied(await apply.mutateAsync(importId))
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-3">
      <p className="text-sm">
        This writes {describeCounts(preview.counts)} to the scorecard. An import can be applied only once.
      </p>
      <FormError messages={unclaimed(errors, [])} />
      <FormActions submitLabel="Apply import" pendingLabel="Applying…" pending={apply.isPending} onCancel={close} />
    </form>
  )
}

type Upload =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'done'; importId: string; filename: string }
  | { phase: 'failed'; message: string }

function ImportFlow() {
  const me = useMe()
  const templates = useLegacyTemplates()
  const createUpload = useCreateImportUpload()
  const parse = useParseImport()
  const fileId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const { formRef, focusErrors } = useFocusOnError<HTMLDivElement>()

  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [upload, setUpload] = useState<Upload>({ phase: 'idle' })
  const [templateId, setTemplateId] = useState('')
  const [templateError, setTemplateError] = useState('')
  const [preview, setPreview] = useState<ChangeSetPreview | null>(null)
  const [parseErrors, setParseErrors] = useState<FormErrors>(NO_ERRORS)
  const [applied, setApplied] = useState<ChangeSetPreview | null>(null)
  const [parsedTemplate, setParsedTemplate] = useState('')

  const isAdmin = me.data?.role === 'admin'
  const importId = upload.phase === 'done' ? upload.importId : ''
  const errorCount = preview ? countBySeverity(preview.findings).error : 0
  const canApply = isAdmin && preview !== null && preview.status === 'parsed' && errorCount === 0

  function reset() {
    setFile(null)
    setUpload({ phase: 'idle' })
    setPreview(null)
    setApplied(null)
    setParseErrors(NO_ERRORS)
    if (fileRef.current) fileRef.current.value = ''
  }

  function chooseFile(next: File | null) {
    setFile(next)
    setFileError('')
    // A different file is a different import.
    setUpload({ phase: 'idle' })
    setPreview(null)
    setApplied(null)
    setParseErrors(NO_ERRORS)
  }

  async function doUpload() {
    if (!file) {
      setFileError('Choose a .xlsx workbook first.')
      fileRef.current?.focus()
      return
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setFileError('Only .xlsx workbooks can be imported.')
      fileRef.current?.focus()
      return
    }
    setFileError('')
    setPreview(null)
    setApplied(null)
    setUpload({ phase: 'uploading' })
    try {
      const created = await createUpload.mutateAsync({ filename: file.name, contentType: XLSX_TYPE })
      // The URL is pre-signed: it is called as is, without the API token.
      await putWorkbook(new URL(created.uploadUrl, getConfig().apiUrl).toString(), file)
      setUpload({ phase: 'done', importId: created.importId, filename: file.name })
    } catch (err) {
      setUpload({ phase: 'failed', message: err instanceof Error ? err.message : 'The upload failed.' })
    }
  }

  async function doParse() {
    if (templateId === '') {
      setTemplateError('Choose a template.')
      focusErrors()
      return
    }
    setTemplateError('')
    setParseErrors(NO_ERRORS)
    try {
      const p = await parse.mutateAsync({ id: importId, templateId })
      setPreview(p)
      setParsedTemplate(templateId)
      setTimeout(() => previewHeading.current?.focus(), 0)
    } catch (err) {
      setPreview(null)
      setParseErrors(errorsFrom(err))
      focusErrors()
    }
  }

  const uploadStatus =
    upload.phase === 'uploading'
      ? `Uploading ${file?.name ?? 'the file'}…`
      : upload.phase === 'done'
        ? `Uploaded ${upload.filename}. Choose a template and parse it.`
        : upload.phase === 'failed'
          ? upload.message
          : ''

  const templateName = templates.data?.find((t) => t.id === parsedTemplate)?.name ?? parsedTemplate

  return (
    <section aria-labelledby="flow-h" className="space-y-4">
      <h2 id="flow-h" className="text-lg font-semibold">
        Import a workbook
      </h2>
      <div ref={formRef} className="space-y-4">
        <fieldset className="space-y-2 rounded-md border border-ink/20 p-3">
          <legend className="px-1 text-sm font-medium">1. Upload the workbook</legend>
          <div>
            <label htmlFor={fileId} className="block text-sm font-medium">
              Workbook (.xlsx)
            </label>
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              accept=".xlsx"
              className="mt-1 block text-sm"
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? `${fileId}-err` : undefined}
              onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
            />
            {fileError && (
              <p id={`${fileId}-err`} className="mt-1 flex items-start gap-1 text-sm font-medium text-status-r">
                <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="sr-only">Error: </span>
                  {fileError}
                </span>
              </p>
            )}
            {file && (
              <p className="mt-1 text-sm">
                {file.name} ({fileSize(file.size)})
              </p>
            )}
          </div>
          <button type="button" className={secondaryButton} disabled={upload.phase === 'uploading'} onClick={() => void doUpload()}>
            {upload.phase === 'uploading' ? 'Uploading…' : upload.phase === 'done' ? 'Upload again' : 'Upload'}
          </button>
          <p
            role={upload.phase === 'failed' ? 'alert' : 'status'}
            className={`min-h-5 text-sm font-medium ${upload.phase === 'failed' ? 'text-status-r' : 'text-status-g'}`}
          >
            {uploadStatus}
          </p>
        </fieldset>

        <fieldset className="space-y-2 rounded-md border border-ink/20 p-3" disabled={upload.phase !== 'done'}>
          <legend className="px-1 text-sm font-medium">2. Parse it with a template</legend>
          <SelectField
            label="Template"
            className="max-w-sm"
            value={templateId}
            errors={templateError ? [templateError] : []}
            options={[
              { value: '', label: templates.data?.length === 0 ? 'No templates saved' : 'Choose a template' },
              ...(templates.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(e) => {
              setTemplateId(e.target.value)
              setTemplateError('')
            }}
          />
          <button type="button" className={secondaryButton} disabled={parse.isPending} onClick={() => void doParse()}>
            {parse.isPending ? 'Parsing…' : preview ? 'Parse again' : 'Parse'}
          </button>
          <p className="text-sm text-ink/80">Parsing only previews the changes. Nothing is written until you apply.</p>
          <FormError messages={unclaimed(parseErrors, [])} />
        </fieldset>
      </div>

      {preview && (
        <section aria-labelledby="preview-h" className="space-y-4 border-t border-ink/20 pt-4">
          <h3 id="preview-h" ref={previewHeading} tabIndex={-1} className="text-lg font-semibold">
            Preview
          </h3>
          <p className="text-sm">
            {preview.status === 'applied' ? 'Applied' : 'Parsed'} with the template {templateName}.
          </p>
          <Counts counts={preview.counts} />
          <Findings key={`${preview.id}-${preview.findings.length}-${parsedTemplate}`} preview={preview} />
          <Sample preview={preview} />
          {applied ? (
            <div className="space-y-2">
              <p role="status" className="font-medium text-status-g">
                Applied: {describeCounts(applied.counts)}. Scorecards and the entry grid now show them.
              </p>
              <button type="button" className={secondaryButton} onClick={reset}>
                Import another workbook
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <FormDialog
                triggerLabel="Apply…"
                triggerClassName={primaryButton}
                triggerDisabled={!canApply}
                title="Apply this import?"
                description="Review what will be written before you confirm."
              >
                {(close) => (
                  <ApplyForm
                    importId={importId}
                    preview={preview}
                    close={close}
                    onApplied={(p) => {
                      setApplied(p)
                      setPreview(p)
                    }}
                  />
                )}
              </FormDialog>
              {!isAdmin && me.data && <p className="text-sm">Only admins can apply an import.</p>}
              {isAdmin && errorCount > 0 && (
                <p className="text-sm font-medium text-status-r">
                  {plural(errorCount, 'error', 'errors')} must be fixed before this import can be applied. Fix the
                  template or the workbook, upload again and parse again.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  )
}

const KINDS = [
  { value: 'records', label: 'Records' },
  { value: 'legacy', label: 'Legacy workbook' },
] as const

type Kind = (typeof KINDS)[number]['value']

function LegacyImport() {
  const [notice, setNotice] = useState('')
  return (
    <div className="space-y-8">
      <p className="text-sm text-ink/80">
        Bring in data and methodology text from a legacy workbook: upload it, parse it with a template, review the
        preview, then apply.
      </p>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <TemplatesSection onNotice={setNotice} />
      <ImportFlow />
    </div>
  )
}

/** The import page: records exports first, the legacy workbook import second. The kind is in the URL (`?kind=`). */
export function ImportPage() {
  const heading = useRef<HTMLHeadingElement>(null)
  const [params, setParams] = useSearchParams()
  const kind: Kind = KINDS.find((k) => k.value === params.get('kind'))?.value ?? 'records'
  const showKind = (value: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('kind', value)
      return next
    })
  return (
    <section className="space-y-6">
      <div>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-accent-deep">
          Import
        </h1>
        <p className="mt-1 text-sm text-ink/80">
          Drop your monthly tracker exports, read what changes on the scorecard and why, then apply.
        </p>
      </div>
      <Tabs.Root value={kind} onValueChange={showKind}>
        <Tabs.List aria-label="Kind of import" className="flex gap-1 border-b border-ink/20">
          {KINDS.map((k) => (
            <Tabs.Trigger
              key={k.value}
              value={k.value}
              className="-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium data-[state=active]:border-accent data-[state=active]:text-accent-deep"
            >
              {k.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {/* Kept mounted on the other tab, so previews not applied yet are not lost. */}
        <Tabs.Content value="records" forceMount hidden={kind !== 'records'} className="space-y-4 py-4">
          <h2 className="text-lg font-semibold">Upload records</h2>
          <RecordsImport catchPageDrops onPageDrop={() => kind !== 'records' && showKind('records')} />
        </Tabs.Content>
        <Tabs.Content value="legacy" className="py-4">
          <LegacyImport />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  )
}
