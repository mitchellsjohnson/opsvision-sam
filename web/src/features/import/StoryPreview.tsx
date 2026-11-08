import clsx from 'clsx'
import { ChevronRight, ExternalLink, Info } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import type { RecordType, RecordsPreview } from '../../api/queries'
import { parsePeriod, periodLabel } from '../../lib/period'
import { StatusBadge } from '../../ui/StatusBadge'
import { TextField } from '../admin/formUi'
import { NeedsInput, type DateQuestion, type SubjectOption } from './NeedsInput'
import {
  columnNotice,
  formatCount,
  problemText,
  reasonLabel,
  reasonSummary,
  sameCell,
  visibleProblems,
  type AnswerState,
  type Questions,
  type RecordCellRef,
  type RecordContribution,
} from './recordsModel'

type StoryLine = RecordsPreview['story']['lines'][number]
type Typed = RecordsPreview['story']['typed'][number]

/** A titled part of one file's preview. Not a landmark: every file has the same parts. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="font-semibold">{title}</h4>
      {children}
    </div>
  )
}

function RecordLink({ c, reason }: { c: RecordContribution; reason?: string }) {
  return (
    <li className="text-sm">
      {c.url ? (
        <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent-deep underline">
          {c.externalId}
          <ExternalLink aria-hidden="true" className="size-3" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="font-medium">{c.externalId}</span>
      )}{' '}
      {c.title}
      {reason && <span className="text-ink/80"> — {reason}</span>}
    </li>
  )
}

/** A button that shows and hides the content under it. */
function Disclosure({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-cream"
      >
        <ChevronRight
          aria-hidden="true"
          className={clsx('mt-0.5 size-4 shrink-0 motion-safe:transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0">{summary}</span>
      </button>
      <div id={id} hidden={!open} className="pl-7">
        {open && children}
      </div>
    </div>
  )
}

function Change({ before, after }: { before: string; after: string }) {
  return (
    <span className="whitespace-nowrap">
      {before} <span aria-hidden="true">→</span>
      <span className="sr-only">to</span> {after}
    </span>
  )
}

function StoryLineItem({ line, typeName, fy }: { line: StoryLine; typeName: string; fy: number }) {
  const p = parsePeriod(line.period)
  const summary = reasonSummary(line.reasons, typeName)
  return (
    <li className="border-b border-ink/10 py-1 last:border-0">
      <Disclosure
        summary={
          <>
            <span className="font-medium">
              {p ? periodLabel(p, fy) : line.period} · {line.subjectName} · {line.metricName}
            </span>{' '}
            <Change before={line.beforeDisplay} after={line.afterDisplay} />{' '}
            {line.beforeStatus !== line.afterStatus && line.beforeStatus !== '' && (
              <>
                <StatusBadge status={line.beforeStatus} /> <span aria-hidden="true">→</span>
                <span className="sr-only">to</span>{' '}
              </>
            )}
            <StatusBadge status={line.afterStatus || null} />
            {summary && <span className="block text-sm text-ink/80">{summary}</span>}
          </>
        }
      >
        <ul className="space-y-1 py-1">
          {Object.entries(line.reasons).flatMap(([reason, list]) =>
            list.map((c) => (
              <RecordLink key={`${reason}-${c.source}-${c.externalId}`} c={c} reason={reasonLabel(reason, c.priority)} />
            )),
          )}
        </ul>
      </Disclosure>
    </li>
  )
}

function TypedItem({
  t,
  subject,
  measure,
  period,
  checked,
  onToggle,
}: {
  t: Typed
  subject: string
  measure: string
  period: string
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  const id = useId()
  return (
    <li className="space-y-1 rounded-md border border-ink/20 bg-white p-3">
      <p id={id}>
        You typed {formatCount(t.typed)} for {subject} in {period} ({measure}); records give {formatCount(t.records)}.
      </p>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={checked} aria-describedby={id} onChange={(e) => onToggle(e.target.checked)} />
        Use records for this month
        <span className="sr-only">
          ({subject}, {measure}, {period})
        </span>
      </label>
      <p className="text-sm text-ink/80">Applying clears your typed number, so the scorecard uses the records.</p>
      {t.contributions.length > 0 && (
        <Disclosure summary={<span className="text-sm">The records behind {formatCount(t.records)}</span>}>
          <ul className="space-y-1 py-1">
            {t.contributions.map((c) => (
              <RecordLink key={`${c.source}-${c.externalId}`} c={c} reason={reasonLabel(c.reason)} />
            ))}
          </ul>
        </Disclosure>
      )}
    </li>
  )
}

export interface StoryPreviewProps {
  preview: RecordsPreview
  recognition: ReactNode
  asOf: string
  onAsOfChange: (asOf: string) => void
  questions: Questions
  answers: AnswerState
  setAnswers: (update: (prev: AnswerState) => AnswerState) => void
  recordType: RecordType | undefined
  fullExport: boolean
  fiscalYearStartMonth: number
  names: ReadonlyMap<string, string>
  subjectOptions: readonly SubjectOption[]
  measureNames: ReadonlyMap<string, string>
  date: DateQuestion | null
}

/**
 * What one file changes, in the order a program manager reads it: the as-of
 * date, what the file is, what changes on the scorecard and why, typed
 * numbers that differ from records, questions, unreadable rows, then counts.
 */
export function StoryPreview({
  preview,
  recognition,
  asOf,
  onAsOfChange,
  questions,
  answers,
  setAnswers,
  recordType,
  fullExport,
  fiscalYearStartMonth: fy,
  names,
  subjectOptions,
  measureNames,
  date,
}: StoryPreviewProps) {
  const { story, counts } = preview
  const typeName = recordType?.name ?? 'record'
  const notice = columnNotice(preview.columnsAdded, preview.columnsMissing)
  const problems = visibleProblems(preview.problems)
  const asks = questions.subjects.length + questions.values.length > 0 || date !== null || preview.missing.length > 0
  const label = (period: string) => {
    const p = parsePeriod(period)
    return p ? periodLabel(p, fy) : period
  }
  const countItems: [string, number][] = [
    ['New', counts.new],
    ['Changed', counts.changed],
    ['Unchanged', counts.unchanged],
    ['Skipped', counts.skipped],
  ]
  if (fullExport) countItems.push(['Missing', counts.missing])
  if (counts.unmatched > 0) countItems.push(['Waiting for an answer', counts.unmatched])
  if (counts.errors > 0) countItems.push(['Couldn’t read', counts.errors])

  function toggleUse(cell: RecordCellRef, on: boolean) {
    setAnswers((a) => ({
      ...a,
      useRecords: on ? [...a.useRecords.filter((c) => !sameCell(c, cell)), cell] : a.useRecords.filter((c) => !sameCell(c, cell)),
    }))
  }

  return (
    <div className="space-y-5">
      <TextField
        label="As of"
        hint="Records count up to this date. Changing it updates the preview."
        type="date"
        className="max-w-xs"
        value={asOf}
        required
        onChange={(e) => {
          if (e.target.value) onAsOfChange(e.target.value)
        }}
      />
      <div className="space-y-2">
        {recognition}
        {notice && (
          <p className="flex items-start gap-2 rounded-md bg-cream p-2 text-sm">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-deep" />
            <span>{notice}</span>
          </p>
        )}
      </div>

      <Section title="What changes on the scorecard">
        {story.nothingChanged ? (
          <p className="text-sm">Nothing changed since your last upload</p>
        ) : story.lines.length === 0 ? (
          <p className="text-sm">The scorecard numbers stay the same.</p>
        ) : (
          <>
            <ul>
              {story.lines.map((line) => (
                <StoryLineItem key={`${line.period}-${line.metricKey}-${line.subjectId}`} line={line} typeName={typeName} fy={fy} />
              ))}
            </ul>
            {story.more > 0 && <p className="text-sm text-ink/80">And {formatCount(story.more)} more changes.</p>}
          </>
        )}
        {story.lockedWaiting.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Waiting for locked months</p>
            <ul className="list-disc pl-5 text-sm">
              {story.lockedWaiting.map((line) => (
                <li key={`${line.period}-${line.metricKey}-${line.subjectId}`}>
                  {label(line.period)} · {line.subjectName} · {line.metricName}{' '}
                  <Change before={line.beforeDisplay} after={line.afterDisplay} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {story.typed.length > 0 && (
        <Section title="Your typed numbers vs records">
          <ul className="space-y-2">
            {story.typed.map((t) => {
              const cell = { measureKey: t.measureKey, subjectId: t.subjectId, period: t.period }
              return (
                <TypedItem
                  key={`${t.measureKey}-${t.subjectId}-${t.period}`}
                  t={t}
                  subject={names.get(t.subjectId) ?? t.subjectId}
                  measure={measureNames.get(t.measureKey) ?? t.measureKey}
                  period={label(t.period)}
                  checked={answers.useRecords.some((c) => sameCell(c, cell))}
                  onToggle={(on) => toggleUse(cell, on)}
                />
              )
            })}
          </ul>
        </Section>
      )}

      {asks && (
        <Section title="Needs your input">
          <NeedsInput
            questions={questions}
            answers={answers}
            setAnswers={setAnswers}
            subjectOptions={subjectOptions}
            names={names}
            recordType={recordType}
            date={date}
            missing={preview.missing}
            fullExport={fullExport}
          />
        </Section>
      )}

      {problems.length > 0 && (
        <Section title="Rows we couldn’t read">
          <p className="text-sm text-ink/80">These rows are left out. Everything else can still be applied.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Rows we couldn’t read</caption>
              <thead>
                <tr className="border-b border-ink/20">
                  <th scope="col" className="py-2 pr-4 font-semibold">Row</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Column</th>
                  <th scope="col" className="py-2 font-semibold">Problem</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((p, i) => (
                  <tr key={`${i}-${p.row}-${p.column}`} className="border-b border-ink/10 align-top">
                    <td className="py-2 pr-4">{p.row === 0 ? 'All rows' : p.row}</td>
                    <td className="py-2 pr-4">{p.column}</td>
                    <td className="py-2">{problemText(p, recordType?.attributes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="Row counts">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {countItems.map(([name, n]) => (
            <div key={name} className="rounded-md border border-ink/20 bg-white p-2">
              <dt className="text-sm">{name}</dt>
              <dd className="text-xl font-semibold">{formatCount(n)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  )
}
