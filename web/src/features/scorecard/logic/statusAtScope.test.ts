import { describe, expect, it } from 'vitest'
import { statusAtScope, type ScopeRow } from './statusAtScope'

const scale = [
  { key: 'G', rank: 1 },
  { key: 'Y', rank: 2 },
  { key: 'R', rank: 3 },
]
const child = (v: number | null, status = v === null ? '' : 'G'): ScopeRow => ({
  cells: [{ period: '2026-M10', ytd: false, value: v, status, naReason: '' }],
})
const children = [child(99.63, 'R'), ...Array.from({ length: 8 }, () => child(100)), ...Array.from({ length: 12 }, () => child(null))]
const at = (noun: Parameters<typeof statusAtScope>[0]['noun'], kids = children) =>
  statusAtScope({ scope: { cells: [] }, children: kids, columnKey: '2026-M10', scale, noun })

describe('statusAtScope captions', () => {
  it('names the children by their noun forms', () => {
    expect(at({ one: 'deployment', many: 'deployments' })).toEqual({ status: 'R', caption: 'worst of 9 deployments · 12 not reported' })
  })

  it('still takes the old strings', () => {
    expect(at('services').caption).toBe('worst of 9 services · 12 not reported')
    expect(at('segments').caption).toBe('worst of 9 segments · 12 not reported')
    expect(at('items').caption).toBe('worst of 9 items · 12 not reported')
  })

  it('one reported child reads in the singular', () => {
    expect(at({ one: 'deployment', many: 'deployments' }, [child(100)]).caption).toBe('worst of 1 deployment')
    expect(at('services', [child(100)]).caption).toBe('worst of 1 service')
  })
})
