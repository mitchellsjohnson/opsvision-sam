export function periodWindowSize(contentWidthPx: number): number {
  if (contentWidthPx <= 720) return 3
  if (contentWidthPx <= 960) return 6
  if (contentWidthPx <= 1280) return 9
  return 12
}

export function windowStart(columnCount: number, visible: number, selectedIndex: number): number {
  const span = Math.min(visible, columnCount)
  let start = selectedIndex - span + 1
  if (start < 0) start = 0
  if (start + span > columnCount) start = columnCount - span
  if (start < 0) start = 0
  return start
}
