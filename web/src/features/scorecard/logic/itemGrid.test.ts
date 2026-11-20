import { describe, expect, it } from 'vitest'
import type { components } from '../../../api/schema'
import { deploymentGroup, deploymentRows } from '../../../test/deploymentFixtures'
import { buildMonthTrendColumns, buildTrendColumns } from '../columns'
import {
  buildItemRows,
  filterItems,
  itemSummary,
  labelsNeedYear,
  parseItemSort,
  partitionItems,
  sortItems,
  tileExceptions,
  visibleItemOrder,
  type ItemRow,
} from './itemGrid'

type ViewRow = components['schemas']['ViewRow']
type Cell = components['schemas']['Cell']

const columns = buildTrendColumns('2026-M10', 1)
const scale = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]

type Value = [number, string] | null
const STATUS_OF = (v: number) => (v >= 99.9 ? 'G' : v > 99.8 ? 'Y' : 'R')

function cellOf(id: string, period: string, v: Value): Cell {
  return {
    metricKey: 'uptime',
    subjectId: id,
    period,
    ytd: false,
    value: v ? v[0] : null,
    display: v ? v[1] : '',
    status: v ? STATUS_OF(v[0]) : '',
    naReason: '',
    components: {},
    coverage: v ? [1, 1] : [0, 1],
    change: null,
    changeKind: '',
    target: null,
    versionId: 'ver-1',
  }
}

/** Eleven months at `before`, then `oct`. */
function item(id: string, name: string, oct: Value, before: Value = [99.95, '99.95%'], over: Partial<Record<string, Value>> = {}): ViewRow {
  return {
    metricKey: 'uptime',
    metricName: 'Uptime',
    categoryId: 'eng',
    subjectId: id,
    subjectName: name,
    subjectKind: 'item',
    format: 'percent2',
    depth: 0,
    direction: 'higher_better',
    frequency: 'monthly',
    chartKind: 'uptime',
    definition: '',
    cells: columns.map((c, i) => cellOf(id, c.period, c.period in over ? over[c.period]! : i === columns.length - 1 ? oct : before)),
  }
}

const GROUPS: Record<string, string> = { hooks: 'Platform', ingest: 'Data', search: 'Platform', web: 'Payments', ledger: 'Payments', push: 'Mobile', report: 'Data' }

const fixture: ViewRow[] = [
  item('ledger', 'Ledger', [99.99, '99.99%']),
  item('search', 'Search', [99.87, '99.87%']),
  // Three Red months in the window, but Yellow now.
  item('ingest', 'Analytics Ingest', [99.83, '99.83%'], [99.95, '99.95%'], { '2026-M01': [99.5, '99.50%'], '2026-M02': [99.4, '99.40%'], '2026-M03': [99.6, '99.60%'] }),
  item('hooks', 'Webhooks', [99.06, '99.06%'], [99.95, '99.95%'], { '2026-M02': [99.7, '99.70%'] }),
  item('web', 'Web App', [100, '100.00%']),
  item('push', 'Push Gateway', null, [99.98, '99.98%']),
  item('report', 'Reporting', null, null),
  // A unit row of the same metric: not an item, so not in the grid.
  { ...item('root', 'Company', [99.9, '99.90%']), subjectKind: 'unit' },
]

const rows = (): ItemRow[] => buildItemRows(fixture, columns, scale, (id) => GROUPS[id] ?? 'Unassigned', 1)
const ids = (rs: ItemRow[]) => rs.map((r) => r.id)

