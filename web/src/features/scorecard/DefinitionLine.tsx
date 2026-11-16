import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { components } from '../../api/schema'
import { useElementWidth } from '../../ui/useElementWidth'
import type { NounForms } from './logic/nouns'
import { thresholdText } from './logic/statusText'

type Metric = components['schemas']['Metric']
type StatusRule = components['schemas']['StatusRule']
type ViewRow = components['schemas']['ViewRow']
type Frequency = components['schemas']['Frequency']

/** `Measured {monthly|quarterly|twice a year|yearly}`. */
export const MEASURED: Record<Frequency, string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  biannual: 'twice a year',
  annual: 'yearly',
}

/** A clause the definition may state in its own words (`Judged on change against the prior period`). */
const JUDGED = 'judged on change'

function sentence(s: string): string {
  const t = s.trim()
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`
}

/** The threshold without the clauses the definition already states (`Lower is better`, `Reported quarterly`, how a change is judged). */
function unsaid(threshold: string, definition: string): string {
  const said = definition.toLowerCase()
  const rest = threshold.split(' · ').filter((clause) => {
    const c = clause.toLowerCase()
    return !said.includes(c) && !(c.startsWith(JUDGED) && said.includes(JUDGED))
  })
  const text = rest.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The definition and source under the dialog title (§8.2), read from the
 * metric as defined in the version in force for the selected period:
 * `{definition} {threshold}.` then `Source: … · Measured monthly, by product
 * · Methodology ›`, the link for admins only. Under 640px it is clamped to
 * two lines, with `More` when it runs longer.
 */
export function DefinitionLine({
  metric,
  rule,
  row,
  statusLabel,
  isAdmin,
  noun,
  perSubject,
}: {
  /** The metric in the version in force for the selected column (`Cell.versionId`). */
  metric: Metric | undefined
  rule: StatusRule | undefined
  row: ViewRow
  statusLabel: (key: string) => string | undefined
  isAdmin: boolean
  noun: NounForms
  /** Units or items held to their own best-band value. */
  perSubject?: { name: string; value: number }[]
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const [measure, width] = useElementWidth<HTMLDivElement>()
  const box = useRef<HTMLDivElement | null>(null)
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el
      measure(el)
    },
    [measure],
  )

  const definition = metric?.definition || row.definition || ''
  const items = metric ? metric.reportedAt.some((r) => r.kind === 'item_kind') : row.subjectKind === 'item'
  const threshold = rule
    ? thresholdText(rule, {
        format: metric?.format ?? row.format,
        direction: metric?.direction ?? row.direction,
        chartKind: metric?.chartKind || row.chartKind,
        frequency: metric?.frequency ?? row.frequency,
        statusLabel,
        perSubject,
        noun,
        items,
        surface: 'focus',
      })
    : ''
  const first = [sentence(definition), sentence(unsaid(threshold, definition))].filter(Boolean).join(' ')
  const source = metric?.source ?? ''
  const frequency = metric?.frequency ?? row.frequency
  const parts = [
    ...(source ? [`Source: ${source}`] : []),
    `Measured ${MEASURED[frequency]}${metric ? `, by ${noun.one}` : ''}`,
  ]

  // Whether the clamp hides anything, measured while clamped (the clamp only applies on phones).
  useLayoutEffect(() => {
    const el = box.current
    if (!el || expanded) return
    setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [width, expanded, first, isAdmin, source])

  return (
    <div className="mt-1.5 max-w-[820px] text-xs text-ink/80">
      <div
        id={id}
        data-testid="definition-text"
        ref={setBox}
        className={expanded ? undefined : 'max-sm:line-clamp-2'}
      >
        {first && <p>{first}</p>}
        <p>
          {parts.join(' · ')}
          {isAdmin && (
            <>
              {' · '}
              <Link to="/admin/methodology" className="font-medium text-accent-deep hover:underline">
                Methodology
                <span aria-hidden="true"> ›</span>
              </Link>
            </>
          )}
        </p>
      </div>
      {(clamped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          className="-ml-1 inline-flex h-6 items-center rounded px-1 font-medium text-accent-deep hover:underline focus-visible:outline-2 focus-visible:outline-accent sm:hidden"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}
