import { Outlet, useParams } from 'react-router'
import { useMe, useScorecards } from '../../api/queries'
import { PlaceholderPage } from '../../pages/Placeholder'
import { useElementHeight } from '../../ui/useElementHeight'
import { ControlBar } from './ControlBar'
import { FocusDialog } from './FocusDialog'
import { UploadRecords } from './ScorecardPage'

/** Scorecard shell: shared controls, upload, and nested view routes. */
export function ScorecardFrame() {
  const { sc } = useParams()
  const scorecards = useScorecards()
  const me = useMe()
  const isAdmin = me.data?.role === 'admin'
  const [barRef, barHeight] = useElementHeight<HTMLElement>()

  if (scorecards.isPending) return <p role="status">Loading…</p>
  if (scorecards.isError) {
    return <p role="alert">Could not load scorecards: {scorecards.error.message}</p>
  }
  const scorecard = scorecards.data.scorecards.find((s) => s.id === sc)
  if (!scorecard) return <PlaceholderPage title="Scorecard not found" />

  return (
    <div
      className="min-w-0"
      style={{ ['--scorecard-control-bar-height' as string]: barHeight > 0 ? `${barHeight}px` : '4.5rem' }}
    >
      {isAdmin && (
        <div className="mb-3 flex justify-end">
          <UploadRecords scorecardId={scorecard.id} />
        </div>
      )}
      <ControlBar scorecardId={scorecard.id} barRef={barRef} />
      <div className="mt-4 min-w-0">
        <FocusDialog />
        <Outlet />
      </div>
    </div>
  )
}