describe('buildItemRows', () => {
  it('keeps item rows only, with their group, cells and selected value', () => {
    const rs = rows()
    expect(ids(rs)).not.toContain('root')
    expect(rs).toHaveLength(7)
    const hooks = rs.find((r) => r.id === 'hooks')!
    expect(hooks).toMatchObject({ name: 'Webhooks', group: 'Platform', reported: true, value: 99.06, display: '99.06%', status: 'R', worstCount: 2 })
    expect(hooks.cells).toHaveLength(12)
    expect(hooks.current.kind).toBe('status')
    expect(hooks.lastReported).toBeNull()
  })

  it('not reported: the last value in the window, or none', () => {
    const rs = rows()
    expect(rs.find((r) => r.id === 'push')).toMatchObject({ reported: false, status: '', lastReported: { label: 'Sep', display: '99.98%' } })
    expect(rs.find((r) => r.id === 'report')).toMatchObject({ reported: false, lastReported: null })
  })

  it('not reported: a status with no value counts as the last report', () => {
    const statusOnly = item('flags', 'Feature Flags', null, null, { '2026-M08': [99.95, ''] })
    Object.assign(statusOnly.cells.find((c) => c.period === '2026-M08')!, { value: null })
    const [r] = buildItemRows([statusOnly], columns, scale, () => 'Platform', 1)
    expect(r!.lastReported).toMatchObject({ label: 'Aug', display: '', index: 9 })
  })
})

describe('labelsNeedYear', () => {
  it('12 months, or 4 quarters with no repeat: the short label is enough', () => {
    expect(labelsNeedYear(buildTrendColumns('2026-M10', 1))).toBe(false)
    expect(labelsNeedYear(buildTrendColumns('2026-Q3', 1).slice(-4))).toBe(false)
  })

  it('a repeated short label, or more than 12 months: the label carries the year', () => {
    expect(labelsNeedYear(buildTrendColumns('2026-Q3', 1))).toBe(true)
    expect(labelsNeedYear(buildMonthTrendColumns('2026-M10', 13, 1))).toBe(true)
    expect(labelsNeedYear(buildMonthTrendColumns('2026-M10', 24, 1))).toBe(true)
    expect(labelsNeedYear(buildTrendColumns('2026-H2', 1))).toBe(true)
  })
})

describe('sortItems', () => {
  it('worst now: status rank, then worse value by direction, then name', () => {
    const { reported, notReported } = sortItems(rows(), 'worst', 'higher_better', scale)
    expect(ids(reported)).toEqual(['hooks', 'ingest', 'search', 'ledger', 'web'])
    expect(ids(notReported)).toEqual(['push', 'report'])
  })

  it('lower is better flips the value order within a status', () => {
    const { reported } = sortItems(rows(), 'worst', 'lower_better', scale)
    expect(ids(reported)).toEqual(['hooks', 'search', 'ingest', 'web', 'ledger'])
  })

  it('most Red months: worst-status cells in the window, then worst now', () => {
    const { reported } = sortItems(rows(), 'reds', 'higher_better', scale)
    expect(ids(reported)).toEqual(['ingest', 'hooks', 'search', 'ledger', 'web'])
  })

  it('name: locale order; not reported always last, by name', () => {
    const { reported, notReported } = sortItems(rows(), 'name', 'higher_better', scale)
    expect(ids(reported)).toEqual(['ingest', 'ledger', 'search', 'web', 'hooks'])
    expect(ids(notReported)).toEqual(['push', 'report'])
  })

  it('an unknown sort in the URL reads as worst now', () => {
    expect(parseItemSort('bogus')).toBe('worst')
    expect(parseItemSort(null)).toBe('worst')
    expect(parseItemSort('reds')).toBe('reds')
    expect(parseItemSort('name')).toBe('name')
  })
})

describe('itemSummary', () => {
  it('counts every item, the best status, each status and the not reported', () => {
    const s = itemSummary(rows(), scale)
    expect(s).toMatchObject({ total: 7, best: 2, notReported: 2 })
    expect([...s.counts]).toEqual(expect.arrayContaining([['R', 1], ['Y', 2], ['G', 2]]))
    expect(s.worst?.id).toBe('hooks')
  })

  it('the best is the rank minimum of any scale', () => {
    const four = [
      { key: 'A', rank: 1 },
      { key: 'G', rank: 2 },
      { key: 'Y', rank: 3 },
      { key: 'R', rank: 4 },
    ]
    expect(itemSummary(rows(), four).best).toBe(0)
  })

  it('no items: nothing worst', () => {
    expect(itemSummary([], scale)).toMatchObject({ total: 0, best: 0, notReported: 0, notApplicable: 0, worst: null })
  })
})

