import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router'
import { secondaryButton } from '../admin/formUi'
import { UploadRecordsDialog } from '../import/RecordsImport'

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * The "Upload records" button, and a file dropped anywhere on the page:
 * both open the records import for this scorecard in a dialog.
 */
export function UploadRecords({ scorecardId }: { scorecardId: string }) {
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

/** Legacy `/scorecards/:sc` links: route to overview, table, or report; drop `tab`. */
export function ScorecardRedirect() {
  const { sc } = useParams()
  const [params] = useSearchParams()
  const tab = params.get('tab')
  let segment = 'overview'
  if (tab === 'table') segment = 'table'
  const next = new URLSearchParams(params)
  next.delete('tab')
  const search = next.toString()
  return <Navigate to={`/scorecards/${sc}/${segment}${search ? `?${search}` : ''}`} replace />
}
