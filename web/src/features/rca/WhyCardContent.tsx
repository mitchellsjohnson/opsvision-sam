import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import type { CellAttribution } from '../../api/queries'
import type { components } from '../../api/schema'
import { ItemName, StatusChip, type StatusLevel } from '../../ui/status'
import { secondaryButton } from '../admin/formUi'
import { EvidenceList } from './EvidenceList'
import { GapBar } from './GapBar'

type RcaChild = components['schemas']['RcaChild']

const LABEL = 'text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70'
const META = 'text-xs leading-4 text-ink/70'

export interface WhyCardContentProps {
  scorecardId: string
  /** Every loaded page joined (`mergeAttribution`). */
  attribution: CellAttribution
  periodLabel: string
  scale: StatusLevel[]
  /** The phone sheet: incident titles wrap to two lines. */
  sheet: boolean
  isAdmin: boolean
  /** The Exec summary section, or the editor in its place; null where the reader cannot read the company's summary. */
  summarySlot: ReactNode
  /** The editor is open: the footer's actions step aside. */
  editing: boolean
  /** Which list the next attribution page holds, if any. */
  next: 'incidents' | 'records' | null
  loadingMore: boolean
  onLoadMore: () => void
  /** `Edit exec summary` in the footer (admins, a written summary). */
  onEdit: () => void
  onOpenChild: (child: RcaChild) => void
  onNavigate: () => void
}

function Contributors({
  attribution: a,
  scale,
  onOpenChild,
  onNavigate,
}: Pick<WhyCardContentProps, 'attribution' | 'scale' | 'onOpenChild' | 'onNavigate'>) {
  const location = useLocation()
  if (a.children.length === 0) return null
  const more = a.childrenTotal - a.children.length
  const params = new URLSearchParams(location.search)
  params.set('focus', a.metricKey)
  return (
    <section aria-label="Worst contributors" className="mt-3">
      <p className={LABEL}>Worst contributors</p>
      <ul className="mt-1">
        {a.children.map((c) => (
          <li key={c.subjectId} className="border-t border-ink/10 first:border-t-0">
            <button
              type="button"
              className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 py-2 text-left hover:bg-accent/[0.06]"
              onClick={() => onOpenChild(c)}
            >
              <span className="flex items-center gap-2">
                <ItemName name={c.subjectName} className="flex-1 text-sm font-medium leading-5" />
                <span className="shrink-0 text-sm font-semibold leading-5 tabular-nums">{c.display}</span>
                {c.status && <StatusChip status={c.status} scale={scale} />}
              </span>
              <span className="mt-0.5 block truncate text-xs leading-4 text-ink/70">{c.attributionLine || 'Nothing linked'}</span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Link
          to={{ pathname: location.pathname, search: `?${params.toString()}` }}
          className="mt-1 inline-block text-xs font-medium text-accent-deep hover:underline"
          onClick={onNavigate}
        >
          and {more} more <span aria-hidden="true">›</span>
        </Link>
      )}
    </section>
  )
}

/**
 * The Why card below the header (spec §10.2): the metric's exec summary
 * first, then this cell's attribution (gap, override, evidence, worst
 * contributors), then the footer.
 */
export function WhyCardContent(props: WhyCardContentProps) {
  const { scorecardId, attribution: a, periodLabel, sheet, isAdmin, summarySlot, editing, onEdit, onNavigate } = props
  const nothing = a.attribution === 'none' || a.gap.kind === 'none' || a.gap.headline === ''
  const summary = a.summary
  const canEditWritten = !editing && summary?.canEdit === true && (summary.state === 'written' || summary.state === 'stale')
  const derived = !editing && a.recordsTotal > 0
  return (
    <>
      {summarySlot}

      <section aria-label="Attribution" className="mt-3">
        <p className={LABEL}>{`Attribution · ${a.subjectName}`}</p>
        {nothing ? (
          <p className="mt-1 text-sm font-semibold leading-5">
            Nothing to explain: {a.display} in {periodLabel}.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm font-semibold leading-5">{a.gap.headline}</p>
            {a.gap.detail && <p className={META}>{a.gap.detail}</p>}
            <GapBar attribution={a} />
          </>
        )}

        {a.override?.reason && (
          <p className="mt-3 rounded-md bg-ink/[0.035] px-2 py-1.5 text-xs leading-4 text-ink/80">
            Status set{a.override.by ? ` by ${a.override.by}` : ''}: {a.override.reason}
          </p>
        )}

        <EvidenceList
          attribution={a}
          sheet={sheet}
          isAdmin={isAdmin}
          next={props.next}
          loadingMore={props.loadingMore}
          onLoadMore={props.onLoadMore}
        />
        <Contributors {...props} />
      </section>

      {(canEditWritten || derived) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-3">
          {canEditWritten && (
            <button type="button" className={clsx(secondaryButton, 'h-8')} onClick={onEdit}>
              Edit exec summary
            </button>
          )}
          {derived && (
            <Link
              to={`/scorecards/${encodeURIComponent(scorecardId)}/table?period=${encodeURIComponent(a.period)}`}
              className="ml-auto text-xs font-medium text-accent-deep hover:underline"
              onClick={onNavigate}
            >
              Open in table <span aria-hidden="true">›</span>
            </Link>
          )}
        </div>
      )}
    </>
  )
}