describe('n/a items', () => {
  /** The fixture plus Archive, not applicable this month. */
  const withNa = () => {
    const archive = item('archive', 'Archive', null)
    const oct = archive.cells[archive.cells.length - 1]!
    Object.assign(oct, { naReason: 'Retired in Oct', coverage: [0, 0] })
    return buildItemRows([...fixture, archive], columns, scale, (id) => GROUPS[id] ?? 'Unassigned', 1)
  }

  it('are their own group, by name, after the not reported', () => {
    const { reported, notReported, notApplicable } = sortItems(withNa(), 'worst', 'higher_better', scale)
    expect(reported).toHaveLength(5)
    expect(ids(notReported)).toEqual(['push', 'report'])
    expect(ids(notApplicable)).toEqual(['archive'])
  })

  it('are counted apart from the not reported', () => {
    expect(itemSummary(withNa(), scale)).toMatchObject({ total: 8, notReported: 2, notApplicable: 1 })
  })

  it('are not exceptions on the tile', () => {
    const e = tileExceptions(withNa(), { columns, offset: 0, scale, direction: 'higher_better' })
    expect(ids(e.shown)).toEqual(['hooks', 'ingest', 'search', 'push'])
    expect(e).toMatchObject({ restBest: 2, silent: 1 })
  })

  it('are their own partition, never silent', () => {
    const p = partitionItems(withNa(), columns)
    expect(ids(p.notApplicable)).toEqual(['archive'])
    expect(ids(p.silent)).toEqual(['report'])
  })
})

describe('filterItems', () => {
  it('matches item and group names, case-insensitive', () => {
    expect(ids(filterItems(rows(), 'pay'))).toEqual(['ledger', 'web'])
    expect(ids(filterItems(rows(), 'WEB'))).toEqual(['hooks', 'web'])
    expect(filterItems(rows(), '  ')).toHaveLength(7)
    expect(filterItems(rows(), 'xyz')).toEqual([])
  })
})

describe('tileExceptions', () => {
  it('non-best reported items worst first, then those that stopped inside the shown columns; never the silent', () => {
    const e = tileExceptions(rows(), { columns, offset: 0, scale, direction: 'higher_better' })
    expect(ids(e.shown)).toEqual(['hooks', 'ingest', 'search', 'push'])
    expect(e).toMatchObject({ restBest: 2, hiddenWorse: 0, hiddenStopped: 0, stoppedBefore: 0, silent: 1 })
  })

  it('counts the rows cut by the limit', () => {
    const e = tileExceptions(rows(), { columns, offset: 0, scale, direction: 'higher_better', max: 2 })
    expect(ids(e.shown)).toEqual(['hooks', 'ingest'])
    expect(e).toMatchObject({ hiddenWorse: 1, hiddenStopped: 1 })
  })

  describe('the deployments over 12 months, 6 shown (May–Oct)', () => {
    const deployments = buildItemRows(deploymentRows(columns), columns, scale, deploymentGroup, 1)
    const e = tileExceptions(deployments, { columns, offset: 6, scale, direction: 'higher_better' })

    it('the Red one, then the stopped most recent first', () => {
      expect(ids(e.shown)).toEqual(['dep-notify-multi', 'dep-webhooks-us', 'dep-renderer', 'dep-identity-dr'])
    })

    it('a last report before May is counted, not shown; so are the silent', () => {
      expect(e).toMatchObject({ restBest: 8, hiddenStopped: 0, stoppedBefore: 1, stoppedBeforeLabel: 'May', silent: 8 })
    })

    it('all 12 shown, the legacy cluster gets its row', () => {
      expect(ids(tileExceptions(deployments, { columns, offset: 0, scale, direction: 'higher_better' }).shown)).toContain(
        'dep-search-legacy',
      )
    })
  })
})

