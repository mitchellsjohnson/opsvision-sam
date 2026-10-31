import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ApiError } from '../../api/errors'
import {
  useClearOverride,
  useHistory,
  useMe,
  usePutOverride,
  useVersions,
  type PutOverrideRequest,
} from '../../api/queries'
import type { components } from '../../api/schema'
import { StatusBadge } from '../../ui/StatusBadge'
import { changeText, formatDateTime, formatMetricValue, overrideSentence } from './format'

type Schemas = components['schemas']
type Cell = Schemas['Cell']
type ViewRow = Schemas['ViewRow']
type Version = Schemas['MethodologyVersion']

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

/** `a / b`, optionally scaled like `a / b * 100`: a ratio of two measures. */
const RATIO = /^\s*([A-Za-z0-9_.-]+)\s*\/\s*([A-Za-z0-9_.-]+)\s*(?:\*\s*[0-9.]+\s*)?$/

function plain(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
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
  const ratio = metric ? RATIO.exec(metric.formula) : null
  const ratioParts =
    ratio && componentKeys.length === 2 && ratio[1] && ratio[2] ? [ratio[1], ratio[2]] : null
  const isRatio =
    ratioParts !== null && ratioParts.every((k) => Object.hasOwn(cell.components, k))

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
        </Item>
        <Item label="Components">
          {componentKeys.length === 0 ? (
            <span className="text-ink/80">None</span>
          ) : isRatio && ratioParts ? (
            <>
              <span className="font-medium">
                {plain(cell.components[ratioParts[0] as string] as number)} /{' '}
                {plain(cell.components[ratioParts[1] as string] as number)}
              </span>
              <span className="block text-xs text-ink/80">
                {measureName(ratioParts[0] as string)} / {measureName(ratioParts[1] as string)}
              </span>
            </>
          ) : (
            <ul className="space-y-0.5">
              {componentKeys.map((k) => (
                <li key={k}>
                  <span className="text-ink/80">{measureName(k)}</span>{' '}
                  <span className="font-medium">{plain(cell.components[k] as number)}</span>
                </li>
              ))}
            </ul>
          )}
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
                {h.value === null ? `Not applicable${h.naReason ? ` (${h.naReason})` : ''}` : plain(h.value)}
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
