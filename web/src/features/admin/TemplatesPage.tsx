import { useState } from 'react'
import { Link } from 'react-router'
import { useImportTemplates, usePutImportTemplate, useRecordTypes, type ImportTemplate } from '../../api/queries'
import { errorsFrom } from './adminModel'
import { QueryState, TextAreaField, linkButton, primaryButton, secondaryButton } from './formUi'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 31, 2026" for an RFC 3339 time, by its written date. */
export function dayLabel(iso: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m) return 'Not used yet'
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`
}

/** Where "Edit mapping" opens the setup wizard: the columns step for a saved template. */
export function editMappingHref(templateId: string): string {
  return `/admin/import/setup?${new URLSearchParams({ template: templateId, step: 'columns' }).toString()}`
}

function TemplateJson({ template, onSaved }: { template: ImportTemplate; onSaved: (name: string) => void }) {
  const put = usePutImportTemplate()
  const [text, setText] = useState(() => JSON.stringify(template.body, null, 2))
  const [errors, setErrors] = useState<string[]>([])

  async function save() {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (e) {
      setErrors([`Not valid JSON: ${e instanceof Error ? e.message : 'could not be parsed'}`])
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      setErrors(['Expected an object.'])
      return
    }
    try {
      await put.mutateAsync({ id: template.id, name: template.name, profile: 'records', body: body as Record<string, unknown> })
      setErrors([])
      onSaved(template.name)
    } catch (err) {
      const e = errorsFrom(err)
      setErrors([...e.general, ...Object.entries(e.fields).flatMap(([path, msgs]) => msgs.map((m) => `${path}: ${m}`))])
    }
  }

  return (
    <div className="space-y-2">
      <TextAreaField
        label={`Template JSON for ${template.name}`}
        hint="How each column of the export maps to record fields. The setup wizard writes this for you."
        rows={16}
        spellCheck={false}
        className="font-mono"
        value={text}
        errors={errors}
        onChange={(e) => {
          setText(e.target.value)
          setErrors([])
        }}
      />
      <button type="button" className={primaryButton} disabled={put.isPending} onClick={() => void save()}>
        {put.isPending ? 'Saving…' : `Save ${template.name}`}
      </button>
    </div>
  )
}

/** Admin → Templates: the saved mappings monthly uploads are read with. */
export function TemplatesPage() {
  const templates = useImportTemplates()
  const types = useRecordTypes()
  const [open, setOpen] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const rows = (templates.data ?? []).filter((t) => t.profile === 'records')
  const typeName = new Map((types.data ?? []).map((t) => [t.id, t.name]))
  const opened = rows.find((t) => t.id === open)

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold text-accent-deep">Templates</h1>
      <p className="text-sm text-ink/80">
        Saved mappings from an export&rsquo;s columns to records. Each monthly upload of the same export uses its
        template, so you set it up once.
      </p>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={templates.isPending} error={templates.error} what="templates" />
      {templates.data && rows.length === 0 && (
        <p>
          No saved templates yet. Upload an export on the{' '}
          <Link className="underline" to="/admin/import">
            Import page
          </Link>{' '}
          to set one up.
        </p>
      )}
      {rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Saved templates</caption>
          <thead>
            <tr className="border-b border-ink/20">
              <th scope="col" className="py-2 pr-4 font-semibold">Template</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Record type</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Source system</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Last used</th>
              <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const recordType = String(t.body.recordType ?? '')
              return (
                <tr key={t.id} className="border-b border-ink/10 align-top">
                  <th scope="row" className="py-2 pr-4 font-medium">{t.name}</th>
                  <td className="py-2 pr-4">{typeName.get(recordType) ?? recordType}</td>
                  <td className="py-2 pr-4">{String(t.body.source ?? '')}</td>
                  <td className="py-2 pr-4">{dayLabel(t.lastUsed)}</td>
                  <td className="py-2">
                    <span className="flex flex-wrap gap-1">
                      <Link className={secondaryButton} to={editMappingHref(t.id)} aria-label={`Edit mapping for ${t.name}`}>
                        Edit mapping
                      </Link>
                      <button
                        type="button"
                        className={linkButton}
                        aria-expanded={open === t.id}
                        aria-controls="template-json"
                        aria-label={`Advanced JSON for ${t.name}`}
                        onClick={() => {
                          setOpen(open === t.id ? null : t.id)
                          setNotice('')
                        }}
                      >
                        Advanced JSON
                      </button>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <div id="template-json">
        {opened && (
          <section aria-labelledby="template-json-h" className="space-y-2 rounded-lg border border-ink/20 p-4">
            <h2 id="template-json-h" className="text-lg font-semibold">
              Advanced: {opened.name}
            </h2>
            <TemplateJson key={opened.id} template={opened} onSaved={(name) => setNotice(`Saved ${name}.`)} />
          </section>
        )}
      </div>
    </section>
  )
}
