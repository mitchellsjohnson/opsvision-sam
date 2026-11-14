import { useId, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  useItems,
  useLayout,
  useMe,
  useMembers,
  useOrgUnits,
  usePublishReport,
  usePutReportSummary,
  useReportDocument,
  useReportMonths,
  useReportSummary,
  useScorecards,
} from '../../api/queries'
import type { components } from '../../api/schema'
import { parsePeriod, periodLabel } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { StatusBadge } from '../../ui/StatusBadge'
import { inputClass, primaryButton, secondaryButton } from '../admin/formUi'
import { defaultStatusScale } from './charts/chartTheme'
import { downloadBlob } from './exports'
import {
  buildReportModel,
  dateLabel,
  metricFacts,
  noteSections,
  reportFileName,
  reportStatusLine,
  type ReportMetric,
  type ReportModel,
} from './report/model'
import { subtreeSubjects } from './viewRequest'

type ReportSummary = components['schemas']['ReportSummary']

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
} as const

function SummaryEditor({ scorecardId, period, summary }: { scorecardId: string; period: string; summary: ReportSummary }) {
  const id = useId()
  const [text, setText] = useState(summary.text)
  const [saved, setSaved] = useState(false)
  const put = usePutReportSummary(scorecardId, period)
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-sm font-medium">
        Summary
      </label>
      <textarea
        id={id}
        rows={4}
        maxLength={8000}
        className={inputClass}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setSaved(false)
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={secondaryButton}
          disabled={put.isPending}
          onClick={() => put.mutate({ text, expectedRevision: summary.revision }, { onSuccess: () => setSaved(true) })}
        >
          Save summary
        </button>
        {saved && (
          <p role="status" className="text-sm text-ink/80">
            Summary saved.
          </p>
        )}
        {put.isError && (
          <p role="alert" className="text-sm text-status-r">
            Could not save the summary: {put.error.message}
          </p>
        )}
      </div>
    </div>
  )
}

