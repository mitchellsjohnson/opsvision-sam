import { describe, expect, it } from 'vitest'
import { tenant } from '../../../test/fixtures'
import { REPORT_SUMMARY, reportDocument, reportView } from '../../../test/reportFixtures'
import { buildReportModel, exportChart, goalSeries, reportStatusLine, type ReportModelInput } from './model'

function input(over: Partial<ReportModelInput> = {}): ReportModelInput {
  return {
    doc: reportDocument(),
    scorecardName: 'Main scorecard',
    companyName: 'Example Co',
    scope: '',
    scopeName: '',
    scopeSubjects: [],
    period: '2026-M10',
    fiscalYearStartMonth: 1,
    scale: tenant.statusScale,
    layout: null,
    statusLine: 'Published on Nov 3, 2026',
    ...over,
  }
}

describe('buildReportModel', () => {
  it('keeps the summary at the company scope', () => {
    const model = buildReportModel(input())
    expect(model.companyScope).toBe(true)
    expect(model.summary).toBe(REPORT_SUMMARY)
    expect(model.summaryFor).toBeNull()
    expect(model.title).toBe('Main scorecard · Oct 2026')
    expect(model.scopeLabel).toBe('All of Example Co')
  })

  it('a non-company scope suppresses the summary text and says whose it is', () => {
    const model = buildReportModel(input({ scope: 'unit-a', scopeName: 'Unit A', scopeSubjects: ['unit-a', 'team-a1'] }))
    expect(model.companyScope).toBe(false)
    expect(model.summary).toBeNull()
    expect(model.summaryFor).toBe('Summary is written for Example Co')
    expect(model.scopeLabel).toBe('Unit A')
    expect(JSON.stringify(model)).not.toContain(REPORT_SUMMARY)
  })

  it('recomputes the facts for a non-company scope instead of using the company facts', () => {
    const doc = reportDocument({ facts: ['company-only fact'] })
    const model = buildReportModel(input({ doc, scope: 'unit-a', scopeName: 'Unit A', scopeSubjects: ['unit-a', 'team-a1'] }))
    // Unit A's on-time delivery went from G in September to R in October.
    expect(model.facts).toEqual(['1 metric turned red: On-time delivery'])
    expect(buildReportModel(input({ doc })).facts).toEqual(['company-only fact'])
  })

  it('puts the same metric in needs attention as the overview and keeps every category block', () => {
    const model = buildReportModel(input())
    expect(model.needsAttention.map((m) => m.name)).toEqual(['On-time delivery'])
    const onTime = model.needsAttention[0]!
    expect(onTime.display).toBe('84.3%')
    expect(onTime.status).toBe('Y')
    expect(onTime.change).toBe('+2.1 pts vs Sep')
    expect(onTime.goal).toBe('90.0%')
    expect(onTime.ytd).toBe('95.0%')
    expect(onTime.driver).toBe('Unit A')
    expect(onTime.series[0]!.points.map((p) => p.label)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    expect(model.categories.map((c) => [c.name, c.metrics.map((m) => m.name)])).toEqual([
      ['Delivery', ['On-time delivery']],
      ['Quality', ['Defect rate']],
    ])
  })

  it('builds the six-month table with year to date at the selected scope', () => {
    const model = buildReportModel(input())
    expect(model.columns.map((c) => c.label)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'YTD'])
    const onTime = model.table.find((r) => r.name === 'On-time delivery')!
    expect(onTime.cells.map((c) => c.display)).toEqual(['95.0%', '95.0%', '95.0%', '95.0%', '95.0%', '84.3%', '95.0%'])
    const scoped = buildReportModel(input({ scope: 'unit-a', scopeName: 'Unit A', scopeSubjects: ['unit-a', 'team-a1'] }))
    expect(scoped.table.find((r) => r.name === 'On-time delivery')!.cells[5]).toMatchObject({ display: '70.0%', status: 'R' })
  })

  it('collects notes: overrides, n/a reasons, not reported, and version ids', () => {
    const model = buildReportModel(input())
    expect(model.notes.overrides).toEqual(['Defect rate, All units, Aug 2026: Audit finding'])
    expect(model.notes.naReasons).toEqual(['Not measured this month: Defect rate (Oct 2026)'])
    expect(model.notes.notReported).toEqual(['Defect rate'])
    expect(model.notes.versionIds).toEqual(['ver-1'])
  })

  it('counts health at the scope by the tenant scale', () => {
    const model = buildReportModel(input())
    expect(model.health).toEqual([{ key: 'Y', label: 'Watch', count: 1 }])
    expect(model.notReported).toBe(1)
  })

  it('with a layout, hides the metrics the user hid and orders categories as saved', () => {
    const layout = [
      { id: 'section:quality', size: 'wide' as const, hidden: false },
      { id: 'metric:defect_rate', size: 'small' as const, hidden: false },
      { id: 'section:delivery', size: 'wide' as const, hidden: false },
      { id: 'metric:on_time_pct', size: 'small' as const, hidden: true },
    ]
    const model = buildReportModel(input({ layout }))
    expect(model.categories.map((c) => c.name)).toEqual(['Quality'])
    expect(model.needsAttention).toEqual([])
    expect(model.table.map((r) => r.name)).toEqual(['Defect rate'])
    expect(buildReportModel(input()).categories.map((c) => c.name)).toEqual(['Delivery', 'Quality'])
  })

  it('reads the metric definition from the view row, else falls back to the metric name', () => {
    const doc = reportDocument({ view: reportView() })
    for (const row of doc.view.rows.filter((r) => r.metricKey === 'on_time_pct')) row.definition = 'Closed on time / total closed'
    const model = buildReportModel(input({ doc }))
    expect(model.needsAttention[0]!.definition).toBe('Closed on time / total closed')
    expect(model.categories[1]!.metrics[0]!.definition).toBe('Defect rate')
    expect(model.needsAttention[0]!.versionId).toBe('ver-1')
  })
})

