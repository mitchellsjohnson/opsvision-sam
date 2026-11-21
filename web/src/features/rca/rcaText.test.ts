import { describe, expect, it } from 'vitest'
import * as rcaText from './rcaText'
import {
  codePoints,
  durationText,
  hostOf,
  linksBytes,
  noteDate,
  parsePastedLinks,
  RCA_LINKS_BYTES,
  RCA_LINKS_MAX,
  rcaExcerpt,
  safeHref,
  sourceLabel,
  timeRange,
  whyName,
} from './rcaText'

describe('limits', () => {
  it('allows 25 links in 16 KB, and has no roll-up tag any more', () => {
    expect(RCA_LINKS_MAX).toBe(25)
    expect(RCA_LINKS_BYTES).toBe(16384)
    expect('rollupTag' in rcaText).toBe(false)
  })
})

describe('parsePastedLinks', () => {
  it('adds https lines titled by their last path segment or host, and reports the rest', () => {
    const pasted = [
      'https://tracker.example/browse/INC-2041',
      '  https://oncall.example/incidents/88412  ',
      'http://x',
      'javascript:alert(1)',
      '',
      'https://tracker.example/browse/INC-2041',
      'HTTPS://status.example',
    ].join('\n')
    const { added, rejected, notHttps, duplicates, limit } = parsePastedLinks(pasted, [])
    expect(added).toEqual([
      { title: 'INC-2041', url: 'https://tracker.example/browse/INC-2041' },
      { title: '88412', url: 'https://oncall.example/incidents/88412' },
      { title: 'status.example', url: 'https://status.example' },
    ])
    expect(rejected).toEqual(['http://x', 'javascript:alert(1)', 'https://tracker.example/browse/INC-2041'])
    expect(notHttps).toEqual(['http://x', 'javascript:alert(1)'])
    expect(duplicates).toEqual([{ line: 'https://tracker.example/browse/INC-2041', title: 'INC-2041' }])
    expect(limit).toBeNull()
  })

  it('rejects links already in the list and user-info URLs', () => {
    const { added, rejected } = parsePastedLinks('https://docs.example/a\nhttps://user:pw@docs.example/b', [
      { title: 'A', url: 'https://docs.example/a' },
    ])
    expect(added).toEqual([])
    expect(rejected).toEqual(['https://docs.example/a', 'https://user:pw@docs.example/b'])
    // A repeat of a listed link is named by the title it already has.
    expect(parsePastedLinks('https://docs.example/a', [{ title: 'A', url: 'https://docs.example/a' }]).duplicates).toEqual([
      { line: 'https://docs.example/a', title: 'A' },
    ])
  })

  it('decodes the title, drops a trailing slash and cuts it to 80 characters', () => {
    const long = 'x'.repeat(90)
    const { added } = parsePastedLinks(`https://docs.example/pm/Queue%20saturation/\nhttps://docs.example/${long}`, [])
    expect(added[0]!.title).toBe('Queue saturation')
    expect([...added[1]!.title]).toHaveLength(80)
  })

  it('stops at 25 links', () => {
    const existing = Array.from({ length: 24 }, (_, i) => ({ title: `L${i}`, url: `https://docs.example/${i}` }))
    const { added, limit } = parsePastedLinks('https://a.example/1\nhttps://a.example/2\nhttps://a.example/3', existing)
    expect(added).toHaveLength(1)
    expect(limit).toBe('count')
  })

  it('stops before the 16 KB budget', () => {
    const big = (n: number) => `https://docs.example/${n}/${'a'.repeat(2000)}`
    const pasted = Array.from({ length: 9 }, (_, i) => big(i)).join('\n')
    const { added, limit } = parsePastedLinks(pasted, [])
    expect(linksBytes(added)).toBeLessThanOrEqual(RCA_LINKS_BYTES)
    // Each link is 2,023 bytes of URL and an 80-character title: 7 fit in 16,384.
    expect(added.length).toBe(7)
    expect(limit).toBe('bytes')
  })
})

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
  const base = { subjectName: 'Uptime', valueDisplay: '99.06%', periodLabel: 'Oct 2026', attribution: true }
  const written = { state: 'written' as const, excerpt: 'x', author: 'Avery Admin', canEdit: false }

  it('names each state of spec §10.1', () => {
    expect(whyName({ ...base, subjectName: 'Webhooks' })).toBe('Why is Webhooks 99.06% in Oct 2026?')
    expect(whyName({ ...base, summary: { state: 'missing', canEdit: true } })).toBe(
      'Why is Uptime 99.06% in Oct 2026? Exec summary needed',
    )
    expect(whyName({ ...base, summary: { state: 'missing', canEdit: false } })).toBe(
      'Why is Uptime 99.06% in Oct 2026? No exec summary yet',
    )
    expect(whyName({ ...base, summary: written })).toBe('Why Uptime is 99.06% in Oct 2026: exec summary by Avery Admin')
    expect(whyName({ ...base, summary: { ...written, state: 'stale', canEdit: true } })).toBe(
      'Why Uptime is 99.06% in Oct 2026: exec summary by Avery Admin. Exec summary may be out of date',
    )
    expect(whyName({ ...base, summary: { ...written, state: 'stale' } })).toBe(
      'Why Uptime is 99.06% in Oct 2026: exec summary by Avery Admin',
    )
  })

  it('drops the subject when the surface names it', () => {
    expect(whyName({ ...base, subjectName: undefined })).toBe('Why is 99.06% in Oct 2026?')
    expect(whyName({ ...base, subjectName: undefined, summary: written })).toBe('Why is 99.06% in Oct 2026: exec summary by Avery Admin')
  })
})
