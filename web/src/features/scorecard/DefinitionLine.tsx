import { Link } from 'react-router'
import type { components } from '../../api/schema'
import type { NounForms } from './logic/nouns'
import { thresholdText } from './logic/statusText'

type Metric = components['schemas']['Metric']
type StatusRule = components['schemas']['StatusRule']
type ViewRow = components['schemas']['ViewRow']
type Frequency = components['schemas']['Frequency']

const MEASURED: Record<Frequency, string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  biannual: 'twice a year',
  annual: 'yearly',
}

function sentence(s: string): string {
  const t = s.trim()
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`
}

/**
 * The definition and source under the dialog title (§8.2), read from the
 * metric as defined in the version in force for the selected period:
 * `{definition} {threshold}.` then `Source: … · Measured monthly, by product
 * · Methodology ›`, the link for admins only.
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
  const definition = metric?.definition || row.definition || ''
  const threshold = rule
    ? thresholdText(rule, {
        format: metric?.format ?? row.format,
        direction: metric?.direction ?? row.direction,
        chartKind: metric?.chartKind || row.chartKind,
        frequency: metric?.frequency ?? row.frequency,
        statusLabel,
        perSubject,
        noun,
        surface: 'focus',
      })
    : ''
  const first = [sentence(definition), sentence(threshold)].filter(Boolean).join(' ')
  const source = metric?.source ?? ''
  const frequency = metric?.frequency ?? row.frequency
  const parts = [
    ...(source ? [`Source: ${source}`] : []),
    `Measured ${MEASURED[frequency]}${metric ? `, by ${noun.one}` : ''}`,
  ]
  return (
    <div className="mt-1.5 max-w-[820px] text-xs text-ink/80">
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
  )
}
