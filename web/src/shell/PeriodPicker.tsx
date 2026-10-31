import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useId } from 'react'
import {
  GRAINS,
  convertGrain,
  endMonth,
  fiscalMonthName,
  formatPeriod,
  monthOf,
  parsePeriod,
  periodLabel,
  shiftYear,
  type Grain,
} from '../lib/period'
import { usePeriodState } from './usePeriodState'

const fieldClass = 'rounded-md border border-ink/30 bg-white px-2 py-1 text-sm'
const buttonClass = 'rounded-md border border-ink/30 bg-white p-1 hover:bg-cream disabled:opacity-50'

function unitOptions(grain: Exclude<Grain, 'year'>, start: number) {
  const span = { month: 1, quarter: 3, half: 6 }[grain]
  const count = 12 / span
  return Array.from({ length: count }, (_, i) => {
    const first = fiscalMonthName(i * span + 1, start)
    const last = fiscalMonthName(i * span + span, start)
    const name =
      grain === 'month' ? first : `${grain === 'quarter' ? 'Q' : 'H'}${i + 1} (${first}–${last})`
    return { value: i + 1, name }
  })
}

const UNIT_LABEL = { month: 'Month', quarter: 'Quarter', half: 'Half' }

/**
 * Month / quarter / half / year selection plus a year-to-date toggle. With
 * `monthOnly` (data entry) it offers just the fiscal year and month. State
 * lives in the URL. Periods are fiscal, so months are listed from the
 * tenant's fiscal year start and years are fiscal years (FY2027 = the year
 * ending in 2027).
 */
export function PeriodPicker({ monthOnly = false }: { monthOnly?: boolean } = {}) {
  const [{ period: urlPeriod, ytd, fiscalYearStartMonth: start }, update] = usePeriodState()
  const id = useId()
  // Month-only (data entry): a quarter, half or year in the URL stands for its last month.
  const period = monthOnly ? endMonth(urlPeriod) : urlPeriod
  const parsed = parsePeriod(period)
  if (!parsed) return null

  const thisFy = monthOf(new Date(), start).fy
  const years: number[] = []
  for (let y = thisFy + 1; y >= thisFy - 8; y--) years.push(y)
  if (!years.includes(parsed.fy)) years.push(parsed.fy)
  years.sort((a, b) => b - a)

  const unitGrain = parsed.grain === 'year' ? null : parsed.grain

  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="sr-only">Period</legend>
      {!monthOnly && (
        <div className="flex flex-col text-xs font-medium">
          <label htmlFor={`${id}-grain`}>View by</label>
          <select
            id={`${id}-grain`}
            className={fieldClass}
            value={parsed.grain}
            onChange={(e) => update({ period: convertGrain(period, e.target.value as Grain) })}
          >
            {GRAINS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-end gap-1">
        <button
          type="button"
          className={buttonClass}
          aria-label="Previous fiscal year"
          onClick={() => update({ period: shiftYear(period, -1) })}
        >
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        <div className="flex flex-col text-xs font-medium">
          <label htmlFor={`${id}-year`}>Fiscal year</label>
          <select
            id={`${id}-year`}
            className={fieldClass}
            value={parsed.fy}
            onChange={(e) => update({ period: formatPeriod({ ...parsed, fy: Number(e.target.value) }) })}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                FY{y}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={buttonClass}
          aria-label="Next fiscal year"
          onClick={() => update({ period: shiftYear(period, 1) })}
        >
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>

      {unitGrain && (
        <div className="flex flex-col text-xs font-medium">
          <label htmlFor={`${id}-unit`}>{UNIT_LABEL[unitGrain]}</label>
          <select
            id={`${id}-unit`}
            className={fieldClass}
            value={parsed.index}
            onChange={(e) =>
              update({ period: formatPeriod({ ...parsed, index: Number(e.target.value) }) })
            }
          >
            {unitOptions(unitGrain, start).map((o) => (
              <option key={o.value} value={o.value}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {!monthOnly && (
        <label className="flex items-center gap-2 pb-1 text-sm font-medium">
          <input
            type="checkbox"
            checked={ytd}
            onChange={(e) => update({ ytd: e.target.checked })}
            className="size-4 accent-accent"
          />
          Year to date
        </label>
      )}

      <p className="pb-1 text-sm text-ink/80">
        Showing <strong className="font-semibold text-ink">{periodLabel(parsed, start)}</strong>
      </p>
    </fieldset>
  )
}
