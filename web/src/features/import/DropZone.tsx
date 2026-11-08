import clsx from 'clsx'
import { FileUp, XCircle } from 'lucide-react'
import { useId, useRef, useState, type DragEvent, type RefObject } from 'react'
import { secondaryButton } from '../admin/formUi'
import { partitionFiles } from './recordsModel'

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * A drop target for .csv and .xlsx files with a "Choose files" button for
 * people who do not drag (keyboard, screen readers, touch). Other files and
 * files over 20 MB are refused here with a message; the rest go to `onFiles`.
 */
export function DropZone({
  onFiles,
  multiple = true,
  hasFilesAlready = false,
  chooseRef,
}: {
  onFiles: (files: File[]) => void
  multiple?: boolean
  /** Shorter wording once files are in. */
  hasFilesAlready?: boolean
  /** The "Choose files" button, for callers that move focus to it. */
  chooseRef?: RefObject<HTMLButtonElement | null>
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const [rejected, setRejected] = useState<string[]>([])

  function take(list: FileList | null | undefined) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    const { accepted, rejected: refused } = partitionFiles(multiple ? files : files.slice(0, 1))
    setRejected(refused)
    if (accepted.length > 0) onFiles(accepted)
  }

  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label="Drop files to upload"
        aria-describedby={`${id}-hint`}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current += 1
          setOver(true)
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          depth.current = 0
          setOver(false)
          take(e.dataTransfer?.files)
        }}
        className={clsx(
          'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 text-center motion-safe:transition-colors',
          hasFilesAlready ? 'py-5' : 'py-10',
          over ? 'border-accent bg-white' : 'border-ink/40 bg-white/60',
        )}
      >
        <FileUp aria-hidden="true" className={clsx('size-8', over ? 'text-accent' : 'text-accent-deep')} />
        <p className="font-semibold">
          {over ? 'Let go to upload' : hasFilesAlready ? 'Drop more exports here' : 'Drop your tracker exports here'}
        </p>
        <p id={`${id}-hint`} className="text-sm text-ink/80">
          .csv or .xlsx, up to 20 MB each.{multiple ? ' Drop several at once, for example defects and epics.' : ''}
        </p>
        <button ref={chooseRef} type="button" className={secondaryButton} onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple={multiple}
          accept=".csv,.xlsx"
          onChange={(e) => {
            take(e.target.files)
            // The same file can be chosen again after it is removed.
            e.target.value = ''
          }}
        />
      </div>
      {rejected.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-status-r bg-status-r-bg p-3 text-sm font-medium text-status-r">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <ul>
            {rejected.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
