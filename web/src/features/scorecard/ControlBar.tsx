import * as Popover from '@radix-ui/react-popover'
import clsx from 'clsx'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { NavLink, useLocation, useParams } from 'react-router'
import { useMe, useOrgUnits, useVersions } from '../../api/queries'
import {
  GRAINS,
  convertGrain,
  fiscalMonthName,
  formatPeriod,
  parsePeriod,
  periodLabel,
  shiftYear,
  type Grain,
} from '../../lib/period'
import { Sam } from '../../ui/Sam'
import { usePeriodState } from '../../shell/usePeriodState'

const fieldClass = 'rounded-md border border-ink/30 bg-white px-2 py-1 text-sm'
const buttonClass = 'rounded-md border border-ink/30 bg-white p-1 hover:bg-cream disabled:opacity-50'
const triggerClass =
  'flex items-center gap-2 rounded-md border border-ink/30 bg-white px-3 py-1.5 text-sm hover:bg-cream'

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

const VIEWS = [
  { segment: 'overview', label: 'Overview' },
  { segment: 'table', label: 'Table' },
  { segment: 'report', label: 'Report' },
] as const

function viewLinkClass({ isActive }: { isActive: boolean }) {
  return clsx(
    'rounded-md px-3 py-1.5 text-sm font-medium',
    isActive ? 'bg-accent text-white' : 'text-ink hover:bg-cream',
  )
}

