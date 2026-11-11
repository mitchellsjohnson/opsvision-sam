import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './shell/AppShell'
import { ItemsPage } from './features/admin/ItemsPage'
import { MembersPage } from './features/admin/MembersPage'
import { OrgPage } from './features/admin/OrgPage'
import { EntryPage } from './features/entry/EntryPage'
import { HomeRedirect } from './pages/HomeRedirect'
import { NotFoundPage } from './pages/NotFoundPage'
import { RequireAdmin } from './pages/RequireAdmin'
import { OverviewPage } from './features/scorecard/OverviewPage'
import { ScorecardFrame } from './features/scorecard/ScorecardFrame'
import { ScorecardRedirect } from './features/scorecard/ScorecardPage'
import { ImportPage } from './features/admin/ImportPage'
import { MethodologyPage } from './features/admin/MethodologyPage'
import { RecordTypesPage } from './features/admin/RecordTypesPage'
import { TemplatesPage } from './features/admin/TemplatesPage'
import { SetupWizard } from './features/import/setup/SetupWizard'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="scorecards" element={<Navigate to="/" replace />} />
        <Route path="scorecards/:sc" element={<ScorecardFrame />}>
          <Route index element={<ScorecardRedirect />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="table" element={<h1 className="text-2xl font-semibold text-accent-deep">Table</h1>} />
          <Route path="report" element={<h1 className="text-2xl font-semibold text-accent-deep">Report</h1>} />
        </Route>
        <Route path="entry" element={<EntryPage />} />
        <Route path="admin" element={<RequireAdmin />}>
          <Route index element={<Navigate to="org" replace />} />
          <Route path="org" element={<OrgPage />} />
          <Route path="items" element={<ItemsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="methodology" element={<MethodologyPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="import/setup" element={<SetupWizard />} />
          <Route path="record-types" element={<RecordTypesPage />} />
          <Route path="templates" element={<TemplatesPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
