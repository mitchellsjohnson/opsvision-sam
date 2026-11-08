import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { ExternalLink, X } from 'lucide-react'
import { useCallback, useId, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ApiError } from '../../api/errors'
import {
  useClearOverride,
  useContributions,
  useHistory,
  useMe,
  usePutOverride,
  useVersions,
  type PutOverrideRequest,
  type RecordContributions,
} from '../../api/queries'
import type { components } from '../../api/schema'
import { parsePeriod } from '../../lib/period'
import { StatusBadge } from '../../ui/StatusBadge'
import { fieldLabel, formatCount, reasonLabel } from '../import/recordsModel'
import { changeText, formatDateTime, formatMetricValue, overrideSentence, periodEndDate, shortDate } from './format'
import { derivedMeasureKeys, plainNumber, ratioParts } from './viewHelpers'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type Version = Schemas['MethodologyVersion']
type ContributionMeasure = Schemas['ContributionMeasure']
type RecordContribution = Schemas['RecordContribution']

/** The cell the drawer describes, with the labels the table already computed. */
export interface DrawerTarget {
  row: ViewRow
  cell: Cell
  /** Unambiguous column label, e.g. `Oct 2026` or `Year to date through Oct 2026`. */
  columnLabel: string
  fiscalYearStartMonth: number
}

