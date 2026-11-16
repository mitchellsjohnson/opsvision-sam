import { useId } from 'react'
import { Link } from 'react-router'
import { useFiscalYearStartMonth } from '../../api/queries'
import { parsePeriod, periodLabel } from '../../lib/period'

export interface NotReportedItem {
  key: string
  name: string
  /** `No reports in the last 12 months`, `Last reported Jul 2026 (77%)`, `Not applicable: {reason}`, ... */
  why: string
  category: string
}

/**
 * What is missing for the selected period and why, as one wide card, plus the
 * quiet line for coarse metrics that are up to date. Nothing when neither
 * applies.
 */
export function NotReportedCard({
  period,
  items,
  quiet,
  canEnter,
}: {
  /** The selected period key (`2026-M10`). */
  period: string
  items: NotReportedItem[]
  /** `Reported less often and up to date: …`, or null. */
  quiet: string | null
  canEnter: boolean
}) {
  const headingId = useId()
  const fy = useFiscalYearStartMonth()
  if (items.length === 0 && !quiet) return null
  const parsed = parsePeriod(period)
  const label = parsed ? periodLabel(parsed, fy) : period

  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-lg border border-ink/20 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-accent-deep">
          Not reported for {label}
          {items.length > 0 && (
            <span className="text-xs font-normal text-ink/70">
              {' · '}
              {items.length} {items.length === 1 ? 'metric' : 'metrics'}
            </span>
          )}
        </h2>
        {canEnter && items.length > 0 && (
          <Link
            to={`/entry?period=${period}`}
            className="inline-flex h-8 items-center rounded-md border border-ink/20 bg-white px-3 text-sm font-medium text-accent-deep hover:bg-cream"
          >
            Enter {label} data
          </Link>
        )}
      </div>
      {items.length > 0 && (
        <table className="mt-2 w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink/10 text-left text-xs text-ink/70">
              <th scope="col" className="py-2 pr-3 font-medium">
                Metric
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Why
              </th>
              <th scope="col" className="w-40 py-2 font-medium max-sm:hidden">
                Category
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key} className="border-b border-ink/10 align-top">
                <th scope="row" className="py-2 pr-3 text-left font-medium break-words">
                  {item.name}
                </th>
                <td className="py-2 pr-3 break-words">{item.why}</td>
                <td className="py-2 text-ink/70 break-words max-sm:hidden">{item.category}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {quiet && <p className="mt-2 text-xs text-ink/70">{quiet}</p>}
    </section>
  )
}
