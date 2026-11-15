import { Navigate, useLocation } from 'react-router'
import { useMyPreferences, useScorecards } from '../api/queries'
import { PlaceholderPage } from './Placeholder'

/**
 * `/` goes to the first scorecard, keeping the period selection in the URL.
 * Without a scope in the link it opens at the person's saved default scope.
 */
export function HomeRedirect() {
  const { search } = useLocation()
  const scorecards = useScorecards()
  const prefs = useMyPreferences()

  if (scorecards.isPending || prefs.isPending) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const first = scorecards.data.scorecards[0]
  if (!first) return <PlaceholderPage title="No scorecards yet" />
  const params = new URLSearchParams(search)
  const defaultScope = prefs.data?.defaultScope ?? ''
  if (!params.has('scope') && defaultScope) params.set('scope', defaultScope)
  const next = params.size > 0 ? `?${params.toString()}` : ''
  return <Navigate to={{ pathname: `/scorecards/${first.id}`, search: next }} replace />
}