describe('the 21 deployments', () => {
  const twelve = () => buildItemRows(deploymentRows(columns), columns, scale, deploymentGroup, 1)
  const window24 = buildMonthTrendColumns('2026-M10', 24, 1)

  it('partition over the 12-month window: 9 reported, 4 not reported, 8 silent', () => {
    const p = partitionItems(twelve(), columns)
    expect(p.reported).toHaveLength(9)
    expect(ids(p.notReported).sort()).toEqual(['dep-identity-dr', 'dep-renderer', 'dep-search-legacy', 'dep-webhooks-us'])
    expect(p.silent).toHaveLength(8)
    expect(ids(p.silent)).toContain('dep-partner-sandbox')
    expect(p.notApplicable).toHaveLength(0)
  })

  it('over 24 months the sandbox reported (Sep 2025), so it is not silent', () => {
    const rs = buildItemRows(deploymentRows(window24), window24, scale, deploymentGroup, 1)
    const p = partitionItems(rs, window24)
    expect(p.silent).toHaveLength(7)
    expect(ids(p.notReported)).toContain('dep-partner-sandbox')
    expect(rs.find((r) => r.id === 'dep-search-legacy')!.lastReported).toMatchObject({ label: 'Dec', fullLabel: 'Dec 2025', display: '99.20%' })
  })

  it('itemSummary still counts all 12 as not reported', () => {
    expect(itemSummary(twelve(), scale)).toMatchObject({ total: 21, best: 8, notReported: 12 })
  })

  it('sortItems returns the same three groups as before', () => {
    const s = sortItems(twelve(), 'worst', 'higher_better', scale)
    expect(s.reported).toHaveLength(9)
    expect(s.reported[0]!.id).toBe('dep-notify-multi')
    expect(s.notReported).toHaveLength(12)
    expect(s.notApplicable).toHaveLength(0)
  })
})

describe('partitionItems', () => {
  /** Reported only in the window's first column: not silent, whatever a layout shows. */
  const early = () => {
    const firstOnly = item('early', 'Early', null, null, { [columns[0]!.period]: [99.95, '99.95%'] })
    const none = item('none', 'None', null, null)
    return buildItemRows([firstOnly, none], columns, scale, () => 'Data', 1)
  }

  it('judges silence over every column of the window', () => {
    const p = partitionItems(early(), columns)
    expect(ids(p.silent)).toEqual(['none'])
    expect(ids(p.notReported)).toEqual(['early'])
  })

  it('a window cut to the last 6 makes the early one silent too', () => {
    const p = partitionItems(early(), columns.slice(6))
    expect(ids(p.silent)).toEqual(['early', 'none'])
  })
})

describe('visibleItemOrder', () => {
  const deployments = buildItemRows(deploymentRows(columns), columns, scale, deploymentGroup, 1)
  const order = (o: { filter?: string; silentOpen?: boolean }) =>
    visibleItemOrder(deployments, { columns, filter: '', sort: 'worst', direction: 'higher_better', scale, silentOpen: false, ...o })

  it('reported, then not reported, without the silent while their group is shut', () => {
    const ids = order({})
    expect(ids).toHaveLength(13)
    expect(ids[0]).toBe('dep-notify-multi')
    expect(ids).not.toContain('dep-edge-cache')
  })

  it('the silent last, by name, while open', () => {
    const ids = order({ silentOpen: true })
    expect(ids).toHaveLength(21)
    expect(ids.slice(13)).toEqual([
      'dep-warehouse-primary',
      'dep-warehouse-replica',
      'dep-billing-recon',
      'dep-export-jobs',
      'dep-edge-cache',
      'dep-push-apac',
      'dep-push-eu',
      'dep-partner-sandbox',
    ])
  })

  it('a filter shows the silent that match, open or not', () => {
    expect(order({ filter: 'warehouse' })).toEqual(['dep-warehouse-primary', 'dep-warehouse-replica'])
    expect(order({ filter: 'identity' })).toEqual(['dep-identity-west', 'dep-identity-east', 'dep-identity-dr'])
  })
})
