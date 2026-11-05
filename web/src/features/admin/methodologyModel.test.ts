import { describe, expect, it } from 'vitest'
import type { MethodologyVersion } from '../../api/queries'
import { countBySeverity, filterFindings, parseTemplateBody, sampleRow } from './importModel'
import {
  buildBands,
  conditionBands,
  elseStatus,
  groupDiff,
  metricIndex,
  parseAdvanced,
  parseDiffPath,
  prettyValue,
  underPath,
  versionInForce,
  withRuleType,
} from './methodologyModel'

const version = (id: string, status: string, effectiveFrom: string) =>
  ({ id, status, effectiveFrom, name: id }) as MethodologyVersion

describe('methodologyModel', () => {
  it('splits bands into condition rows and the else band, and rebuilds them with else last', () => {
    const bands = [
      { status: 'G', op: '>=', value: 90 },
      { status: 'R', op: '', value: 0 },
      { status: 'Y', op: '>=', value: 70 },
    ]
    expect(conditionBands(bands).map((b) => b.status)).toEqual(['G', 'Y'])
    expect(elseStatus(bands)).toBe('R')
    expect(buildBands(conditionBands(bands), 'R')).toEqual([
      { status: 'G', op: '>=', value: 90 },
      { status: 'Y', op: '>=', value: 70 },
      { status: 'R', op: '', value: 0 },
    ])
    expect(elseStatus(undefined)).toBe('')
  })

  it('keeps bands and per-subject bands when the rule type changes', () => {
    const rule = { type: 'bands' as const, bands: [{ status: 'G', op: '>=', value: 1 }], perSubject: [{ subjectId: 'a', bands: [] }] }
    const change = withRuleType(rule, 'change', ['G', 'Y', 'R'])
    expect(change).toMatchObject({ type: 'change', compare: 'prior_period', bands: rule.bands, perSubject: rule.perSubject })
    const scale = withRuleType(change, 'scale', ['G', 'Y', 'R'])
    expect(scale.scale).toEqual([{ status: 'G', min: 0 }])
    expect(scale.bands).toBeUndefined()
  })

  it('parses Advanced JSON and explains what is wrong', () => {
    expect(parseAdvanced('{"targets":[],"perSubject":[]}').ok).toBe(true)
    expect(parseAdvanced('{}')).toEqual({ ok: true, value: { targets: [], perSubject: [] } })
    const bad = (text: string) => {
      const r = parseAdvanced(text)
      return r.ok ? '' : r.error
    }
    expect(bad('{')).toMatch(/Not valid JSON/)
    expect(bad('[]')).toMatch(/Expected an object/)
    expect(bad('{"other":1}')).toMatch(/Unknown field "other"/)
    expect(bad('{"targets":{}}')).toMatch(/"targets" must be a list/)
    expect(bad('{"perSubject":[1]}')).toMatch(/Every entry in "perSubject"/)
  })

  it('maps validation paths to metrics and parts of them', () => {
    const errors = [
      { path: 'metrics[1].formula', message: 'a' },
      { path: 'metrics[1].rule.bands[0].status', message: 'b' },
      { path: 'metrics[10].formula', message: 'c' },
      { path: 'metrics[1]', message: 'd' },
    ]
    expect(underPath(errors, 'metrics[1]')).toEqual([
      { rest: '.formula', message: 'a' },
      { rest: '.rule.bands[0].status', message: 'b' },
      { rest: '', message: 'd' },
    ])
    expect(metricIndex('metrics[12].rule')).toBe(12)
    expect(metricIndex('categories[0].id')).toBeUndefined()
  })

  it('groups the API diff into added, removed and changed metrics', () => {
    expect(parseDiffPath('metrics[a_b].rule')).toEqual({ key: 'a_b', field: 'rule' })
    expect(parseDiffPath('metrics[a_b]')).toEqual({ key: 'a_b', field: '' })
    expect(parseDiffPath('other')).toBeUndefined()
    const g = groupDiff([
      { path: 'metrics[n]', kind: 'added', after: { key: 'n' } },
      { path: 'metrics[r]', kind: 'removed', before: { key: 'r' } },
      { path: 'metrics[c].formula', kind: 'changed', before: 'a', after: 'b' },
      { path: 'metrics[c].rule', kind: 'changed', before: { type: 'bands' }, after: { type: 'scale' } },
    ])
    expect(g.added.map((x) => x.key)).toEqual(['n'])
    expect(g.removed.map((x) => x.key)).toEqual(['r'])
    expect(g.changed).toEqual([
      {
        key: 'c',
        fields: [
          { field: 'formula', before: 'a', after: 'b' },
          { field: 'rule', before: { type: 'bands' }, after: { type: 'scale' } },
        ],
      },
    ])
  })

  it('pretty-prints structured values and names empty ones', () => {
    expect(prettyValue({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', structured: true })
    expect(prettyValue('')).toEqual({ text: '(empty)', structured: false })
    expect(prettyValue(undefined)).toEqual({ text: '(none)', structured: false })
    expect(prettyValue(3)).toEqual({ text: '3', structured: false })
  })

  it('picks the version in force as the latest effective one that is published or superseded', () => {
    const vs = [
      version('draft', 'draft', ''),
      version('old', 'superseded', '2025-M01'),
      version('new', 'published', '2026-M07'),
      version('mid', 'superseded', '2026-M01'),
    ]
    expect(versionInForce(vs)?.id).toBe('new')
    expect(versionInForce([version('d', 'draft', '')])).toBeUndefined()
  })
})

describe('importModel', () => {
  it('counts and filters findings by severity', () => {
    const f = [
      { severity: 'error', sheet: 's', cell: 'A1', message: 'x' },
      { severity: 'warn', sheet: 's', cell: 'A2', message: 'y' },
      { severity: 'warn', sheet: 's', cell: 'A3', message: 'z' },
    ] as const
    expect(countBySeverity(f)).toEqual({ all: 3, error: 1, warn: 2, info: 0 })
    expect(filterFindings(f, 'warn')).toHaveLength(2)
    expect(filterFindings(f, 'all')).toHaveLength(3)
  })

  it('describes each kind of sample change', () => {
    expect(sampleRow({ kind: 'data_point', measureKey: 'm', subjectId: 's', period: '2026-M01', value: 5 }).change).toBe('5')
    expect(sampleRow({ kind: 'data_point', measureKey: 'm', naReason: 'none' }).change).toBe('Not applicable: none')
    expect(sampleRow({ kind: 'override', metricKey: 'x', status: 'R' }).change).toBe('status R')
    expect(sampleRow({ kind: 'version_text', metricKey: 'x', field: 'notes', text: 't' })).toMatchObject({
      kind: 'Methodology text',
      change: 'notes: t',
    })
  })

  it('accepts only a JSON object as a template body', () => {
    expect(parseTemplateBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseTemplateBody('[1]').ok).toBe(false)
    expect(parseTemplateBody('nope').ok).toBe(false)
  })
})
