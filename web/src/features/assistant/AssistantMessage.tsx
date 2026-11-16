import { AlertCircle, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import type { AssistantMessage } from '../../api/queries'
import { Sam } from '../../ui/Sam'
import { UsageLine } from './usage'

function Heading({ children }: { children?: ReactNode }) {
  // Answers sit inside the drawer's own heading outline, so their headings are bold text.
  return <p className="mb-1 mt-3 font-semibold first:mt-0">{children}</p>
}

const COMPONENTS: Components = {
  // An unsafe URL arrives as an empty href; the link text stays, without the link.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-deep underline">
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ) : (
      <>{children}</>
    ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-ink/[0.06] px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-ink/[0.06] p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-ink/20 pl-3 text-ink/80">{children}</blockquote>,
  hr: () => <hr className="my-3 border-ink/15" />,
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
}

/**
 * SAM's Markdown, rendered safely: raw HTML is dropped, images are not
 * loaded (a model-written image URL could carry data to another host), and
 * links open in a new tab without access to this one.
 */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <Markdown skipHtml disallowedElements={['img']} unwrapDisallowed components={COMPONENTS}>
      {text}
    </Markdown>
  )
}

/** One message in a chat: the person's question, or SAM's answer, pending reply or error. */
export function AssistantMessageItem({ message, onRetry }: { message: AssistantMessage; onRetry?: () => void }) {
  if (message.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-white">
          <span className="sr-only">You: </span>
          {message.text}
        </div>
      </li>
    )
  }

  if (message.status === 'pending') {
    return (
      <li className="flex items-start gap-2" aria-busy="true">
        <Sam pose="thinking" className="ov-sam-think mt-0.5 size-8 shrink-0" />
        <div className="rounded-2xl rounded-tl-md border border-ink/10 bg-white px-3.5 py-2.5 text-sm text-ink/80 shadow-sm">
          <span>SAM is looking into it</span>
          <span aria-hidden="true" className="ml-1 inline-flex gap-0.5 align-middle">
            <span className="size-1 rounded-full bg-ink/50 motion-safe:animate-pulse" />
            <span className="size-1 rounded-full bg-ink/50 motion-safe:animate-pulse [animation-delay:150ms]" />
            <span className="size-1 rounded-full bg-ink/50 motion-safe:animate-pulse [animation-delay:300ms]" />
          </span>
        </div>
      </li>
    )
  }

  if (message.status === 'error') {
    return (
      <li className="flex items-start gap-2">
        <Sam pose="concerned" className="mt-0.5 size-8 shrink-0" />
        <div className="min-w-0 max-w-[90%]">
          <div className="flex items-start gap-2 rounded-2xl rounded-tl-md border border-status-r/30 bg-status-r-bg px-3.5 py-2.5 text-sm text-ink">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-r" />
            <div>
              <p>
                <span className="sr-only">SAM couldn’t answer: </span>
                {message.error || 'SAM couldn’t finish. Try again.'}
              </p>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-2 inline-flex items-center gap-1 rounded-md border border-ink/30 bg-white px-2 py-1 text-xs font-medium hover:bg-cream"
                >
                  <RotateCcw aria-hidden="true" className="size-3.5" />
                  Try again
                </button>
              )}
            </div>
          </div>
          {message.usage && <UsageLine usage={message.usage} />}
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-start gap-2">
      <Sam className="mt-0.5 size-8 shrink-0" />
      <div className="min-w-0 max-w-[90%]">
        <div className="break-words rounded-2xl rounded-tl-md border border-ink/10 bg-white px-3.5 py-2.5 text-sm leading-relaxed shadow-sm">
          <span className="sr-only">SAM: </span>
          <AssistantMarkdown text={message.text} />
        </div>
        {message.usage && <UsageLine usage={message.usage} />}
      </div>
    </li>
  )
}

/** A short plain-text version of an answer for the live region. */
export function spokenText(message: AssistantMessage): string {
  if (message.status === 'error') return `SAM couldn’t answer. ${message.error ?? ''}`.trim()
  const plain = message.text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `SAM replied: ${plain.length > 400 ? `${plain.slice(0, 400)}…` : plain}`
}
