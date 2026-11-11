export interface StatusScaleEntry {
  key: string
  rank: number
}

export interface ScopeCell {
  value: number | null
  status: string
  naReason: string
}

export interface ScopeRow {
  cells: Array<ScopeCell & { period: string; ytd: boolean }>
}

function findCell(columnKey: string, cells: ScopeRow['cells']): ScopeCell | undefined {
  if (columnKey.startsWith('YTD:')) {
    const period = columnKey.slice(4)
    return cells.find((c) => c.ytd && c.period === period)
  }
  return cells.find((c) => !c.ytd && c.period === columnKey)
}

export function cellReported(
  cell: (ScopeCell & { period?: string; ytd?: boolean }) | undefined,
): boolean {
  if (!cell) return false
  if (cell.value != null) return true
  return cell.status !== '' && cell.naReason === ''
}

export function statusAtScope({
  scope,
  children,
  columnKey,
  scale,
  noun,
}: {
  scope: ScopeRow
  children: ScopeRow[]
  columnKey: string
  scale: StatusScaleEntry[]
  noun: 'segments' | 'services' | 'items'
}): { status: string; caption: string } {
  const scopeCell = findCell(columnKey, scope.cells)
  if (cellReported(scopeCell)) {
    return { status: scopeCell!.status, caption: '' }
  }

  const reported = children.filter((child) => cellReported(findCell(columnKey, child.cells)))
  if (reported.length === 0) {
    return { status: '', caption: '' }
  }

  const rankByKey = new Map(scale.map((s) => [s.key, s.rank]))
  let worstStatus = ''
  let worstRank = -Infinity
  for (const child of reported) {
    const cell = findCell(columnKey, child.cells)!
    const rank = rankByKey.get(cell.status) ?? 0
    if (rank > worstRank) {
      worstRank = rank
      worstStatus = cell.status
    }
  }

  return {
    status: worstStatus,
    caption: `worst of ${reported.length} ${noun}`,
  }
}
