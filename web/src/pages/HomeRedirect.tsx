import { Navigate, useLocation } from 'react-router'
import { useScorecards } from '../api/queries'
import { useDefaultScope } from '../shell/useDefaultScope'
import { PlaceholderPage } from './Placeholder'

/**
 * `/` goes to the first scorecard, keeping the period selection in the URL.
 * Without a scope in the link it opens at the person's default scope, when
 * that unit still exists and is not retired.
 */
export function HomeRedirect() {
  const { search } = useLocation()
  const scorecards = useScorecards()
  const params = new URLSearchParams(search)
  const defaultScope = useDefaultScope(params.get('period'))

  if (scorecards.isPending || !defaultScope.ready) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const first = scorecards.data.scorecards[0]
  if (!first) return <PlaceholderPage title="No scorecards yet" />
  if (!params.has('scope') && defaultScope.scope) params.set('scope', defaultScope.scope)
  const next = params.size > 0 ? `?${params.toString()}` : ''
  return <Navigate to={{ pathname: `/scorecards/${first.id}`, search: next }} replace />
}