export interface CellDrawerProps {
  scorecardId: string
  /** The cell to show; null closes the drawer. */
  target: DrawerTarget | null
  onClose: () => void
  /** Where focus goes when the drawer closes: the cell button that opened it. */
  returnFocusTo?: RefObject<HTMLElement | null>
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
    return [error.message, ...details].join(' ')
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-2">
      <dt className="text-sm font-medium text-ink/80">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** A radix dialog styled as a right-hand drawer with one cell's details. */
export function CellDrawer({ scorecardId, target, onClose, returnFocusTo }: CellDrawerProps) {
  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          // Opened from a cell, not a Dialog.Trigger, so Radix has nowhere to return focus to.
          onCloseAutoFocus={(e) => {
            if (returnFocusTo?.current) {
              e.preventDefault()
              returnFocusTo.current.focus()
            }
          }}
          className="fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl"
        >
          {target && <DrawerBody scorecardId={scorecardId} target={target} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DrawerBody({
  scorecardId,
  target,
  onClose,
}: {
  scorecardId: string
  target: DrawerTarget
  onClose: () => void
}) {
  const { row, cell, columnLabel, fiscalYearStartMonth } = target
  const me = useMe()
  const versions = useVersions(scorecardId)
  const scale = me.data?.tenant?.statusScale ?? []
  const isAdmin = me.data?.role === 'admin'
  const version: Version | undefined = versions.data?.versions.find((v) => v.id === cell.versionId)
  const metric = version?.content.metrics.find((m) => m.key === row.metricKey)
  const measureName = (key: string) => version?.content.measures.find((m) => m.key === key)?.name ?? key
  const statusLabel = (key: string) => scale.find((s) => s.key === key)?.label

  const componentKeys = Object.keys(cell.components)
  const ratio = ratioParts(metric?.formula, cell.components)

  const change = changeText({
    period: cell.period,
    ytd: cell.ytd,
    format: row.format,
    change: cell.change,
    changeKind: cell.changeKind,
    compare: metric?.rule.compare,
    fyStart: fiscalYearStartMonth,
  })
  const value = (n: number) => formatMetricValue(row.format, n)

  const derived = derivedMeasureKeys(metric?.formula, version?.content.measures ?? [])
  const wantsRecords = !cell.ytd && derived.length > 0
  const contributions = useContributions(scorecardId, row.metricKey, row.subjectId, cell.period, wantsRecords)
  const recordMeasures = mergeMeasures(contributions.data?.pages).filter((m) => derived.includes(m.measureKey))
  const end = periodEndDate(cell.period, fiscalYearStartMonth)
  const endYear = end === null ? undefined : Number(end.slice(0, 4))
  const facts = recordFacts(recordMeasures, cell.period, end)
  const typed = typedNotes(recordMeasures, ratio, componentKeys.length, measureName)

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold text-accent-deep">
          {row.metricName} · {row.subjectName} · {columnLabel}
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          className="rounded-md p-1 text-ink hover:bg-cream"
        >
          <X aria-hidden="true" size={20} />
        </Dialog.Close>
      </div>
      <Dialog.Description className="mt-1 text-sm text-ink/80">
        How this result was calculated, where the data came from, and any override.
      </Dialog.Description>

      <dl className="mt-4 divide-y divide-ink/10 border-y border-ink/10">
        <Item label="Result">
          {cell.naReason ? (
            <span className="text-ink/80">Not applicable: {cell.naReason}</span>
          ) : cell.display ? (
            <span className="inline-flex items-center gap-2">
              {cell.display}
              {cell.status && <StatusBadge status={cell.status} label={statusLabel(cell.status)} />}
            </span>
          ) : (
            <span className="text-ink/80">No data</span>
          )}
          {facts.through && <span className="mt-1 block text-xs text-ink/80">{facts.through}</span>}
          {facts.due && <span className="mt-1 block text-xs text-ink/80">{facts.due}</span>}
        </Item>
        <Item label="Components">
          {componentKeys.length === 0 ? (
            <span className="text-ink/80">None</span>
          ) : ratio ? (
            <>
              <span className="font-medium">
                {plainNumber(cell.components[ratio[0]] as number)} /{' '}
                {plainNumber(cell.components[ratio[1]] as number)}
              </span>
              <span className="block text-xs text-ink/80">
                {measureName(ratio[0])} / {measureName(ratio[1])}
              </span>
            </>
          ) : (
            <ul className="space-y-0.5">
              {componentKeys.map((k) => (
                <li key={k}>
                  <span className="text-ink/80">{measureName(k)}</span>{' '}
                  <span className="font-medium">{plainNumber(cell.components[k] as number)}</span>
                </li>
              ))}
            </ul>
          )}
          {typed.map((note) => (
            <span key={note} className="mt-1 block text-xs font-medium">
              {note}
            </span>
          ))}
        </Item>
        <Item label="Coverage">
          {cell.coverage.length === 2 ? (
            <>
              {cell.coverage[0]} / {cell.coverage[1]}
              <span className="block text-xs text-ink/80">periods with data / periods expected</span>
            </>
          ) : (
            '—'
          )}
        </Item>
        <Item label="Target">{cell.target === null ? 'None' : value(cell.target)}</Item>
        <Item label="Change">{change ?? 'No comparison available'}</Item>
        <Item label="Methodology">
          {cell.versionId === '' ? 'None applied' : (version?.name ?? (versions.isPending ? 'Loading…' : 'Unknown version'))}
        </Item>
      </dl>

      {cell.override && (
        <p className="mt-4 rounded-md bg-status-y-bg p-3 text-sm text-ink">
          <span className="font-medium">{overrideSentence(cell.override)}</span>
          {cell.computed && (
            <span className="mt-1 block text-xs">
              Computed before the override:{' '}
              {cell.computed.value === null ? 'no value' : value(cell.computed.value)}
              {cell.computed.status ? `, status ${cell.computed.status}` : ''}
            </span>
          )}
        </p>
      )}

      {wantsRecords && (contributions.isPending || contributions.isError || recordMeasures.length > 0) && (
        <Records query={contributions} measures={recordMeasures} measureName={measureName} year={endYear} />
      )}

      <History scorecardId={scorecardId} target={target} measureName={measureName} />

      {isAdmin &&
        (cell.ytd ? (
          <p className="mt-6 text-sm text-ink/80">
            Year-to-date results cannot be overridden; override a single period instead.
          </p>
        ) : (
          <OverrideForm
            key={`${row.metricKey}|${row.subjectId}|${cell.period}`}
            scorecardId={scorecardId}
            target={target}
            scale={scale}
            onDone={onClose}
          />
        ))}
    </>
  )
}

/** A derived measure with every page loaded so far; `complete` once no later page can add to it. */
interface LoadedMeasure extends ContributionMeasure {
  complete: boolean
}

/** Joins the pages of contributions by measure. Pages run through the measures in order. */
function mergeMeasures(pages: readonly RecordContributions[] | undefined): LoadedMeasure[] {
  const byKey = new Map<string, ContributionMeasure>()
  for (const page of pages ?? []) {
    for (const m of page.measures) {
      const seen = byKey.get(m.measureKey)
      byKey.set(m.measureKey, seen ? { ...seen, records: [...seen.records, ...m.records] } : m)
    }
  }
  const more = pages !== undefined && pages.length > 0 && pages[pages.length - 1]?.nextCursor !== undefined
  const list = [...byKey.values()]
  return list.map((m, i) => ({ ...m, complete: !more || list.slice(i + 1).some((n) => n.records.length > 0) }))
}

/** "Through Nov 14" when records stop before the period ends; "2 still due this month" for open commitments. */
function recordFacts(
  measures: readonly LoadedMeasure[],
  period: string,
  end: string | null,
): { through: string | null; due: string | null } {
  const cutoff = measures
    .map((m) => m.cutoff)
    .filter((d): d is string => d !== undefined)
    .sort()[0]
  const year = end === null ? undefined : Number(end.slice(0, 4))
  const through = cutoff !== undefined && end !== null && cutoff < end ? `Through ${shortDate(cutoff, year)}` : null
  // Each commitments measure counts the same due items, so they are not added up.
  const pending = Math.max(0, ...measures.map((m) => m.pending))
  const grain = parsePeriod(period)?.grain ?? 'month'
  return { through, due: pending > 0 ? `${formatCount(pending)} still due this ${grain}` : null }
}

/** "Entered · records give 47 / 66" for each typed value that wins over the value records give. */
function typedNotes(
  measures: readonly LoadedMeasure[],
  ratio: [string, string] | null,
  componentCount: number,
  measureName: (key: string) => string,
): string[] {
  const typed = measures.filter((m) => m.value !== null && m.source !== '' && m.source !== 'records')
  if (typed.length === 0) return []
  const records = (key: string) => measures.find((m) => m.measureKey === key)?.recordsValue ?? null
  if (ratio) {
    const [a, b] = [records(ratio[0]), records(ratio[1])]
    if (a !== null && b !== null) return [`Entered · records give ${plainNumber(a)} / ${plainNumber(b)}`]
  }
  const shown = typed.filter((m) => m.recordsValue !== null)
  if (shown.length === 1 && componentCount <= 1) {
    return [`Entered · records give ${plainNumber(shown[0]?.recordsValue as number)}`]
  }
  return shown.map((m) => `${measureName(m.measureKey)}: entered · records give ${plainNumber(m.recordsValue as number)}`)
}

const STATE_LABEL: Record<RecordContribution['state'], string> = {
  open: 'Open',
  done: 'Done',
  cancelled: 'Cancelled',
}

const DATE_ORDER = ['createdAt', 'committedAt', 'dueAt', 'completedAt', 'measuredAt']

function datesOf(c: RecordContribution): [string, string][] {
  const rank = (k: string) => (DATE_ORDER.includes(k) ? DATE_ORDER.indexOf(k) : DATE_ORDER.length)
  return Object.entries(c.dates).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

function countedAs(c: RecordContribution): string {
  const label = reasonLabel(c.reason)
  const text = label.charAt(0).toUpperCase() + label.slice(1)
  return c.amount === 1 ? text : `${text} · adds ${plainNumber(c.amount)}`
}

function recordCount(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'record' : 'records'}`
}

function RecordsSkeleton() {
  return (
    <div role="status" aria-label="Loading records" className="mt-2">
      <div className="space-y-2 motion-safe:animate-pulse">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-6 rounded bg-ink/10" />
        ))}
      </div>
    </div>
  )
}

function RetryAlert({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-2 rounded-md border border-status-r bg-status-r-bg p-3 text-sm">
      <p className="font-medium text-status-r">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md border border-ink/40 bg-white px-3 py-1 text-sm font-medium"
      >
        Retry
      </button>
    </div>
  )
}

/** The records behind the cell's derived measures, a page at a time. */
function Records({
  query,
  measures,
  measureName,
  year,
}: {
  query: ReturnType<typeof useContributions>
  measures: LoadedMeasure[]
  measureName: (key: string) => string
  /** The calendar year the period ends in; record dates in other years show their year. */
  year: number | undefined
}) {
  const headingId = useId()
  // After "Load more", focus moves to the first new record so the button can disappear safely.
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), [])
  const loaded = measures.reduce((n, m) => n + m.records.length, 0)

  let body
  if (query.data === undefined) {
    body = query.isError ? (
      <RetryAlert message="Could not load the records." onRetry={() => void query.refetch()} />
    ) : (
      <RecordsSkeleton />
    )
  } else {
    const starts = measures.map((_, i) => measures.slice(0, i).reduce((n, m) => n + m.records.length, 0))
    body = (
      <>
        {measures.map((m, i) => {
          const name = measureName(m.measureKey)
          const first = starts[i] ?? 0
          return (
            <div key={m.measureKey} className="mt-3">
              <h4 className="text-sm font-medium">{name}</h4>
              <p className="text-sm text-ink/80">
                {m.records.length > 0
                  ? `Derived from ${m.complete ? '' : 'at least '}${recordCount(m.records.length)}`
                  : m.complete
                    ? 'No records counted in this period'
                    : 'These records come after the ones shown. Choose Load more records to see them.'}
              </p>
              {m.records.length > 0 && (
                <RecordTable
                  name={name}
                  records={m.records}
                  firstIndex={first}
                  focusIndex={focusIndex}
                  focusRef={focusOnMount}
                  year={year}
                />
              )}
            </div>
          )
        })}
        {query.isFetchNextPageError && (
          <p role="alert" className="mt-3 text-sm font-medium text-status-r">
            Could not load more records. Choose Load more records to try again.
          </p>
        )}
        {query.hasNextPage && (
          // aria-disabled rather than disabled, so focus stays on the button while the page loads.
          <button
            type="button"
            aria-disabled={query.isFetchingNextPage}
            onClick={() => {
              if (query.isFetchingNextPage) return
              setFocusIndex(loaded)
              void query.fetchNextPage()
            }}
            className="mt-3 rounded-md border border-ink/40 bg-white px-3 py-1.5 text-sm font-medium aria-disabled:opacity-60"
          >
            {query.isFetchingNextPage ? 'Loading more records…' : 'Load more records'}
          </button>
        )}
      </>
    )
  }

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <h3 id={headingId} className="text-base font-semibold">
        Records behind this result
      </h3>
      {body}
    </section>
  )
}

function RecordTable({
  name,
  records,
  firstIndex,
  focusIndex,
  focusRef,
  year,
}: {
  name: string
  records: RecordContribution[]
  /** The position of the first of these records among all listed, for focus after "Load more". */
  firstIndex: number
  focusIndex: number | null
  focusRef: (el: HTMLElement | null) => void
  year: number | undefined
}) {
  const head = 'border-b border-ink/20 px-1.5 py-1 text-left font-semibold'
  const cell = 'border-b border-ink/10 px-1.5 py-1 align-top break-words'
  return (
    <table className="mt-2 w-full table-fixed border-collapse text-xs">
      <caption className="sr-only">{name}: records</caption>
      <colgroup>
        <col className="w-[32%]" />
        <col className="w-[13%]" />
        <col className="w-[15%]" />
        <col className="w-[20%]" />
        <col className="w-[20%]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={head}>
            Record
          </th>
          <th scope="col" className={head}>
            Priority
          </th>
          <th scope="col" className={head}>
            State
          </th>
          <th scope="col" className={head}>
            Dates
          </th>
          <th scope="col" className={head}>
            Counted as
          </th>
        </tr>
      </thead>
      <tbody>
        {records.map((c, i) => {
          const focusTarget = firstIndex + i === focusIndex
          const dates = datesOf(c)
          return (
            <tr key={`${c.source}|${c.externalId}|${c.subjectId ?? ''}|${i}`}>
              <th
                scope="row"
                ref={focusTarget ? focusRef : undefined}
                tabIndex={focusTarget ? -1 : undefined}
                className={clsx(cell, 'font-normal')}
              >
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-accent-deep underline"
                  >
                    {c.externalId}{' '}
                    <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="font-medium">{c.externalId}</span>
                )}
                <span className="block">{c.title}</span>
              </th>
              <td className={cell}>{c.priority === '' || c.priority === 'none' ? 'None' : c.priority}</td>
              <td className={cell}>{STATE_LABEL[c.state] ?? c.state}</td>
              <td className={cell}>
                {dates.length === 0
                  ? 'None'
                  : dates.map(([k, d]) => (
                      <span key={k} className="block">
                        {fieldLabel(k)} {shortDate(d, year)}
                      </span>
                    ))}
              </td>
              <td className={cell}>{countedAs(c)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function History({
  scorecardId,
  target,
  measureName,
}: {
  scorecardId: string
  target: DrawerTarget
  measureName: (key: string) => string
}) {
  const { cell } = target
  const headingId = useId()
  const keys = Object.keys(cell.components)
  return (
    <section aria-labelledby={headingId} className="mt-6">
      <h3 id={headingId} className="text-base font-semibold">
        Revision history
      </h3>
      {cell.ytd ? (
        <p className="mt-2 text-sm text-ink/80">
          Year-to-date results combine several months. Open a single month to see its revisions.
        </p>
      ) : keys.length === 0 ? (
        <p className="mt-2 text-sm text-ink/80">There are no component values to show history for.</p>
      ) : (
        keys.map((k) => (
          <MeasureHistory
            key={k}
            scorecardId={scorecardId}
            measure={k}
            name={measureName(k)}
            subjectId={cell.subjectId}
            period={cell.period}
          />
        ))
      )}
    </section>
  )
}

function MeasureHistory({
  scorecardId,
  measure,
  name,
  subjectId,
  period,
}: {
  scorecardId: string
  measure: string
  name: string
  subjectId: string
  period: string
}) {
  const history = useHistory(scorecardId, measure, subjectId, period)
  return (
    <div className="mt-3">
      <h4 className="text-sm font-medium">{name}</h4>
      {history.isPending ? (
        <p className="text-sm text-ink/80">Loading…</p>
      ) : history.isError ? (
        <p className="text-sm text-status-r">Could not load history: {history.error.message}</p>
      ) : history.data.history.length === 0 ? (
        <p className="text-sm text-ink/80">No stored revisions for this subject and period. A rolled-up result is computed from its sub-units.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {history.data.history.map((h) => (
            <li key={h.revision}>
              <span className="font-medium">
                {h.value === null ? `Not applicable${h.naReason ? ` (${h.naReason})` : ''}` : plainNumber(h.value)}
              </span>{' '}
              <span className="text-ink/80">
                · {h.enteredBy} · {formatDateTime(h.enteredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const fieldClass = 'mt-1 w-full rounded-md border border-ink/40 bg-white px-2 py-1.5 text-sm'

function OverrideForm({
  scorecardId,
  target,
  scale,
  onDone,
}: {
  scorecardId: string
  target: DrawerTarget
  scale: Schemas['StatusLevel'][]
  onDone: () => void
}) {
  const { row, cell } = target
  const id = useId()
  const put = usePutOverride(scorecardId)
  const clear = useClearOverride(scorecardId)
  const [status, setStatus] = useState(cell.override?.status ?? '')
  const [value, setValue] = useState(
    cell.override?.value === null || cell.override?.value === undefined ? '' : String(cell.override.value),
  )
  const [reason, setReason] = useState(cell.override?.reason ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const apiError = put.error ?? clear.error
  const busy = put.isPending || clear.isPending

  function save(e: FormEvent) {
    e.preventDefault()
    setProblem(null)
    const trimmed = value.trim()
    const number = trimmed === '' ? undefined : Number(trimmed)
    if (number !== undefined && !Number.isFinite(number)) {
      setProblem('Enter the value as a number.')
      return
    }
    if (status === '' && number === undefined) {
      setProblem('Choose a status or enter a value.')
      return
    }
    const body: PutOverrideRequest = {
      metricKey: row.metricKey,
      subjectId: row.subjectId,
      period: cell.period,
    }
    if (status !== '') body.status = status
    if (number !== undefined) body.value = number
    if (reason.trim() !== '') body.reason = reason.trim()
    clear.reset()
    put.mutate(body, { onSuccess: onDone })
  }

  function remove() {
    setProblem(null)
    put.reset()
    clear.mutate(
      { metricKey: row.metricKey, subjectId: row.subjectId, period: cell.period },
      { onSuccess: onDone },
    )
  }

  const error = problem ?? (apiError ? errorText(apiError) : null)

  return (
    <form onSubmit={save} aria-labelledby={`${id}-heading`} className="mt-6 border-t border-ink/10 pt-4">
      <h3 id={`${id}-heading`} className="text-base font-semibold">
        Override this result
      </h3>
      <p className="mt-1 text-xs text-ink/80">
        An override replaces the computed status, value, or both. The stored data is not changed.
      </p>
      <div className="mt-3">
        <label htmlFor={`${id}-status`} className="text-sm font-medium">
          Status
        </label>
        <select
          id={`${id}-status`}
          className={fieldClass}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Keep computed status</option>
          {scale.map((s) => (
            <option key={s.key} value={s.key}>
              {s.key} – {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3">
        <label htmlFor={`${id}-value`} className="text-sm font-medium">
          Value (optional)
        </label>
        <input
          id={`${id}-value`}
          type="number"
          step="any"
          inputMode="decimal"
          className={fieldClass}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={`${id}-value-hint`}
        />
        <p id={`${id}-value-hint`} className="mt-1 text-xs text-ink/80">
          In the units shown in the table, for example 94.5 for 94.5%. Leave blank to keep the computed value.
        </p>
      </div>
      <div className="mt-3">
        <label htmlFor={`${id}-reason`} className="text-sm font-medium">
          Reason (optional)
        </label>
        <input
          id={`${id}-reason`}
          type="text"
          className={fieldClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-status-r">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent-deep px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Save override
        </button>
        {cell.override && (
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="rounded-md border border-ink/40 bg-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            Clear override
          </button>
        )}
      </div>
    </form>
  )
}
