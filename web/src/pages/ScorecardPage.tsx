import * as Tabs from '@radix-ui/react-tabs'
import { useParams, useSearchParams } from 'react-router'
import { useScorecards } from '../api/queries'
import { PlaceholderPage } from './Placeholder'

const TABS = [
  { value: 'table', label: 'Table' },
  { value: 'trends', label: 'Trends' },
  { value: 'definitions', label: 'Definitions' },
]

/** The scorecard page: heading and tab shell; each tab's content is filled in later. */
export function ScorecardPage() {
  const { sc } = useParams()
  const scorecards = useScorecards()
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.value === params.get('tab')) ? (params.get('tab') as string) : 'table'

  if (scorecards.isPending) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const scorecard = scorecards.data.scorecards.find((s) => s.id === sc)
  if (!scorecard) return <PlaceholderPage title="Scorecard not found" />

  return (
    <section>
      <h1 className="text-2xl font-semibold text-accent-deep">{scorecard.name}</h1>
      <Tabs.Root
        className="mt-4"
        value={tab}
        onValueChange={(value) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev)
            next.set('tab', value)
            return next
          })
        }
      >
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
        {TABS.map((t) => (
          <Tabs.Content key={t.value} value={t.value} className="py-4">
            <p className="text-sm text-ink/80">The {t.label.toLowerCase()} view is not built yet.</p>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </section>
  )
}