/** Shared sticky bar: view links, period, scope, view options, and Ask SAM. */
export function ControlBar({ scorecardId, barRef }: { scorecardId: string; barRef?: (el: HTMLElement | null) => void }) {
  const { sc } = useParams()
  const { search } = useLocation()
  const id = useId()
  const me = useMe()
  const orgUnits = useOrgUnits()
  const versions = useVersions(scorecardId)
  const [view, update] = usePeriodState()
  const [scopeFilter, setScopeFilter] = useState('')

  const parsed = parsePeriod(view.period)
  const start = view.fiscalYearStartMonth
  const companyName = me.data?.tenant?.name ?? 'Company'

  const periodSummary = useMemo(() => {
    if (!parsed) return view.period
    const grain = GRAINS.find((g) => g.value === parsed.grain)?.label ?? 'Month'
    return `${periodLabel(parsed, start)} · ${grain}`
  }, [parsed, start, view.period])

  const scopeName = useMemo(() => {
    if (!view.scope) return companyName
    return orgUnits.data?.units.find((u) => u.id === view.scope)?.name ?? 'Selected unit'
  }, [companyName, orgUnits.data?.units, view.scope])

  const restated = versions.data?.versions.find((v) => v.id === view.restate)

  const filteredUnits = useMemo(() => {
    const q = scopeFilter.trim().toLowerCase()
    const units = orgUnits.data?.units ?? []
    if (!q) return units
    return units.filter((u) => u.name.toLowerCase().includes(q))
  }, [orgUnits.data?.units, scopeFilter])

  if (!parsed) return null

  const thisFy = parsed.fy
  const years: number[] = []
  for (let y = thisFy + 1; y >= thisFy - 8; y--) years.push(y)
  if (!years.includes(parsed.fy)) years.push(parsed.fy)
  years.sort((a, b) => b - a)

  const unitGrain = parsed.grain === 'year' ? null : parsed.grain

  return (
  <section ref={barRef} aria-label="Scorecard controls" className="sticky top-0 z-10 border-b border-ink/15 bg-white px-4 py-2">
    <div
      role="toolbar"
      aria-label="Scorecard controls"
      className="flex flex-wrap items-center gap-2"
    >
      <nav aria-label="Scorecard views" className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <NavLink
            key={v.segment}
            to={{ pathname: `/scorecards/${sc}/${v.segment}`, search }}
            className={viewLinkClass}
          >
            {v.label}
          </NavLink>
        ))}
      </nav>

      <Popover.Root>
        <Popover.Trigger className={triggerClass}>
          Period: {periodSummary}
          <ChevronDown aria-hidden="true" size={16} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="z-50 rounded-md border border-ink/20 bg-white p-3 shadow-lg"
          >
            <fieldset className="flex flex-wrap items-end gap-3">
              <legend className="sr-only">Period</legend>
              <div className="flex flex-col text-xs font-medium">
                <label htmlFor={`${id}-grain`}>View by</label>
                <select
                  id={`${id}-grain`}
                  className={fieldClass}
                  value={parsed.grain}
                  onChange={(e) => update({ period: convertGrain(view.period, e.target.value as Grain) })}
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
                  aria-label="Previous fiscal year"
                  onClick={() => update({ period: shiftYear(view.period, -1) })}
                >
                  <ChevronLeft aria-hidden="true" size={16} />
                </button>
                <div className="flex flex-col text-xs font-medium">
                  <label htmlFor={`${id}-year`}>Fiscal year</label>
                  <select
                    id={`${id}-year`}
                    className={fieldClass}
                    value={parsed.fy}
                    onChange={(e) =>
                      update({ period: formatPeriod({ ...parsed, fy: Number(e.target.value) }) })
                    }
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
                  onClick={() => update({ period: shiftYear(view.period, 1) })}
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

              <label className="flex items-center gap-2 pb-1 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={view.ytd}
                  onChange={(e) => update({ ytd: e.target.checked })}
                  className="size-4 accent-accent"
                />
                Year to date
              </label>
            </fieldset>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root>
        <Popover.Trigger className={triggerClass} disabled={!orgUnits.data?.units.length}>
          Scope: {scopeName}
          <ChevronDown aria-hidden="true" size={16} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label="Filter by scope"
            align="start"
            sideOffset={4}
            className="z-50 max-h-80 min-w-56 overflow-auto rounded-md border border-ink/20 bg-white p-3 shadow-lg"
          >
            <label className="block text-xs font-medium">
              Filter
              <input
                type="search"
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value)}
                className={clsx(fieldClass, 'mt-1 w-full')}
              />
            </label>
            <ul className="mt-3 space-y-1">
              <li>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    className="size-4 accent-accent"
                    checked={view.scope === ''}
                    onChange={() => update({ scope: null })}
                  />
                  {companyName}
                </label>
              </li>
              {filteredUnits.map((u) => (
                <li key={u.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${id}-scope`}
                      className="size-4 accent-accent"
                      checked={view.scope === u.id}
                      onChange={() => update({ scope: u.id })}
                    />
                    {u.name}
                  </label>
                </li>
              ))}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root>
        <Popover.Trigger className={triggerClass}>{restated ? `Under ${restated.name}` : 'As reported'}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label="View options"
            align="start"
            sideOffset={4}
            className="z-50 min-w-56 rounded-md border border-ink/20 bg-white p-3 shadow-lg"
          >
            <div className="flex flex-col text-xs font-medium">
              <label htmlFor={`${id}-restate`}>View under methodology…</label>
              <select
                id={`${id}-restate`}
                className={clsx(fieldClass, 'mt-1')}
                value={view.restate}
                onChange={(e) => update({ restate: e.target.value || null })}
              >
                <option value="">As reported</option>
                {(versions.data?.versions ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.status === 'published' ? '' : ` (${v.status.replace('_', ' ')})`}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="mt-3">
              <legend className="mb-1 text-xs font-medium">Structure</legend>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-structure`}
                  className="size-4 accent-accent"
                  checked={view.structure === 'as_of'}
                  onChange={() => update({ structure: null })}
                />
                As of each month
              </label>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-structure`}
                  className="size-4 accent-accent"
                  checked={view.structure === 'current'}
                  onChange={() => update({ structure: 'current' })}
                />
                Today&apos;s structure
              </label>
            </fieldset>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <button
        type="button"
        disabled
        aria-label="Ask SAM (coming soon)"
        className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-cream p-0.5 opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep"
      >
        <Sam className="size-8" />
      </button>
    </div>

    {view.restate !== '' && (
      <p
        role="status"
        className="mt-2 inline-flex rounded-md border border-amber bg-cream px-3 py-1 text-sm"
      >
        {`Restated under ${restated?.name ?? 'the selected methodology version'}`}
      </p>
    )}
  </section>
  )
}
