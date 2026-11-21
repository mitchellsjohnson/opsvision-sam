import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import type { RcaLink } from '../../api/queries'
import { inputClass, secondaryButton } from '../admin/formUi'
import { parsePastedLinks, RCA_LINKS_MAX, safeHref, type PastedLinks } from './rcaText'

const LIMIT_MESSAGE = {
  count: `Up to ${RCA_LINKS_MAX} links`,
  bytes: 'These links are too long together; shorten or remove some',
} as const

/** `x and y`, `x, y and z`. */
function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** `2 links added (INC-2049, 88412).` (mockup 3). */
function addedSentence(added: RcaLink[]): string {
  const titles = added.map((l) => l.title).join(', ')
  return `${added.length === 1 ? '1 link' : `${added.length} links`} added (${titles}).`
}

/** `2 lines not added: http://x is not an https link; INC-2041 is already listed.` (mockup 3). */
function notAddedSentence(r: PastedLinks): string {
  const parts: string[] = []
  if (r.notHttps.length > 0) parts.push(`${list(r.notHttps)} ${r.notHttps.length === 1 ? 'is not an https link' : 'are not https links'}`)
  if (r.duplicates.length > 0) {
    const titles = r.duplicates.map((d) => d.title)
    parts.push(`${list(titles)} ${titles.length === 1 ? 'is already listed' : 'are already listed'}`)
  }
  const n = r.rejected.length
  return `${n === 1 ? '1 line' : `${n} lines`} not added: ${parts.join('; ')}.`
}

/** The lines of `text` that did not become rows, so they can be fixed in place. */
function linesLeft(text: string, added: RcaLink[]): string {
  const pending = new Set(added.map((l) => l.url))
  const left: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const href = safeHref(line)
    if (href && pending.has(href)) {
      pending.delete(href)
      continue
    }
    left.push(line)
  }
  return left.join('\n')
}

export interface PasteLinksProps {
  /** The links already in the form: repeats are reported, and the 25 and 16 KB limits count them. */
  existing: RcaLink[]
  onAdd: (links: RcaLink[]) => void
  onClose: () => void
}

/**
 * `Paste links` (spec §10.3): several URLs, one per line. Pasting adds each
 * new https URL as a row titled from its last path segment or host; the
 * lines that were not added stay in the box and are listed.
 */
export function PasteLinks({ existing, onAdd, onClose }: PasteLinksProps) {
  const id = useId()
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [result, setResult] = useState<PastedLinks | null>(null)

  useEffect(() => boxRef.current?.focus(), [])

  const apply = (value: string) => {
    const parsed = parsePastedLinks(value, existing)
    if (parsed.added.length > 0) onAdd(parsed.added)
    setResult(parsed)
    setText(linesLeft(value, parsed.added))
  }

  const hintId = `${id}-hint`
  const resultId = `${id}-result`
  const added = result?.added.length ?? 0
  return (
    <div className="mt-2 rounded-md border border-dashed border-ink/40 p-2">
      <label htmlFor={`${id}-box`} className="block text-xs font-semibold leading-4">
        Paste links
      </label>
      <p id={hintId} className="text-xs leading-4 text-ink/70">
        One https link per line.
      </p>
      <textarea
        ref={boxRef}
        id={`${id}-box`}
        rows={4}
        value={text}
        aria-describedby={result ? `${hintId} ${resultId}` : hintId}
        className={clsx(inputClass, 'resize-y text-xs leading-4')}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          e.preventDefault()
          const el = e.currentTarget
          const pasted = e.clipboardData.getData('text')
          apply(el.value.slice(0, el.selectionStart) + pasted + el.value.slice(el.selectionEnd))
        }}
      />
      <div id={resultId} role="status" className="text-xs leading-4">
        {result && (
          <>
            {added > 0 && <p className="mt-1 text-ink/80">{addedSentence(result.added)}</p>}
            {result.rejected.length > 0 && <p className="mt-1 font-medium text-status-r">{notAddedSentence(result)}</p>}
            {result.limit && <p className="mt-1 font-medium text-status-r">{LIMIT_MESSAGE[result.limit]}</p>}
          </>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={clsx(secondaryButton, 'h-7 px-2.5 py-0 text-xs')} disabled={text.trim() === ''} onClick={() => apply(text)}>
          Add links
        </button>
        <button type="button" className="h-7 rounded-md px-2.5 text-xs font-medium text-ink hover:bg-cream" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
