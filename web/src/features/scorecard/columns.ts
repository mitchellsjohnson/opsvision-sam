import {
  formatPeriod,
  lastMonth,
  monthLabel,
  parsePeriod,
  periodLabel,
  prev,
  type Period,
} from '../../lib/period'

export interface Column {
  /** Matches the API's `versionByPeriod` keys: `2026-M10` or `YTD:2026-M10`. */
  key: string
  /** Short header text: `Oct`, `Q3`, `FY2026`, `YTD`. */
  label: string
  /** Unambiguous label for assistive technology and the drawer title. */
  fullLabel: string
  /** The period, or for a YTD column the month it runs through. */
  period: string
  ytd: boolean
}

/** `Oct`, `Q3`, `H2` or `FY2026`: the compact label of a fiscal period. */
export function shortLabel(p: Period, fiscalYearStartMonth: number): string {
  switch (p.grain) {
    case 'month':
      return monthLabel(p, fiscalYearStartMonth).split(' ')[0] ?? ''
    case 'quarter':
      return `Q${p.index}`
    case 'half':
      return `H${p.index}`
    case 'year':
      return `FY${p.fy}`
  }
}

function periodColumn(p: Period, fiscalYearStartMonth: number): Column {
  const period = formatPeriod(p)
  return {
    key: period,
    label: shortLabel(p, fiscalYearStartMonth),
    fullLabel: periodLabel(p, fiscalYearStartMonth),
    period,
    ytd: false,
  }
}

/**
 * The columns for the selected period. Month: the 12 fiscal months ending at
 * it. Quarter and half: that fiscal year's quarters or halves up to it. Year:
 * the selected and two prior fiscal years. With `ytd`, a YTD column through
 * the period's last month follows (never for a year, which already is one).
 */
export function buildColumns(period: string, ytd: boolean, fiscalYearStartMonth: number): Column[] {
  const selected = parsePeriod(period)
  if (!selected) return []
  let periods: Period[]
  switch (selected.grain) {
    case 'month': {
      periods = [selected]
      for (let i = 1; i < 12; i++) periods.unshift(prev(periods[0] as Period))
      break
    }
    case 'quarter':
    case 'half':
      periods = Array.from({ length: selected.index }, (_, i) => ({ ...selected, index: i + 1 }))
      break
    case 'year':
      periods = [selected.fy - 2, selected.fy - 1, selected.fy].map((fy) => ({ ...selected, fy }))
      break
  }
  const columns = periods.map((p) => periodColumn(p, fiscalYearStartMonth))
  if (ytd && selected.grain !== 'year') {
    const through = lastMonth(selected)
    const throughString = formatPeriod(through)
    columns.push({
      key: `YTD:${throughString}`,
      label: 'YTD',
      fullLabel: `Year to date through ${monthLabel(through, fiscalYearStartMonth)}`,
      period: throughString,
      ytd: true,
    })
  }
  return columns
}

const TREND_SPAN: Record<Period['grain'], number> = { month: 12, quarter: 8, half: 4, year: 3 }

/**
 * Trend columns for the Overview chart window: 12 months, 8 quarters, 4 halves,
 * or 3 years ending at the selected period (no YTD column).
 */
export function buildTrendColumns(period: string, fiscalYearStartMonth: number): Column[] {
  const selected = parsePeriod(period)
  if (!selected) return []
  const count = TREND_SPAN[selected.grain]
  let periods: Period[] = [selected]
  for (let i = 1; i < count; i++) periods.unshift(prev(periods[0] as Period))
  return periods.map((p) => periodColumn(p, fiscalYearStartMonth))
}

/** The `periods` and `ytd` view query parameters for a set of columns. */
export function columnRequest(columns: Column[]): { periods: string[]; ytd?: string[] } {
  const periods = columns.filter((c) => !c.ytd).map((c) => c.period)
  const ytd = columns.filter((c) => c.ytd).map((c) => c.period)
  return ytd.length > 0 ? { periods, ytd } : { periods }
}

/** Non-YTD columns only. */
export function periodColumns(columns: Column[]): Column[] {
  return columns.filter((c) => !c.ytd)
}

/** The index of the selected period among non-YTD columns. */
export function selectedColumnIndex(allColumns: Column[], selectedPeriod: string): number {
  const periods = periodColumns(allColumns)
  const idx = periods.findIndex((c) => c.period === selectedPeriod)
  return idx >= 0 ? idx : periods.length - 1
}

/** Period columns in the visible window, with any YTD column pinned at the end. */
export function sliceTableWindow(allColumns: Column[], start: number, visible: number): Column[] {
  const periods = periodColumns(allColumns)
  const ytd = allColumns.filter((c) => c.ytd)
  const span = Math.min(visible, periods.length)
  const slice = periods.slice(start, start + span)
  return [...slice, ...ytd]
}

/** Standard legacy import override reason; identical reasons group under the table. */
export const LEGACY_OVERRIDE_REASON = 'As reported in legacy workbook'

export function groupedOverrideLabel(reason: string, count: number): string {
  if (reason === LEGACY_OVERRIDE_REASON) {
    return `${count} values as reported in the legacy workbook`
  }
  return `${count} overridden values: ${reason}`
}
