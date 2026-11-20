import { describe, expect, it } from 'vitest'
import {
  codePoints,
  durationText,
  hostOf,
  linksBytes,
  noteDate,
  rcaExcerpt,
  safeHref,
  sourceLabel,
  timeRange,
  whyName,
} from './rcaText'

describe('safeHref', () => {
  it('accepts https only, in any case, and returns the URL with a lowercase scheme', () => {
    expect(safeHref('http://x')).toBeNull()
    expect(safeHref('HTTPS://docs.example/a')).toBe('https://docs.example/a')
    expect(safeHref('https://tracker.example/browse/INC-2041')).toBe('https://tracker.example/browse/INC-2041')
  })

  it('rejects scripts, user info, whitespace, missing hosts and junk', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeHref('https://user:pass@docs.example/a')).toBeNull()
    expect(safeHref('https://docs.example/a b')).toBeNull()
    expect(safeHref(' https://docs.example/a')).toBeNull()
    expect(safeHref('https://')).toBeNull()
    expect(safeHref('')).toBeNull()
    expect(safeHref('not a url')).toBeNull()
    expect(safeHref(`https://docs.example/${'a'.repeat(2049)}`)).toBeNull()
  })
})

describe('hostOf', () => {
  it('is the hostname, with internationalized hosts as punycode', () => {
    expect(hostOf('https://docs.example/a')).toBe('docs.example')
    expect(hostOf('https://bücher.example/x')).toBe('xn--bcher-kva.example')
    expect(hostOf('https://xn--bcher-kva.example/x')).toBe('xn--bcher-kva.example')
    expect(hostOf('nope')).toBe('')
  })
})

describe('codePoints', () => {
  it('counts code points after NFC normalization', () => {
    expect(codePoints('abc')).toBe(3)
    expect(codePoints('😀')).toBe(1)
    expect(codePoints('e\u0301')).toBe(1)
  })
})

describe('rcaExcerpt', () => {
  it('cuts at 60 characters and adds an ellipsis', () => {
    const text = 'x'.repeat(70)
    const out = rcaExcerpt(text)
    expect([...out]).toHaveLength(61)
    expect(out.endsWith('…')).toBe(true)
    expect(rcaExcerpt('short')).toBe('short')
    expect(rcaExcerpt('x'.repeat(60))).toBe('x'.repeat(60))
  })
})

describe('durationText', () => {
  it('formats minutes as the API does', () => {
    expect(durationText(45)).toBe('45m')
    expect(durationText(420)).toBe('7h 00m')
    expect(durationText(216)).toBe('3h 36m')
    expect(durationText(1565)).toBe('1d 2h 05m')
    expect(durationText(0)).toBe('0m')
  })
})

describe('timeRange', () => {
  it('shows one day once and spans days in full', () => {
    expect(timeRange('2026-10-03T14:05:00Z', '2026-10-03T18:15:00Z')).toBe('Oct 3, 14:05–18:15 UTC')
    expect(timeRange('2026-09-30T23:05:00Z', '2026-10-01T00:50:00Z')).toBe('Sep 30, 23:05 – Oct 1, 00:50 UTC')
    expect(timeRange('2026-10-30T16:40:00Z', null)).toBe('From Oct 30, 16:40 UTC')
    expect(timeRange(null, null)).toBe('')
  })
})

describe('small labels', () => {
  it('formats the byline date, the source label and the link budget', () => {
    expect(noteDate('2026-11-03T10:00:00Z')).toBe('Nov 3')
    expect(sourceLabel('status-page')).toBe('Status page')
    expect(linksBytes([{ title: 'é', url: 'https://a.example' }])).toBe(2 + 17)
  })
})

describe('whyName', () => {
  const base = { subjectName: 'Webhooks', valueDisplay: '99.06%', periodLabel: 'Oct 2026' }

  it('names each state', () => {
    expect(whyName({ ...base, display: { state: 'available' } })).toBe('Why is Webhooks 99.06% in Oct 2026?')
    expect(whyName({ ...base, display: { state: 'needed', canEdit: true } })).toBe(
      'Why is Webhooks 99.06% in Oct 2026? RCA needed',
    )
    expect(whyName({ ...base, display: { state: 'needed', canEdit: false } })).toBe('Why is Webhooks 99.06% in Oct 2026?')
    expect(
      whyName({ ...base, display: { state: 'written', excerpt: 'x', author: 'Avery Admin', canEdit: false } }),
    ).toBe('Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin')
    expect(whyName({ ...base, display: { state: 'stale', excerpt: 'x', author: 'Avery Admin', canEdit: true } })).toBe(
      'Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin. RCA may be out of date',
    )
    expect(
      whyName({ ...base, subjectName: 'Acme Demo', display: { state: 'rollup', neededBelow: 2, staleBelow: 0, showCounts: true } }),
    ).toBe('Why is Acme Demo 99.06% in Oct 2026? 2 RCAs needed below it')
    expect(
      whyName({ ...base, display: { state: 'rollup', neededBelow: 1, staleBelow: 1, showCounts: true } }),
    ).toBe('Why is Webhooks 99.06% in Oct 2026? 1 RCA needed below it, 1 to review')
  })

  it('drops the subject when the surface names it', () => {
    expect(whyName({ ...base, subjectName: undefined, display: { state: 'available' } })).toBe('Why is 99.06% in Oct 2026?')
  })
})
