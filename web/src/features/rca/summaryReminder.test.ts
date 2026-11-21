import { describe, expect, it } from 'vitest'
import type { MetricSummary } from '../../api/queries'
import { reminderText, standingLine } from './summaryReminder'

// All data is synthetic.

function missing(metricKey: string, metricName: string, display: string, status: string, headline: string): MetricSummary {
  return {
    metricKey,
    metricName,
    period: '2026-M10',
    requirement: 'required',
    state: 'missing',
    standing: { display, status, headline },
    links: [],
    linksTotal: 0,
    stale: false,
    staleReasons: [],
    canEdit: true,
  }
}

const backlog = missing('support_backlog', 'Weighted support backlog', '588', 'R', '138 above the Green line (450 or less)')
const deployment = missing(
  'deployment_uptime',
  'Deployment uptime',
  '99.63%',
  'R',
  '3 of 9 deployments below 100% · worst Notification Relay - Multi-Region Active 99.63%',
)
const training = missing('security_training', 'Security training completion', '94%', 'G', '6 pts short of 100%')

const URL_ = 'https://app.example/scorecards/service-fulfillment/exec-summaries?period=2026-M10'

describe('reminderText', () => {
  it('writes the block of spec §10.5', () => {
    expect(reminderText([backlog, deployment, training], URL_, 'Oct 2026')).toBe(
      [
        'Exec summaries needed for Oct 2026 (3), required to publish:',
        '- Weighted support backlog · 588 Red · 138 above the Green line',
        '- Deployment uptime · 99.63% Red · worst Notification Relay - Multi-Region Active',
        '- Security training completion · 94% Green · 6 pts short of 100%',
        URL_,
      ].join('\n'),
    )
  })

  it('uses the tenant’s labels when given, and leaves out items that are not missing', () => {
    const written = { ...training, state: 'written' as const, text: 'Done.' }
    const label = (k: string) => ({ R: 'Off track', G: 'On track' })[k] ?? k
    expect(reminderText([backlog, written], URL_, 'Oct 2026', label)).toBe(
      ['Exec summaries needed for Oct 2026 (1), required to publish:', '- Weighted support backlog · 588 Off track · 138 above the Green line', URL_].join(
        '\n',
      ),
    )
  })
})

describe('standingLine', () => {
  it('keeps the worst item without its value, else the headline without its threshold', () => {
    expect(standingLine(deployment)).toBe('worst Notification Relay - Multi-Region Active')
    expect(standingLine(backlog)).toBe('138 above the Green line')
    expect(standingLine(training)).toBe('6 pts short of 100%')
    expect(standingLine({ ...training, standing: { ...training.standing, headline: '' } })).toBe('')
  })
})
