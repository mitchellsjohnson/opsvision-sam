import * as Tabs from '@radix-ui/react-tabs'
import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useMe, useScorecards } from '../../api/queries'
import { PlaceholderPage } from '../../pages/Placeholder'
import { secondaryButton } from '../admin/formUi'
import { UploadRecordsDialog } from '../import/RecordsImport'
import { ChartsTab } from './ChartsTab'
import { TableTab } from './TableTab'

const TABS = [
  { value: 'charts', label: 'Charts' },
  { value: 'table', label: 'Table' },
] as const

type TabValue = (typeof TABS)[number]['value']

/** localStorage key for the tab a person last used. */
export const TAB_STORAGE_KEY = 'opsvision.scorecardTab'

function asTab(value: string | null): TabValue | null {
  return TABS.find((t) => t.value === value)?.value ?? null
}

function rememberedTab(): TabValue | null {
  try {
    return asTab(localStorage.getItem(TAB_STORAGE_KEY))
  } catch {
    return null
  }
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * The "Upload records" button, and a file dropped anywhere on the page:
 * both open the records import for this scorecard in a dialog.
 */
function UploadRecords({ scorecardId }: { scorecardId: string }) {
  const [open, setOpen] = useState(false)
  const [dropped, setDropped] = useState<{ files: File[]; n: number }>({ files: [], n: 0 })
  const [dragging, setDragging] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (open || !hasFiles(e)) return
      e.preventDefault()
      depth += 1
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Never let the browser open a dropped file in place of the app.
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (open) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      setDropped((d) => ({ files, n: d.n + 1 }))
      setOpen(true)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${secondaryButton} inline-flex items-center gap-2`}
        onClick={() => {
          setDropped((d) => ({ files: [], n: d.n + 1 }))
          setOpen(true)
        }}
      >
        <Upload aria-hidden="true" className="size-4" />
        Upload records
      </button>
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-4 z-30 flex items-center justify-center rounded-xl border-4 border-dashed border-accent bg-white/85"
        >
          <p className="flex items-center gap-2 text-xl font-semibold text-accent-deep">
            <Upload className="size-6" />
            Drop to upload records
          </p>
        </div>
      )}
      <UploadRecordsDialog
        key={dropped.n}
        open={open}
        onOpenChange={setOpen}
        scorecardId={scorecardId}
        initialFiles={dropped.files}
        returnFocusTo={triggerRef}
      />
    </>
  )
}

/**
 * The scorecard page: heading and tabs. The tab is in the URL (`?tab=`) so
 * views are linkable; without it the page opens the tab last used, then Table.
 */
export function ScorecardPage() {
  const { sc } = useParams()
  const scorecards = useScorecards()
  const me = useMe()
  const isAdmin = me.data?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const tab = asTab(params.get('tab')) ?? rememberedTab() ?? 'table'

  if (scorecards.isPending) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const scorecard = scorecards.data.scorecards.find((s) => s.id === sc)
  if (!scorecard) return <PlaceholderPage title="Scorecard not found" />

  function choose(value: string) {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, value)
    } catch {
      // Storage can be unavailable (private mode); the URL still holds the tab.
    }
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', value)
      return next
    })
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-accent-deep">{scorecard.name}</h1>
        {isAdmin && <UploadRecords scorecardId={scorecard.id} />}
      </div>
      <Tabs.Root className="mt-4" value={tab} onValueChange={choose}>
        <Tabs.List aria-label="Scorecard views" className="flex gap-1 border-b border-ink/20">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.value}
              value={t.value}
              className="-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium data-[state=active]:border-accent data-[state=active]:text-accent-deep"
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="charts" className="py-4">
          <ChartsTab scorecardId={scorecard.id} />
        </Tabs.Content>
        <Tabs.Content value="table" className="py-4">
          <TableTab scorecardId={scorecard.id} scorecardName={scorecard.name} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  )
}
