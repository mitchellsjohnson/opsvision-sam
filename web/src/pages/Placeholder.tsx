import type { ReactNode } from 'react'

/** Stand-in for a page that has not been built yet. */
export function PlaceholderPage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-accent-deep">{title}</h1>
      <p className="mt-2 text-sm text-ink/80">{children ?? 'This page is not built yet.'}</p>
    </section>
  )
}
