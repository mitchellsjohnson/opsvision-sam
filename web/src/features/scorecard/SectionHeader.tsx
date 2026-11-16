import { RollUp, type StatusLevel } from '../../ui/status'
import type { BoardRow } from './logic/statusBoard'

/** A category's heading over its tiles, with the board's roll-up text: `Delivery ◆ 1 Red · ▲ 1 Yellow`. */
export function SectionHeader({ id, name, rows, scale }: { id: string; name: string; rows: BoardRow[]; scale: StatusLevel[] }) {
  return (
    // In Customize layout mode, LayoutGrid publishes the toolbar's width so the roll-up wraps clear of it.
    <div
      data-section-header=""
      className="flex flex-wrap items-baseline border-b border-ink/15 pb-1.5 pt-2"
      style={{ paddingRight: 'var(--tile-toolbar, 0px)' }}
    >
      <h2 id={id} className="text-base font-semibold text-accent-deep">
        {name}
      </h2>
      <RollUp rows={rows} scale={scale} />
    </div>
  )
}
