import clsx from 'clsx'

const STYLES: Record<string, { label: string; className: string }> = {
  G: { label: 'Green', className: 'bg-status-g-bg text-status-g' },
  Y: { label: 'Yellow', className: 'bg-status-y-bg text-status-y' },
  R: { label: 'Red', className: 'bg-status-r-bg text-status-r' },
  NA: { label: 'Not applicable', className: 'bg-status-na-bg text-ink' },
}

export interface StatusBadgeProps {
  /** Status key from the tenant's scale (G, Y, R, NA, ...); empty for no status. */
  status?: string | null
  /** Accessible name for the status, e.g. a tenant-defined label. */
  label?: string
  className?: string
}

/** A status letter in a colored pill. Color is never the only signal: the letter and label carry it too. */
export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const base =
    'inline-flex min-w-7 items-center justify-center rounded-full px-2 py-0.5 text-sm font-semibold leading-none'
  if (!status) {
    return (
      <span
        role="img"
        aria-label="No status"
        className={clsx(base, 'bg-status-na-bg text-ink', className)}
      >
        —
      </span>
    )
  }
  const style = STYLES[status] ?? { label: status, className: 'bg-status-na-bg text-ink' }
  return (
    <span
      role="img"
      aria-label={`Status: ${label ?? style.label}`}
      className={clsx(base, style.className, className)}
    >
      {status}
    </span>
  )
}
