import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import clsx from 'clsx'
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
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
import { useElementHeight } from '../../ui/useElementHeight'
import { usePeriodState } from '../../shell/usePeriodState'
import { useAskSam, usePageAssistantContext } from '../assistant/useAssistant'
import { GlobalFilters } from './GlobalFilters'

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

/** Tailwind's `sm`: below it is a phone. Without matchMedia, assume a wider screen. */
const SM_UP = '(min-width: 640px)'

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SM_UP)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !window.matchMedia(SM_UP).matches : false
}

/**
 * Shared bar: global filters, view links, period, view options, and Ask SAM.
 * Sticky from 640px up; on phones one 40px summary row that opens the full
 * controls in a bottom sheet. Publishes its sticky height as `--control-bar-h`
 * on the document root (`0px` on phones, where it scrolls away).
 */
export function ControlBar({ scorecardId }: { scorecardId: string }) {
  const { sc } = useParams()
  const { search } = useLocation()
  const id = useId()
  const versions = useVersions(scorecardId)
  const me = useMe()
  const orgUnits = useOrgUnits()
  const [view, update] = usePeriodState()
  const sam = useAskSam()
  const samContext = usePageAssistantContext()
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [ref, height] = useElementHeight<HTMLElement>()

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--control-bar-h', phone ? '0px' : `${Math.ceil(height)}px`)
    return () => {
      root.style.removeProperty('--control-bar-h')
    }
  }, [phone, height])

  const parsed = parsePeriod(view.period)
  const start = view.fiscalYearStartMonth

  const periodSummary = useMemo(() => {
    if (!parsed) return view.period
    const grain = GRAINS.find((g) => g.value === parsed.grain)?.label ?? 'Month'
    return `${periodLabel(parsed, start)} · ${grain}`
  }, [parsed, start, view.period])

  const restated = versions.data?.versions.find((v) => v.id === view.restate)

  if (!parsed) return null

  const thisFy = parsed.fy
  const years: number[] = []
  for (let y = thisFy + 1; y >= thisFy - 8; y--) years.push(y)
  if (!years.includes(parsed.fy)) years.push(parsed.fy)
  years.sort((a, b) => b - a)

  const unitGrain = parsed.grain === 'year' ? null : parsed.grain

  const controls = (
    <div
      role="toolbar"
      aria-label="Scorecard controls"
      className="flex flex-wrap items-center gap-2"
    >
      <GlobalFilters />

      <nav aria-label="Scorecard views" className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <NavLink
            key={v.segment}
            to={{ pathname: `/scorecards/${sc}/${v.segment}`, search }}
            className={viewLinkClass}
            onClick={() => setSheetOpen(false)}
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
        aria-label="Ask SAM"
        aria-haspopup="dialog"
        aria-expanded={sam.isOpen}
        onClick={() => {
          setSheetOpen(false)
          sam.open(samContext)
        }}
        className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-cream p-0.5 hover:ring-2 hover:ring-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-deep"
      >
        <Sam className="size-8" />
      </button>
    </div>
  )

  const scopeName = view.scope
    ? (orgUnits.data?.units.find((u) => u.id === view.scope)?.name ?? 'Selected unit')
    : `All of ${me.data?.tenant?.name ?? 'Company'}`
  // What the sheet sets away from its defaults.
  const active = [view.scope !== '', view.ytd, view.restate !== '', view.structure === 'current'].filter(Boolean).length
  const summary = `${periodLabel(parsed, start)} · ${scopeName} · Filters${active > 0 ? `, ${active} active` : ''}`

  return (
  <section
    ref={ref}
    aria-label="Scorecard controls"
    className={clsx('z-10 border-b border-ink/15 bg-white px-4 py-2', !phone && 'sticky top-0')}
  >
    {phone ? (
      <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
        <Dialog.Trigger
          aria-label={summary}
          className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-ink/30 bg-white px-3 text-left text-sm hover:bg-cream"
        >
          <span className="min-w-0 flex-1 truncate">{`${periodLabel(parsed, start)} · ${scopeName}`}</span>
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-accent-deep">
            {active > 0 ? `Filters · ${active}` : 'Filters'}
            <SlidersHorizontal aria-hidden="true" size={16} />
          </span>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-xl bg-white p-4 shadow-lg"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-base font-semibold text-accent-deep">Scorecard controls</Dialog.Title>
              <Dialog.Close className="inline-flex h-8 items-center rounded-md border border-ink/20 bg-white px-3 text-sm font-medium hover:bg-cream">
                Done
              </Dialog.Close>
            </div>
            {controls}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ) : (
      controls
    )}

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
