import { useId, useState } from 'react'
import { useVersionDiff, type Methodology, type MethodologyVersion } from '../../api/queries'
import { QueryState, inputClass } from './formUi'
import { effectiveLabel, groupDiff, prettyValue, statusLabel, versionInForce } from './methodologyModel'

function Value({ value }: { value: unknown }) {
  const v = prettyValue(value)
  return v.structured ? (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap rounded bg-cream p-2 font-mono text-xs">{v.text}</pre>
  ) : (
    <span>{v.text}</span>
  )
}

function metricName(key: string, ...contents: (Methodology | undefined)[]): string {
  for (const c of contents) {
    const m = c?.metrics.find((x) => x.key === key)
    if (m && m.name !== '') return `${m.name} (${key})`
  }
  return key
}

/**
 * The changes in a version against another: the version in force by default,
 * or one the person chooses. Metrics are matched by key.
 */
export function DiffView({
  sc,
  version,
  versions,
  fiscalYearStartMonth,
}: {
  sc: string
  version: MethodologyVersion
  versions: readonly MethodologyVersion[]
  fiscalYearStartMonth: number
}) {
  const [against, setAgainst] = useState('')
  const selectId = useId()
  const diff = useVersionDiff(sc, version.id, against)
  const other = versions.find((v) => v.id === against)
  const grouped = diff.data ? groupDiff(diff.data.changes) : undefined
  const total = grouped ? grouped.added.length + grouped.removed.length + grouped.changed.length : 0
  const comparedWith = against === '' ? 'the version in force' : (other?.name ?? 'the chosen version')
  // `before` metrics come from the compared version, `after` ones from this one.
  const fromContent = (other ?? versionInForce(versions))?.content

  return (
    <section aria-labelledby={`${selectId}-h`} className="space-y-3">
      <h2 id={`${selectId}-h`} className="text-lg font-semibold">
        Changes
      </h2>
      <div>
        <label htmlFor={selectId} className="block text-sm font-medium">
          Compare against
        </label>
        <select
          id={selectId}
          className={`${inputClass} max-w-md`}
          value={against}
          onChange={(e) => setAgainst(e.target.value)}
        >
          <option value="">The version in force</option>
          {versions
            .filter((v) => v.id !== version.id)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({statusLabel(v.status).toLowerCase()}, {effectiveLabel(v.effectiveFrom, fiscalYearStartMonth).toLowerCase()})
              </option>
            ))}
        </select>
      </div>
      <div aria-live="polite">
        <QueryState isPending={diff.isPending} error={diff.error} what="changes" />
        {grouped && total === 0 && <p className="text-sm">No differences from {comparedWith}.</p>}
        {grouped && total > 0 && (
          <p className="text-sm">
            {total} {total === 1 ? 'metric differs' : 'metrics differ'} from {comparedWith}.
          </p>
        )}
      </div>
      {grouped && grouped.added.length > 0 && (
        <section aria-label="Added metrics">
          <h3 className="font-semibold">Added ({grouped.added.length})</h3>
          <ul className="mt-1 space-y-2">
            {grouped.added.map((a) => (
              <li key={a.key} className="rounded-md border border-ink/20 p-2 text-sm">
                <span className="font-medium">{metricName(a.key, version.content)}</span>
                <Value value={a.metric} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {grouped && grouped.removed.length > 0 && (
        <section aria-label="Removed metrics">
          <h3 className="font-semibold">Removed ({grouped.removed.length})</h3>
          <ul className="mt-1 space-y-2">
            {grouped.removed.map((r) => (
              <li key={r.key} className="rounded-md border border-ink/20 p-2 text-sm">
                <span className="font-medium">{metricName(r.key, fromContent)}</span>
                <Value value={r.metric} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {grouped && grouped.changed.length > 0 && (
        <section aria-label="Changed metrics" className="space-y-3">
          <h3 className="font-semibold">Changed ({grouped.changed.length})</h3>
          {grouped.changed.map((c) => (
            <div key={c.key}>
              <table className="w-full text-left text-sm">
                <caption className="pb-1 text-left font-medium">{metricName(c.key, version.content, fromContent)}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-1/5 pr-2 font-medium">
                      Field
                    </th>
                    <th scope="col" className="w-2/5 pr-2 font-medium">
                      Before
                    </th>
                    <th scope="col" className="w-2/5 font-medium">
                      After
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.fields.map((f) => (
                    <tr key={f.field} className="border-t border-ink/10 align-top">
                      <th scope="row" className="py-1 pr-2 font-medium">
                        {f.field}
                      </th>
                      <td className="py-1 pr-2">
                        <Value value={f.before} />
                      </td>
                      <td className="py-1">
                        <Value value={f.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}
    </section>
  )
}
