import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import type { CellRca } from '../../api/queries'
import type { components } from '../../api/schema'
import { ItemName, StatusChip, type StatusLevel } from '../../ui/status'
import { Sam } from '../../ui/Sam'
import { primaryButton, secondaryButton } from '../admin/formUi'
import { EvidenceList } from './EvidenceList'
import { GapBar } from './GapBar'
import { hostOf, noteDate, safeHref } from './rcaText'

type RcaChild = components['schemas']['RcaChild']
type RcaLink = components['schemas']['RcaLink']

const SMALL_BUTTON = 'h-7 rounded-md px-2.5 text-xs font-medium'
const META = 'text-xs leading-4 text-ink/70'

export interface WhyCardContentProps {
  scorecardId: string
  rca: CellRca
  periodLabel: string
  scale: StatusLevel[]
  /** The phone sheet: incident titles wrap to two lines. */
  sheet: boolean
  isAdmin: boolean
  samEnabled: boolean
  /** Whether a "Still accurate" save is running, and its failure. */
  confirming: boolean
  confirmError: string | null
  onEdit: () => void
  onDraft: () => void
  onConfirm: () => void
  onOpenChild: (child: RcaChild) => void
  onNavigate: () => void
}

function NoteLinks({ links }: { links: RcaLink[] }) {
  if (links.length === 0) return null
  return (
    <ul className="mt-1.5 space-y-0.5">
      {links.map((l) => {
        const href = safeHref(l.url)
        const host = hostOf(l.url)
        return (
          <li key={l.url} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1 break-words text-sm font-medium text-accent-deep hover:underline"
              >
                {l.title}
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />{' '}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="break-words text-sm font-medium">{l.title}</span>
            )}
            {host && (
              <>
                <span aria-hidden="true" className={META}>
                  ·
                </span>
                <span className="text-xs leading-4 text-ink/70">{host}</span>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function DraftButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={clsx(secondaryButton, 'inline-flex items-center gap-1.5', className)} onClick={onClick}>
      <Sam className="size-4" />
      Draft with SAM
    </button>
  )
}

function Contributors({
  rca,
  scale,
  onOpenChild,
  onNavigate,
}: Pick<WhyCardContentProps, 'rca' | 'scale' | 'onOpenChild' | 'onNavigate'>) {
  const location = useLocation()
  if (rca.children.length === 0) return null
  const more = rca.childrenTotal - rca.children.length
  const params = new URLSearchParams(location.search)
  params.set('focus', rca.metricKey)
  return (
    <section aria-label="Worst contributors" className="mt-3">
      <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink/70">Worst contributors</p>
      <ul className="mt-1">
        {rca.children.map((c) => {
          const line = [c.impactDisplay, c.written ? `Why: ${c.excerpt ?? ''}` : 'No RCA yet', c.topIncident ?? '']
            .filter(Boolean)
            .join(' · ')
          return (
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
                <span className="mt-0.5 block truncate text-xs leading-4 text-ink/70">{line}</span>
              </button>
            </li>
          )
        })}
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

/** The Why card's read view below the header (spec §10.2 items 2–7). */
export function WhyCardContent(props: WhyCardContentProps) {
  const { scorecardId, rca, periodLabel, sheet, isAdmin, samEnabled, onEdit, onDraft, onConfirm, onNavigate } = props
  const note = rca.note ?? null
  const nothing = rca.gap.kind === 'none' || rca.gap.headline === ''
  // Only a needed cell gets the empty state; nobody is chased for available or none cells.
  const showEmpty = !note && rca.expectation === 'needed'
  const sam = samEnabled && rca.canEdit
  const derived = rca.records.length > 0
  // A stale note's banner already offers Edit.
  const footerLeft = rca.canEdit && (note !== null ? !rca.stale : !showEmpty)
  return (
    <>
      <section aria-label="Gap" className="mt-3">
        {nothing ? (
          <p className="text-sm font-semibold leading-5">
            Nothing to explain: {rca.display} in {periodLabel}.
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold leading-5">{rca.gap.headline}</p>
            {rca.gap.detail && <p className={META}>{rca.gap.detail}</p>}
            <GapBar rca={rca} />
          </>
        )}
      </section>

      {rca.override?.reason && (
        <p className="mt-3 rounded-md bg-ink/[0.035] px-2 py-1.5 text-xs leading-4 text-ink/80">
          Status set{rca.override.by ? ` by ${rca.override.by}` : ''}: {rca.override.reason}
        </p>
      )}

      {(note || showEmpty) && (
        <section aria-label="RCA" className="mt-3">
          {note && rca.stale && (
            <div className="mb-2 rounded-md border border-status-y bg-status-y-bg px-2 py-1.5 text-xs leading-4 text-ink">
              <p className="font-semibold">This RCA may be out of date.</p>
              {rca.staleReasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
              {rca.canEdit && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button type="button" className={clsx(SMALL_BUTTON, 'border border-ink/40 bg-white hover:bg-cream')} onClick={onEdit}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={clsx(SMALL_BUTTON, 'border border-ink/40 bg-white hover:bg-cream disabled:opacity-60')}
                    disabled={props.confirming}
                    onClick={onConfirm}
                  >
                    Still accurate
                  </button>
                </div>
              )}
              {props.confirmError && (
                <p role="alert" className="mt-1 font-medium text-status-r">
                  {props.confirmError}
                </p>
              )}
            </div>
          )}
          {note ? (
            <>
              <p dir="auto" className="break-words text-sm leading-5">
                {note.text}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-ink/70">
                {note.authorName} · {noteDate(note.updatedAt)}
                {note.channel === 'mcp' && ' · via MCP'}
              </p>
              <NoteLinks links={note.links} />
            </>
          ) : (
            <div className="rounded-md bg-ink/[0.035] p-3">
              <p className="text-sm font-medium leading-5">No RCA yet.</p>
              {rca.canEdit ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={clsx(primaryButton, 'h-8')} onClick={onEdit}>
                    Add RCA
                  </button>
                  {sam && <DraftButton onClick={onDraft} className="h-8" />}
                </div>
              ) : (
                <p className="mt-0.5 text-xs leading-4 text-ink/70">{rca.subjectName} hasn&apos;t written one yet.</p>
              )}
            </div>
          )}
        </section>
      )}

      <EvidenceList rca={rca} sheet={sheet} isAdmin={isAdmin} />
      <Contributors {...props} />

      {(footerLeft || derived) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-3">
          {footerLeft && (
            <button type="button" className={clsx(secondaryButton, 'h-8')} onClick={onEdit}>
              {note ? 'Edit' : 'Add RCA'}
            </button>
          )}
          {footerLeft && sam && <DraftButton onClick={onDraft} className="h-8" />}
          {derived && (
            <Link
              to={`/scorecards/${encodeURIComponent(scorecardId)}/table?period=${encodeURIComponent(rca.period)}`}
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
