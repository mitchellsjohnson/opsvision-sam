import { describe, expect, it } from 'vitest'
import { LAST_ORG_KEY, rememberOrganization, resolveOrganization } from './organization'

function storage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
    data,
  }
}

describe('resolveOrganization', () => {
  it('prefers ?organization= and does not write storage', () => {
    const s = storage({ [LAST_ORG_KEY]: 'org_old' })
    expect(resolveOrganization('?organization=org_new', s)).toBe('org_new')
    expect(s.data[LAST_ORG_KEY]).toBe('org_old')
  })

  it('remembers an organization on request', () => {
    const s = storage()
    rememberOrganization('org_new', s)
    expect(s.data[LAST_ORG_KEY]).toBe('org_new')
  })

  it('falls back to the last used organization', () => {
    expect(resolveOrganization('', storage({ [LAST_ORG_KEY]: 'org_old' }))).toBe('org_old')
  })

  it('returns undefined when there is none', () => {
    expect(resolveOrganization('?x=1', storage())).toBeUndefined()
  })
})
