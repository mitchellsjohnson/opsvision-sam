import { useSearchParams } from 'react-router'
import { useScorecards } from '../../api/queries'
import { endMonth, parsePeriod, periodLabel } from '../../lib/period'
import { usePeriodState } from '../../shell/usePeriodState'
import { EntryGrid } from './EntryGrid'

/** The URL parameter that remembers which scorecard is being entered. */
const SCORECARD_PARAM = 'scorecard'

/**
 * Data entry for one scorecard and one month. The month comes from the
 * shell's period picker (month-only here); a quarter or year in the URL
 * resolves to its last month. The scorecard defaults to the first one.
 */
export function EntryPage() {
  const [{ period, fiscalYearStartMonth, ready }] = usePeriodState()
  const scorecards = useScorecards()
  const [params, setParams] = useSearchParams()

  let body
  if (!ready || scorecards.isPending) {
    body = <p role="status">Loading…</p>
  } else if (scorecards.isError) {
    body = <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  } else if (scorecards.data.scorecards.length === 0) {
    body = <p className="text-sm text-ink/80">There are no scorecards to enter data for yet.</p>
  } else {
    const list = scorecards.data.scorecards
    const chosen = list.find((s) => s.id === params.get(SCORECARD_PARAM)) ?? list[0]
    const month = endMonth(period)
    const parsed = parsePeriod(month)
    if (chosen && parsed) {
      const label = periodLabel(parsed, fiscalYearStartMonth)
      body = (
        <>
          <div className="mt-4 flex flex-col text-xs font-medium">
            <label htmlFor="entry-scorecard">Scorecard</label>
            <select
              id="entry-scorecard"
              value={chosen.id}
              onChange={(e) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev)
                  next.set(SCORECARD_PARAM, e.target.value)
                  return next
                })
              }
              className="w-64 rounded-md border border-ink/30 bg-white px-2 py-1 text-sm"
            >
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-sm text-ink/80">
            Entering <strong className="font-semibold text-ink">{label}</strong>. Type a value, paste from a
            spreadsheet, or use the arrow keys and Enter to move between rows.
          </p>
          <div className="mt-2">
            <EntryGrid
              key={`${chosen.id}|${month}`}
              scorecardId={chosen.id}
              scorecardName={chosen.name}
              period={month}
              periodLabel={label}
            />
          </div>
        </>
      )
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold text-accent-deep">Enter data</h1>
      {body}
    </section>
  )
}
