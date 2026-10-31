import { Navigate, useLocation } from 'react-router'
import { useScorecards } from '../api/queries'
import { PlaceholderPage } from './Placeholder'

/** `/` goes to the first scorecard, keeping the period selection in the URL. */
export function HomeRedirect() {
  const { search } = useLocation()
  const scorecards = useScorecards()

  if (scorecards.isPending) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const first = scorecards.data.scorecards[0]
  if (!first) return <PlaceholderPage title="No scorecards yet" />
  return <Navigate to={{ pathname: `/scorecards/${first.id}`, search }} replace />
}
