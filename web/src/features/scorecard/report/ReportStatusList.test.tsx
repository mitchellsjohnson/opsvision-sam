import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { components } from '../../../api/schema'
import { tenant } from '../../../test/fixtures'
import { deploymentRows } from '../../../test/deploymentFixtures'
import {
  defectOptional,
  ON_TIME_TEXT,
  onTimeMissing,
  onTimeWritten,
  publishedDocV1,
  publishedDocV2,
  reportDocument,
  reportView,
} from '../../../test/reportFixtures'
import { rcaExcerpt } from '../../rca/rcaText'
import { quarterlyVersions } from '../../../test/viewFixtures'
import { buildTrendColumns } from '../columns'
import { buildReportModel, type ReportModelInput } from './model'
import { ReportStatusList } from './ReportStatusList'

type ReportDocument = components['schemas']['ReportDocument']
type ScorecardView = components['schemas']['ScorecardView']

const scale = tenant.statusScale

function modelOf(doc: ReportDocument, over: Partial<ReportModelInput> = {}) {
  return buildReportModel({
    doc,
    scorecardName: 'Main scorecard',
    companyName: 'Example Co',
    scope: '',
    scopeName: '',
    scopeSubjects: [],
    period: '2026-M10',
    fiscalYearStartMonth: 1,
    scale,
    layout: null,
    statusLine: 'Published on Nov 3, 2026',
    versions: quarterlyVersions,
    ...over,
  })
}

function renderList(doc: ReportDocument, counted: ScorecardView = doc.standing ?? doc.view) {
  const model = modelOf(doc)
  return render(<ReportStatusList model={model} scale={scale} counted={counted} fiscalYearStartMonth={1} />)
}

/** A metric's row: the row whose header is the metric's name. */
function rowOf(name: string): HTMLTableRowElement {
  return screen.getByRole('rowheader', { name }).closest('tr')!
}

/** The report's view with Deployment uptime: 21 deployments, no company value, one Red in Oct 2026. */
function deploymentDoc(): ReportDocument {
  const view = reportView()
  view.categories = [...view.categories, { id: 'eng', name: 'Engineering', order: 3 }]
  view.rows.push(...deploymentRows(buildTrendColumns('2026-M10', 1)))
  return reportDocument({ view })
}