describe('sparse metrics and goals', () => {
  /** Defect rate as a line metric, not applicable in four of its six months and valued in one. */
  function sparseDoc() {
    const doc = reportDocument({ view: reportView() })
    for (const row of doc.view.rows.filter((r) => r.metricKey === 'defect_rate')) {
      row.chartKind = 'line'
      for (const c of row.cells) {
        if (!c.ytd && ['2026-M05', '2026-M06', '2026-M07'].includes(c.period)) {
          Object.assign(c, { value: null, display: '', status: '', naReason: 'No releases' })
        }
      }
    }
    return doc
  }

  it('marks a mostly n/a metric sparse, as the app does, and exports it as a table', () => {
    const model = buildReportModel(input({ doc: sparseDoc() }))
    const defect = model.categories[1]!.metrics[0]!
    expect(defect.sparse).toBe(true)
    expect(exportChart(defect)).toBe('table')
    expect(model.needsAttention[0]!.sparse).toBe(false)
    expect(exportChart(model.needsAttention[0]!)).toBe('line')
  })

  it('has no goal series when only the current month has a target', () => {
    const model = buildReportModel(input())
    expect(model.needsAttention[0]!.goal).toBe('90.0%')
    expect(goalSeries(model.needsAttention[0]!)).toBeNull()
  })

  it('has no goal series when no two adjacent months carry targets', () => {
    const doc = reportDocument({ view: reportView() })
    const root = doc.view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
    root.cells.forEach((c, i) => {
      if (!c.ytd) c.target = i % 2 === 1 ? 90 : null
    })
    expect(goalSeries(buildReportModel(input({ doc })).needsAttention[0]!)).toBeNull()
  })

  it('plots the goal per month where months carry targets, and never on a bar chart', () => {
    const doc = reportDocument({ view: reportView() })
    const root = doc.view.rows.find((r) => r.metricKey === 'on_time_pct' && r.subjectId === 'root')!
    root.cells.forEach((c, i) => {
      if (!c.ytd && i >= 2) c.target = 85 + i
    })
    const onTime = buildReportModel(input({ doc })).needsAttention[0]!
    expect(goalSeries(onTime)).toEqual([null, null, 87, 88, 89, 90])
    for (const row of doc.view.rows.filter((r) => r.metricKey === 'on_time_pct')) row.chartKind = 'money_plan'
    const money = buildReportModel(input({ doc })).needsAttention[0]!
    expect(exportChart(money)).toBe('bar')
    expect(goalSeries(money)).toBeNull()
  })
})

describe('reportStatusLine', () => {
  it('says month to date for the open month when live', () => {
    expect(
      reportStatusLine({ live: true, period: '2026-M11', today: new Date(2026, 10, 13), fiscalYearStartMonth: 1 }),
    ).toBe('Month to date, as of Nov 13, 2026')
  })

  it('names the publisher only when known', () => {
    const base = { live: false, period: '2026-M10', today: new Date(2026, 10, 13), fiscalYearStartMonth: 1, publishedAt: '2026-11-03T14:00:00Z' }
    expect(reportStatusLine({ ...base, publisherName: 'Test Admin' })).toBe('Published on Nov 3, 2026 by Test Admin')
    expect(reportStatusLine(base)).toBe('Published on Nov 3, 2026')
  })

  it('says live for a past month with no snapshot', () => {
    expect(
      reportStatusLine({ live: true, period: '2026-M09', today: new Date(2026, 10, 13), fiscalYearStartMonth: 1 }),
    ).toBe('Live data as of Nov 13, 2026')
  })
})
