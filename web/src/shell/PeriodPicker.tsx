import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useId } from 'react'
import {
  GRAINS,
  convertGrain,
  formatPeriod,
  parsePeriod,
  shiftYear,
  type Grain,
} from '../lib/period'
import { usePeriodState } from './usePeriodState'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const UNITS: Record<Exclude<Grain, 'year'>, { label: string; options: string[] }> = {
  month: { label: 'Month', options: MONTHS },
  quarter: { label: 'Quarter', options: ['Q1', 'Q2', 'Q3', 'Q4'] },
  half: { label: 'Half', options: ['H1', 'H2'] },
}

const fieldClass = 'rounded-md border border-ink/30 bg-white px-2 py-1 text-sm'
const buttonClass =
  'rounded-md border border-ink/30 bg-white p-1 hover:bg-cream disabled:opacity-50'

/** Month / quarter / half / year selection plus a year-to-date toggle; state lives in the URL. */
export function PeriodPicker() {
  const [{ period, ytd }, update] = usePeriodState()
  const id = useId()
  const parsed = parsePeriod(period)
  if (!parsed) return null

  const thisYear = new Date().getFullYear()
  const years: number[] = []
  for (let y = thisYear + 1; y >= thisYear - 8; y--) years.push(y)
  if (!years.includes(parsed.year)) years.push(parsed.year)
  years.sort((a, b) => b - a)

  const unit = parsed.grain === 'year' ? null : UNITS[parsed.grain]

  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="sr-only">Period</legend>
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

        <div className="flex items-end gap-1">
          <button
            type="button"
            className={buttonClass}
            aria-label="Previous year"
            onClick={() => update({ period: shiftYear(period, -1) })}
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          <div className="flex flex-col text-xs font-medium">
            <label htmlFor={`${id}-year`}>Year</label>
            <select
              id={`${id}-year`}
              className={fieldClass}
              value={parsed.year}
              onChange={(e) => update({ period: formatPeriod({ ...parsed, year: Number(e.target.value) }) })}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={buttonClass}
            aria-label="Next year"
            onClick={() => update({ period: shiftYear(period, 1) })}
          >
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </div>

        {unit && (
          <div className="flex flex-col text-xs font-medium">
            <label htmlFor={`${id}-unit`}>{unit.label}</label>
            <select
              id={`${id}-unit`}
              className={fieldClass}
              value={parsed.n}
              onChange={(e) => update({ period: formatPeriod({ ...parsed, n: Number(e.target.value) }) })}
            >
              {unit.options.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}

        <label className="flex items-center gap-2 pb-1 text-sm font-medium">
          <input
            type="checkbox"
            checked={ytd}
            onChange={(e) => update({ ytd: e.target.checked })}
            className="size-4 accent-accent"
          />
          Year to date
        </label>
    </fieldset>
  )
}
