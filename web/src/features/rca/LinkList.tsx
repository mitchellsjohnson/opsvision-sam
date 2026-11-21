import { ExternalLink } from 'lucide-react'
import type { RcaLink } from '../../api/queries'
import { hostOf, safeHref } from './rcaText'

/**
 * An exec summary's links (spec §10.2): each title opens its https URL in a
 * new tab, with the host beside it (punycode for internationalized hosts).
 * A URL that is not https shows its title as plain text.
 */
export function LinkList({ links }: { links: readonly RcaLink[] }) {
  if (links.length === 0) return null
  return (
    <ul className="mt-1.5 space-y-0.5">
      {links.map((l, i) => {
        const href = safeHref(l.url)
        const host = hostOf(l.url)
        return (
          <li key={`${i}:${l.url}`} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
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
                <span aria-hidden="true" className="text-xs leading-4 text-ink/70">
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