describe('ReportStatusList', () => {
  it('renders one row per metric: the name as its header and one cell with everything about it', () => {
    renderList(publishedDocV2())
    const metricRows = screen.getAllByRole('rowheader').filter((th) => th.getAttribute('scope') === 'row')
    expect(metricRows.map((th) => th.textContent)).toEqual(['On-time delivery', 'Concepts delivered expected value', 'Defect rate'])
    for (const th of metricRows) {
      const tr = th.closest('tr')!
      expect(tr.querySelectorAll('th')).toHaveLength(1)
      expect(tr.querySelectorAll('td')).toHaveLength(1)
    }

    const cell = rowOf('On-time delivery').querySelector('td')!
    expect(within(cell).getByText('84.3%')).toBeTruthy()
    expect(cell.textContent).toContain('▲Y')
    expect(within(cell).getByText('YTD 95.0%')).toBeTruthy()
    const months = cell.querySelectorAll('[data-kind]')
    expect(months).toHaveLength(6)
    for (const m of months) expect(m.getAttribute('aria-hidden')).toBe('true')
    expect(within(cell).getByText(
      'May 2026: 95.0% Green; Jun 2026: 95.0% Green; Jul 2026: 95.0% Green; Aug 2026: 95.0% Green; Sep 2026: 95.0% Green; Oct 2026: 84.3% Yellow',
    ).className).toContain('sr-only')
  })

  it('heads the months with one sticky row offset by the top and control bars, the report month marked', () => {
    const { container } = renderList(publishedDocV2())
    const head = container.querySelector('thead')!
    expect(head.querySelectorAll('tr')).toHaveLength(1)
    const th = head.querySelector('th')!
    expect(head.querySelector('td')).toBeTruthy()
    for (const c of head.querySelectorAll('td, th')) {
      expect((c as HTMLElement).style.top).toBe('calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))')
      expect(c.className).toContain('sticky')
    }
    const labels = [...th.querySelectorAll('[data-month]')]
    expect(labels.map((l) => l.textContent)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
    expect(labels[5]!.className).toContain('text-accent-deep')
    expect(labels[4]!.className).not.toContain('text-accent-deep')
  })

  it('shows a quarterly metric’s quarter in its last month, not due elsewhere, with the counted period and the next due', () => {
    renderList(publishedDocV2())
    const cell = rowOf('Concepts delivered expected value').querySelector('td')!
    expect(within(cell).getByText('70%')).toBeTruthy()
    expect(within(cell).getByText('Q3 FY2026 · Q4 due by Jan')).toBeTruthy()
    const kinds = [...cell.querySelectorAll('[data-kind]')].map((c) => c.getAttribute('data-kind'))
    expect(kinds).toEqual(['notDue', 'status', 'notDue', 'notDue', 'status', 'notDue'])
    expect(within(cell).getByText('Q2 FY2026: 85% Green; Q3 FY2026: 70% Yellow')).toBeTruthy()
  })

  it('leads an item metric’s caption with the worst item’s name, through ItemName', () => {
    const doc = deploymentDoc()
    renderList(doc)
    const cell = rowOf('Deployment uptime').querySelector('td')!
    expect(within(cell).getByText('99.63%')).toBeTruthy()
    expect(cell.textContent).toContain('◆R')
    const name = cell.querySelector('[data-name]')!
    expect(name.textContent).toBe('Notification Relay - Multi-Region Active')
    expect(name.closest('[data-caption]')!.textContent).toBe('Notification Relay - Multi-Region Active · 1 of 21 Red')
  })

  it('gives the worst item’s name its own line when the caption does not fit on one', () => {
    const rect = vi.spyOn(HTMLTableCellElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200 } as DOMRect)
    try {
      renderList(deploymentDoc())
      const caption = rowOf('Deployment uptime').querySelector('[data-caption]')!
      expect([...caption.children].map((c) => c.textContent)).toEqual(['Notification Relay - Multi-Region Active', '1 of 21 Red'])
      // A short caption still takes one line.
      expect(within(rowOf('On-time delivery')).getByText('YTD 95.0%')).toBeTruthy()
    } finally {
      rect.mockRestore()
    }
  })

  it('heads each category with a rowgroup header counting its statuses other than the best, worst first', () => {
    const { container } = renderList(deploymentDoc())
    const groups = [...container.querySelectorAll('tbody')].map((b) => b.querySelector('tr:first-child th')!)
    for (const th of groups) {
      expect(th.getAttribute('scope')).toBe('rowgroup')
      expect(th.getAttribute('colspan')).toBe('2')
    }
    expect(groups.map((th) => th.textContent)).toEqual(['Delivery · ▲ 1 Yellow', 'Quality', 'Engineering · ◆ 1 Red'])
  })

  it('says a not-counted metric is not in this revision, and draws no months for it', () => {
    renderList(publishedDocV1())
    for (const name of ['Platform review score', 'Concepts delivered expected value']) {
      const cell = rowOf(name).querySelector('td')!
      expect(within(cell).getByText('Not in this revision')).toBeTruthy()
      expect(cell.querySelector('[data-caption]')).toBeNull()
      expect([...cell.querySelectorAll('[data-kind]')].map((c) => c.getAttribute('data-kind'))).toEqual(Array(6).fill('notDue'))
      expect(cell.querySelector('.sr-only')).toBeNull()
    }
  })

  it('wraps a text caption rather than cutting it (`No reports in the last 12 months` at 320)', () => {
    renderList(publishedDocV2())
    const caption = within(rowOf('On-time delivery')).getByText('YTD 95.0%').closest('[data-caption]')!
    expect(caption.querySelector('.truncate')).toBeNull()
    expect(caption.className).not.toContain('whitespace-nowrap')
    expect(caption.className).not.toContain('truncate')
  })

  it('has no axe violations', async () => {
    const { container } = renderList(deploymentDoc())
    expect((await axe(container)).violations).toEqual([])
  })

  describe('exec summaries', () => {
    function renderWith(items: ReportModelInput['summaries']) {
      const doc = reportDocument()
      const model = modelOf(doc, { summaries: items })
      return render(<ReportStatusList model={model} scale={scale} counted={doc.view} fiscalYearStartMonth={1} />)
    }

    it('captions a written summary with its excerpt', () => {
      renderWith({ source: 'live', items: [onTimeWritten] })
      const caption = rowOf('On-time delivery').querySelector('[data-summary-caption]')!
      expect(caption.textContent).toBe(`Summary: ${rcaExcerpt(ON_TIME_TEXT)}`)
    })

    it('captions a missing one `Exec summary needed`, and an optional one with nothing', () => {
      renderWith({ source: 'live', items: [onTimeMissing, defectOptional] })
      expect(rowOf('On-time delivery').querySelector('[data-summary-caption]')!.textContent).toBe('Exec summary needed')
      expect(rowOf('Defect rate').querySelector('[data-summary-caption]')).toBeNull()
    })

    it('draws no summary caption without summaries', () => {
      renderWith(null)
      expect(document.querySelector('[data-summary-caption]')).toBeNull()
    })
  })
})