function MetricBlock({ metric }: { metric: ReportMetric }) {
  const id = useId()
  return (
    <article aria-labelledby={id} className="h-full rounded-lg border border-ink/20 bg-white p-4">
      <h3 id={id} className="text-base font-semibold">
        {metric.name}
      </h3>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge status={metric.status} label={metric.statusLabel || undefined} />
        <span className="text-2xl font-semibold tabular-nums">{metric.display || '—'}</span>
      </p>
      <ul className="mt-2 space-y-0.5 text-sm text-ink/80">
        {metricFacts(metric).map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </article>
  )
}

function ReportBody({ model, scorecardName }: { model: ReportModel; scorecardName: string }) {
  const first = model.columns[0]?.fullLabel ?? ''
  const last = model.columns.filter((c) => !c.ytd).at(-1)?.fullLabel ?? ''
  return (
    <>
      <section aria-labelledby="report-needs" className="pt-8">
        <h2 id="report-needs" className="text-lg font-semibold text-accent-deep">
          Needs attention
        </h2>
        {model.needsAttention.length === 0 ? (
          <p className="mt-2 text-sm text-ink/80">Nothing needs attention this month.</p>
        ) : (
          <ul className="mt-3 grid gap-4 lg:grid-cols-3">
            {model.needsAttention.map((m) => (
              <li key={m.key}>
                <MetricBlock metric={m} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {model.categories.map((c) => (
        <section key={c.id} aria-labelledby={`report-cat-${c.id}`} className="pt-8">
          <h2 id={`report-cat-${c.id}`} className="text-lg font-semibold text-accent-deep">
            {c.name}
          </h2>
          <ul className="mt-3 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
            {c.metrics.map((m) => (
              <li key={m.key}>
                <MetricBlock metric={m} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="report-table" className="pt-8">
        <h2 id="report-table" className="text-lg font-semibold text-accent-deep">
          Scorecard table
        </h2>
        <table className="mt-3 w-full table-fixed border-separate border-spacing-0 rounded-lg bg-white text-sm">
          <caption className="px-3 py-2 text-left text-sm font-medium">
            {`${scorecardName}, ${first} – ${last}, with year to date, ${model.scopeLabel}`}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-[clamp(10rem,28%,18rem)] border-b border-ink/30 px-3 py-2 text-left font-semibold">
                Metric
              </th>
              {model.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  title={c.fullLabel}
                  className={
                    c.ytd
                      ? 'border-b border-l-2 border-ink/30 px-2 py-2 text-right font-semibold'
                      : 'border-b border-ink/30 px-2 py-2 text-right font-semibold'
                  }
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.table.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="border-b border-ink/10 px-3 py-1.5 text-left font-medium">
                  {r.name}
                </th>
                {r.cells.map((cell, i) => (
                  <td
                    key={model.columns[i]!.key}
                    className={
                      model.columns[i]!.ytd
                        ? 'border-b border-l-2 border-ink/10 border-l-ink/30 px-2 py-1.5 text-right tabular-nums'
                        : 'border-b border-ink/10 px-2 py-1.5 text-right tabular-nums'
                    }
                  >
                    <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                      {cell.naReason ? (
                        <span role="img" aria-label={cell.naReason} className="rounded bg-status-na-bg px-1.5 text-xs text-ink">
                          n/a
                        </span>
                      ) : (
                        <span>{cell.display || '—'}</span>
                      )}
                      {cell.status && <StatusBadge status={cell.status} className="min-w-6 px-1 text-xs" />}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="report-notes" className="pt-8">
        <h2 id="report-notes" className="text-lg font-semibold text-accent-deep">
          Notes
        </h2>
        {noteSections(model).map((s) => (
          <div key={s.heading} className="mt-3">
            <h3 className="text-sm font-semibold">{s.heading}</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink/80">
              {s.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  )
}

/** The monthly operating report: preview, summary, publish, and PPTX and PDF downloads. */
export function ReportPage() {
  const { sc } = useParams()
  const scorecardId = sc ?? ''
  const [params, setParams] = useSearchParams()
  const [period] = usePeriodState()
  const me = useMe()
  const scorecards = useScorecards()
  const orgUnits = useOrgUnits()
  const companyScope = period.scope === ''
  const items = useItems({ enabled: !companyScope })
  const isAdmin = me.data?.role === 'admin'
  const fy = period.fiscalYearStartMonth
  const parsed = parsePeriod(period.period)
  const isMonth = parsed?.grain === 'month'
  const revision = params.get('revision') === 'live' ? 'live' : ''
  const months = useReportMonths(isMonth ? scorecardId : undefined)
  const doc = useReportDocument(isMonth && period.ready ? scorecardId : undefined, period.period, revision)
  const summary = useReportSummary(scorecardId, period.period, isAdmin && isMonth && companyScope)
  const members = useMembers({ enabled: isAdmin })
  const layout = useLayout(scorecardId)
  const publish = usePublishReport(scorecardId, period.period)
  const [useMyLayout, setUseMyLayout] = useState(false)
  const [exporting, setExporting] = useState<'' | 'pptx' | 'pdf'>('')
  const [exportError, setExportError] = useState('')
  const warningId = useId()

  const scale = me.data?.tenant?.statusScale?.length ? me.data.tenant.statusScale : defaultStatusScale()
  const companyName = me.data?.tenant?.name ?? 'Company'
  const scorecardName = scorecards.data?.scorecards.find((s) => s.id === sc)?.name ?? 'Scorecard'
  const scopeName = orgUnits.data?.units.find((u) => u.id === period.scope)?.name ?? 'Selected unit'
  const scopeSubjects = useMemo(
    () => (companyScope ? [] : subtreeSubjects([period.scope], { units: orgUnits.data?.units, items: items.data })),
    [companyScope, period.scope, orgUnits.data?.units, items.data],
  )

  const monthEntry = months.data?.months.find((m) => m.period === period.period)
  /** A name only for an admin who can read the members list and finds the publisher there. */
  const publisherName = (id: string | null | undefined) =>
    isAdmin && id ? members.data?.find((m) => m.userId === id)?.name || undefined : undefined
  const sameRevision = doc.data !== undefined && monthEntry?.status === 'published' && monthEntry.revision === doc.data.revision
  const statusLine = doc.data
    ? reportStatusLine({
        live: doc.data.live,
        period: period.period,
        today: new Date(),
        fiscalYearStartMonth: fy,
        publishedAt: sameRevision ? monthEntry?.publishedAt : doc.data.generatedAt,
        publisherName: sameRevision ? publisherName(monthEntry?.publishedBy) : undefined,
      })
    : ''

  const layoutItems = useMemo(() => (useMyLayout ? (layout.data?.items ?? []) : null), [useMyLayout, layout.data?.items])
  const model = useMemo(
    () =>
      doc.data
        ? buildReportModel({
            doc: doc.data,
            scorecardName,
            companyName,
            scope: period.scope,
            scopeName,
            scopeSubjects,
            period: period.period,
            fiscalYearStartMonth: fy,
            scale,
            layout: layoutItems,
            statusLine,
          })
        : null,
    [doc.data, scorecardName, companyName, period.scope, scopeName, scopeSubjects, period.period, fy, scale, layoutItems, statusLine],
  )

  const search = (patch: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    patch(next)
    const s = next.toString()
    return s ? `?${s}` : ''
  }
  const reportPath = `/scorecards/${scorecardId}/report`
  const liveSearch = search((n) => n.set('revision', 'live'))
  const setRevision = (live: boolean) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (live) next.set('revision', 'live')
      else next.delete('revision')
      return next
    })

  const download = async (kind: 'pptx' | 'pdf') => {
    if (!model) return
    setExporting(kind)
    setExportError('')
    try {
      const bytes =
        kind === 'pptx'
          ? await (await import('./report/pptx')).buildPptx(model)
          : await (await import('./report/pdf')).buildPdf(model)
      downloadBlob(reportFileName(model, kind), MIME[kind], new Blob([bytes.slice()], { type: MIME[kind] }))
    } catch (e) {
      setExportError(`Could not build the ${kind.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting('')
    }
  }

  const controlsDisabled = !isMonth || !model
  const subtitle = [scorecardName, parsed ? periodLabel(parsed, fy) : period.period, companyScope ? `All of ${companyName}` : scopeName]

  return (
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold text-accent-deep">Report</h1>
      <p className="mt-1 text-sm text-ink/80">{subtitle.join(' · ')}</p>
      {isMonth && statusLine && <p className="mt-1 text-sm font-medium">{statusLine}</p>}

      <div role="toolbar" aria-label="Report controls" className="mt-3 flex flex-wrap items-center gap-2">
        {doc.data && !doc.data.live && (
          <button type="button" className={secondaryButton} onClick={() => setRevision(true)}>
            View live
          </button>
        )}
        {revision === 'live' && monthEntry?.status === 'published' && (
          <button type="button" className={secondaryButton} onClick={() => setRevision(false)}>
            View published
          </button>
        )}
        <label className="flex items-center gap-2 px-1 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            disabled={!isMonth}
            checked={useMyLayout}
            onChange={(e) => setUseMyLayout(e.target.checked)}
          />
          Use my layout
        </label>
        <button type="button" className={secondaryButton} disabled={controlsDisabled || exporting !== ''} onClick={() => void download('pptx')}>
          Download PPTX
        </button>
        <button type="button" className={secondaryButton} disabled={controlsDisabled || exporting !== ''} onClick={() => void download('pdf')}>
          Download PDF
        </button>
        {isAdmin && (
          <>
            <button
              type="button"
              className={primaryButton}
              disabled={!isMonth || !doc.data || publish.isPending}
              aria-describedby={isMonth ? warningId : undefined}
              onClick={() => publish.mutate(undefined, { onSuccess: () => setRevision(false) })}
            >
              Publish
            </button>
            {isMonth && (
              <span id={warningId} className="rounded-md border border-amber bg-cream px-2 py-1 text-sm">
                This month is not locked.
              </span>
            )}
          </>
        )}
      </div>

      {!isMonth && <p className="mt-3 text-sm">The monthly report is available on a month.</p>}
      {exporting && (
        <p role="status" className="mt-2 text-sm text-ink/80">
          Building the {exporting.toUpperCase()}…
        </p>
      )}
      {exportError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          {exportError}
        </p>
      )}
      {publish.isError && (
        <p role="alert" className="mt-2 text-sm text-status-r">
          Could not publish: {publish.error.message}
        </p>
      )}
      {isMonth && (period.restate !== '' || period.structure === 'current') && (
        <p className="mt-2 text-sm text-ink/80">
          View options do not apply to the report: it uses the methodology and structure in force each month.
        </p>
      )}

      {isMonth && doc.data?.dataRevised && (
        <section aria-label="Data revised since publication" className="mt-3 rounded-md border border-amber bg-cream p-3 text-sm">
          <p className="font-semibold">Data revised since publication</p>
          <Link to={{ pathname: reportPath, search: liveSearch }} className="font-medium text-accent-deep underline">
            View the live report
          </Link>
          <ul className="mt-2 list-disc pl-5">
            {doc.data.changes.map((c) => {
              const row = doc.data.view.rows.find((r) => r.metricKey === c.metricKey && r.subjectId === c.subjectId)
              const p = parsePeriod(c.period)
              return (
                <li key={`${c.metricKey}/${c.subjectId}/${c.period}`}>
                  {`${row?.metricName ?? c.metricKey}, ${row?.subjectName ?? c.subjectId}, ${p ? periodLabel(p, fy) : c.period}: ${c.was || 'blank'} → ${c.now || 'blank'}`}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {isMonth && doc.isPending && (
        <p role="status" aria-busy="true" className="mt-4">
          Loading report…
        </p>
      )}
      {isMonth && doc.isError && (
        <div role="alert" className="mt-4 rounded-md border border-status-r bg-status-r-bg p-4 text-sm">
          Could not load the report: {doc.error.message}
        </div>
      )}

      {isMonth && model && (
        <>
          <section aria-labelledby="report-summary" className="pt-6">
            <h2 id="report-summary" className="text-lg font-semibold text-accent-deep">
              Summary
            </h2>
            <ul aria-label="Health this month" className="mt-2 flex flex-wrap gap-2">
              {model.health.map((h) => (
                <li key={h.key} className="flex items-center gap-2 rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm">
                  <StatusBadge status={h.key} label={scale.find((s) => s.key === h.key)?.label} />
                  {h.label} {h.count}
                </li>
              ))}
              {model.notReported > 0 && (
                <li className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-sm">Not reported {model.notReported}</li>
              )}
            </ul>
            {model.summaryFor !== null ? (
              <p className="mt-3 text-sm">
                <Link to={{ pathname: reportPath, search: search((n) => n.delete('scope')) }} className="font-medium text-accent-deep underline">
                  {model.summaryFor}
                </Link>
              </p>
            ) : isAdmin ? (
              <>
                {!doc.data?.live && (
                  <p className="mt-3 text-sm text-ink/80">Edits apply to the live report and the next publish.</p>
                )}
                {summary.data && <SummaryEditor key={period.period} scorecardId={scorecardId} period={period.period} summary={summary.data} />}
              </>
            ) : (
              <p className="mt-3 whitespace-pre-wrap text-sm">{model.summary || 'No summary written for this month.'}</p>
            )}
            {model.facts.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-sm">
                {model.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </section>

          <ReportBody model={model} scorecardName={scorecardName} />
        </>
      )}

      {isMonth && months.data && months.data.months.length > 0 && (
        <section aria-labelledby="report-history" className="pt-8">
          <h2 id="report-history" className="text-lg font-semibold text-accent-deep">
            Report history
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {[...months.data.months].reverse().map((m) => {
              const p = parsePeriod(m.period)
              const name = publisherName(m.publishedBy)
              const status =
                m.status === 'published'
                  ? `Published${m.publishedAt ? ` on ${dateLabel(m.publishedAt)}` : ''}${name ? ` by ${name}` : ''}`
                  : 'Live'
              return (
                <li key={m.period}>
                  <Link
                    to={{
                      pathname: reportPath,
                      search: search((n) => {
                        n.set('period', m.period)
                        n.delete('revision')
                      }),
                    }}
                    aria-current={m.period === period.period ? 'page' : undefined}
                    className="font-medium text-accent-deep underline"
                  >
                    {p ? periodLabel(p, fy) : m.period}
                  </Link>
                  {` · ${status}`}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
