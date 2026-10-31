import * as Tabs from '@radix-ui/react-tabs'
import { useParams, useSearchParams } from 'react-router'
import { useScorecards } from '../../api/queries'
import { PlaceholderPage } from '../../pages/Placeholder'
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

/**
 * The scorecard page: heading and tabs. The tab is in the URL (`?tab=`) so
 * views are linkable; without it the page opens the tab last used, then Table.
 */
export function ScorecardPage() {
  const { sc } = useParams()
  const scorecards = useScorecards()
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
      <h1 className="text-2xl font-semibold text-accent-deep">{scorecard.name}</h1>
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
          <p className="text-sm text-ink/80">Charts are coming next</p>
        </Tabs.Content>
        <Tabs.Content value="table" className="py-4">
          <TableTab scorecardId={scorecard.id} scorecardName={scorecard.name} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  )
}
