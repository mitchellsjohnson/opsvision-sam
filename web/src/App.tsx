import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './shell/AppShell'
import { EntryPage } from './pages/EntryPage'
import { HomeRedirect } from './pages/HomeRedirect'
import { NotFoundPage } from './pages/NotFoundPage'
import { RequireAdmin } from './pages/RequireAdmin'
import { ScorecardPage } from './pages/ScorecardPage'
import { ImportPage } from './pages/admin/ImportPage'
import { ItemsPage } from './pages/admin/ItemsPage'
import { MembersPage } from './pages/admin/MembersPage'
import { MethodologyPage } from './pages/admin/MethodologyPage'
import { OrgPage } from './pages/admin/OrgPage'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="scorecards" element={<Navigate to="/" replace />} />
        <Route path="scorecards/:sc" element={<ScorecardPage />} />
        <Route path="entry" element={<EntryPage />} />
        <Route path="admin" element={<RequireAdmin />}>
          <Route index element={<Navigate to="org" replace />} />
          <Route path="org" element={<OrgPage />} />
          <Route path="items" element={<ItemsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="methodology" element={<MethodologyPage />} />
          <Route path="import" element={<ImportPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
