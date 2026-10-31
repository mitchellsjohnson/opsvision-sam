import { Outlet } from 'react-router'
import { useMe } from '../api/queries'
import { PlaceholderPage } from './Placeholder'

/** Renders the admin pages for admins only. The API enforces this too. */
export function RequireAdmin() {
  const me = useMe()
  if (me.isPending) return <p role="status">Loading…</p>
  if (me.data?.role !== 'admin') {
    return <PlaceholderPage title="Not allowed">Only admins can open this page.</PlaceholderPage>
  }
  return <Outlet />
}
