import { describe, expect, it } from 'vitest'
import { acmeItems, acmeUnits, recordTypes, recordsTemplates } from '../../../test/recordsFixtures'
import { defectsInspection, epicsInspection, wizardVersions } from '../../../test/wizardFixtures'
import {
  NEW_TYPE,
  answersFrom,
  chooseType,
  confidenceOf,
  draftContent,
  initialState,
  missingRequired,
  offeredPresets,
  presetChoices,
  productQuestions,
  samplesFor,
  setNewType,
  stateFromTemplate,
  successText,
  templateFrom,
  typePriorities,
  uniqueTemplate,
  valueRows,
  type WizardState,
} from './wizardModel'

function defects(): WizardState {
  return initialState({
    result: defectsInspection(),
    recordTypes,
    units: acmeUnits,
    items: acmeItems,
    templates: recordsTemplates(),
  })
}

describe('initialState', () => {
  it('starts from the guesses: suggested type, columns, value meanings, product matches', () => {
    const s = defects()
    expect(s.recordType).toBe('defect')
    expect(s.source).toBe('tracker')
    expect(s.templateName).toBe('Defects export 2')
    expect(s.columns).toMatchObject({
      externalId: 'Issue key',
      subjectKey: 'Product',
      title: 'Summary',
      priority: 'Priority',
      status: 'Status',
      createdAt: 'Created',
      completedAt: 'Resolved',
      dueAt: 'Due date',
    })
    // A custom field whose name is a column header is matched to it.
    expect(s.attributes).toEqual({ customerTicket: 'Customer ticket' })
    expect(s.maps.priority).toEqual({ High: 'P2', Medium: 'P3', Highest: 'P1', Low: 'P4', '': 'none' })
    expect(s.maps.state).toMatchObject({ Open: 'open', 'Won’t Do': 'cancelled', Closed: 'done' })
    // Confident and close matches are preselected; values already linked, and parent units, are not.
    expect(s.answers.subjects).toEqual({ 'Checkout Svc': 'to:checkout', Identity: 'to:identity' })
    expect(s.answers.dateOrder).toBe('')
    expect(s.presets).toBeNull()
  })

  it('offers a new type, named from the file, when no type fits', () => {
    const result = defectsInspection()
    result.inspection.suggestedType = ''
    const s = initialState({ result, recordTypes, units: acmeUnits, items: acmeItems, templates: [] })
    expect(s.recordType).toBe(NEW_TYPE)
    expect(s.newType).toEqual({ name: 'Defect', priorities: 'P1, P2, P3, P4' })
    expect(s.templateName).toBe('Defects export')
  })
})

describe('templateFrom', () => {
  it('builds the template: columns, value maps, date formats in the chosen order, custom fields', () => {
    const s = { ...defects(), answers: { ...defects().answers, dateOrder: 'dmy' as const } }
    expect(templateFrom(s)).toEqual({
      name: 'Defects export 2',
      recordType: 'defect',
      source: 'tracker',
      file: { format: 'csv', headerRow: 1 },
      fullExport: false,
      fields: {
        externalId: { column: 'Issue key' },
        subjectKey: { column: 'Product' },
        title: { column: 'Summary' },
        priority: { column: 'Priority', map: { High: 'P2', Medium: 'P3', Highest: 'P1', Low: 'P4' }, default: 'none' },
        status: { column: 'Status' },
        state: {
          column: 'Status',
          map: { '*': 'open', Open: 'open', Done: 'done', 'In Review': 'open', 'Won’t Do': 'cancelled', Closed: 'done' },
        },
        createdAt: { column: 'Created', dateFormats: ['02/01/2006'] },
        completedAt: { column: 'Resolved', dateFormats: ['02/01/2006'] },
        dueAt: { column: 'Due date', dateFormats: ['01/02/2006'] },
      },
      attributes: { customerTicket: { column: 'Customer ticket' } },
    })
  })

  it('reads ambiguous dates month first until answered', () => {
    expect(templateFrom(defects()).fields.createdAt).toEqual({ column: 'Created', dateFormats: ['01/02/2006'] })
  })

  it('leaves out fields with no column; without a status column every record is open', () => {
    const s = defects()
    const t = templateFrom({ ...s, columns: { ...s.columns, status: '', title: '', dueAt: '' } })
    expect(t.fields.title).toBeUndefined()
    expect(t.fields.dueAt).toBeUndefined()
    expect(t.fields.status).toBeUndefined()
    expect(t.fields.state).toEqual({ constant: 'open' })
  })

  it('maps blank cells to the chosen meaning', () => {
    const s = defects()
    const t = templateFrom({ ...s, maps: { ...s.maps, priority: { ...s.maps.priority, '': 'P4' }, state: { ...s.maps.state, '': 'done' } } })
    expect(t.fields.priority?.default).toBe('P4')
    expect(t.fields.state?.default).toBe('done')
    expect(t.fields.state?.map?.['']).toBeUndefined()
  })

  it('uses a new type’s key and keeps only meanings its priorities have', () => {
    const fresh = chooseType(defects(), NEW_TYPE, recordTypes)
    expect(fresh.newType.priorities).toBe('P1, P2, P3, P4')
    expect(templateFrom(setNewType(fresh, { name: 'Support incident' }, recordTypes)).recordType).toBe('support_incident')

    const renamed = setNewType(fresh, { name: 'Incident', priorities: 'Sev1, Sev2' }, recordTypes)
    expect(typePriorities(renamed, recordTypes)).toEqual(['Sev1', 'Sev2'])
    expect(renamed.maps.priority).toEqual({ High: '', Medium: '', Highest: '', Low: '', '': 'none' })
    expect(templateFrom(renamed).fields.priority).toEqual({ column: 'Priority', default: 'none' })
  })
})

describe('answersFrom', () => {
  it('turns the choices into API answers', () => {
    const s = defects()
    const answers = answersFrom({
      ...s,
      answers: {
        ...s.answers,
        subjects: { 'Checkout Svc': 'to:checkout', 'Pmt Gateway': 'ignore', Commerce: 'shared:commerce', Identity: '' },
        dateOrder: 'dmy',
      },
    })
    expect(answers).toEqual({
      sourceKeys: { 'Checkout Svc': 'checkout', Commerce: 'commerce' },
      ignoreValues: ['Pmt Gateway'],
      createShared: ['commerce'],
      dateOrder: 'dmy',
    })
  })
})

describe('columns', () => {
  it('rates a guess "likely" from 0.7, "check" below, and a changed column as the admin’s choice', () => {
    const { guesses } = defectsInspection().inspection
    expect(confidenceOf('externalId', 'Issue key', guesses)).toBe('likely')
    expect(confidenceOf('dueAt', 'Due date', guesses)).toBe('check')
    expect(confidenceOf('externalId', 'Summary', guesses)).toBe('chosen')
    expect(confidenceOf('url', '', guesses)).toBe('none')
  })

  it('shows up to three distinct sample values from the column', () => {
    const { inspection } = defectsInspection()
    expect(samplesFor('externalId', 'Issue key', inspection)).toEqual(['CHK-101', 'CHK-102', 'BIL-7'])
    expect(samplesFor('externalId', 'Priority', inspection)).toEqual(['High', 'Highest', 'Medium'])
    expect(samplesFor('externalId', 'Resolved', inspection)).toEqual(['03/09/2026', '03/07/2026', '03/10/2026'])
    expect(samplesFor('externalId', '', inspection)).toEqual([])
  })

  it('lists the required fields that have no column', () => {
    const s = defects()
    expect(missingRequired(s)).toEqual([])
    expect(missingRequired({ ...s, columns: { ...s.columns, subjectKey: '', createdAt: '' } })).toEqual(['subjectKey', 'createdAt'])
  })
})

describe('values', () => {
  it('lists the file’s values with counts; another column falls back to the sample rows', () => {
    const s = defects()
    const { inspection } = defectsInspection()
    expect(valueRows('priority', s, inspection)).toEqual({
      fromSamples: false,
      rows: [
        { value: 'High', count: 40 },
        { value: 'Medium', count: 30 },
        { value: 'Highest', count: 12 },
        { value: 'Low', count: 9 },
        { value: '', count: 3 },
      ],
    })
    const moved = { ...s, columns: { ...s.columns, priority: 'Summary' } }
    expect(valueRows('priority', moved, inspection).fromSamples).toBe(true)
    expect(valueRows('priority', moved, inspection).rows[0]).toEqual({ value: 'Refund total rounds', count: 1 })
  })
})

describe('productQuestions', () => {
  it('splits values already linked from those to ask about, with parent units flagged', () => {
    const { linked, asks } = productQuestions(defectsInspection().subjects, acmeUnits, acmeItems)
    expect(linked).toEqual([{ value: 'Billing', rows: 9, name: 'Billing' }])
    expect(asks).toEqual([
      { value: 'Checkout Svc', rows: 14, suggestedId: 'checkout', candidates: ['checkout'] },
      { value: 'Identity', rows: 20, suggestedId: 'identity', candidates: ['identity'] },
      { value: 'Pmt Gateway', rows: 3, suggestedId: '', candidates: ['billing'] },
      { value: 'Commerce', rows: 2, suggestedId: '', candidates: [], parentUnitId: 'commerce' },
    ])
  })
})

describe('presets', () => {
  const epics = () =>
    initialState({ result: epicsInspection(), recordTypes, units: acmeUnits, items: acmeItems, templates: [] })

  it('offers the presets the mapped columns support', () => {
    expect(offeredPresets(defects(), recordTypes)).toEqual(['on_time', 'weighted_open', 'average_age', 'count'])
    // Epics have no priorities.
    expect(offeredPresets(epics(), recordTypes)).toEqual(['on_time', 'average_age', 'count'])
  })

  it('preselects a preset whose measures the methodology already has, plural keys included', () => {
    const content = wizardVersions()[0]!.content
    const choices = presetChoices(content, 'epic', ['on_time', 'average_age', 'count'])
    expect(choices).toEqual([
      { id: 'on_time', keyPrefix: 'epics', existing: ['epics_committed', 'epics_on_time'] },
      { id: 'average_age', keyPrefix: 'epic', existing: [] },
      { id: 'count', keyPrefix: 'epic', existing: [] },
    ])
  })

  it('derives the existing measures in the draft, without a second metric for them', () => {
    const content = wizardVersions()[0]!.content
    const next = draftContent(content, [{ id: 'on_time', keyPrefix: 'epics' }], {
      recordType: 'epic',
      recordTypeName: 'Epic',
      priorities: [],
      statusKeys: ['G', 'Y', 'R'],
      reportedAt: [{ kind: 'level', id: 'product' }],
    })
    expect(next.measures.find((m) => m.key === 'epics_committed')).toMatchObject({
      name: 'Epics committed',
      source: 'derived',
      derive: { recordType: 'epic', op: 'commitments', outcome: 'resolved' },
    })
    expect(next.measures.find((m) => m.key === 'epics_on_time')?.derive).toMatchObject({ recordType: 'epic', outcome: 'met' })
    expect(next.metrics.map((m) => m.key)).toEqual(['on_time_pct'])
  })

  it('adds the metric when none uses the preset’s measures', () => {
    const next = draftContent({ categories: [{ id: 'q', name: 'Quality', order: 1 }], measures: [], metrics: [] }, [{ id: 'weighted_open', keyPrefix: 'defect' }], {
      recordType: 'defect',
      recordTypeName: 'Defect',
      priorities: ['P1', 'P2', 'P3', 'P4'],
      statusKeys: ['G', 'Y', 'R'],
      reportedAt: [{ kind: 'level', id: 'product' }],
    })
    expect(next.measures.map((m) => m.key)).toEqual(['defect_points_sum', 'defect_days'])
    expect(next.measures[0]?.derive?.weights).toEqual({ P1: 64, P2: 16, P3: 4, P4: 2, none: 1 })
    expect(next.metrics).toHaveLength(1)
    expect(next.metrics[0]).toMatchObject({ key: 'defect_weighted_score', reportedAt: [{ kind: 'level', id: 'product' }] })
  })
})

describe('template mode', () => {
  it('starts from the saved template, with the file’s samples and date formats', () => {
    const saved = recordsTemplates()[0]!
    const s = stateFromTemplate({ template: saved, result: defectsInspection(), recordTypes })
    expect(s.recordType).toBe('defect')
    expect(s.templateName).toBe('Defects export')
    expect(s.columns).toMatchObject({ externalId: 'Issue key', subjectKey: 'Product', priority: 'Priority', createdAt: 'Created' })
    expect(s.columns.title).toBe('')
    expect(s.maps.priority).toMatchObject({ Highest: 'P1', High: 'P2' })
    const t = templateFrom(s)
    expect(t.name).toBe('Defects export')
    expect(t.fields.createdAt).toEqual({ column: 'Created', dateFormats: ['01/02/2006'] })
  })
})

describe('copy', () => {
  it('names a unique template', () => {
    expect(uniqueTemplate('Defects export', recordsTemplates())).toEqual({ id: 'defects-export-2', name: 'Defects export 2' })
    expect(uniqueTemplate('Incidents export', recordsTemplates())).toEqual({ id: 'incidents-export', name: 'Incidents export' })
  })

  it('celebrates in plain words', () => {
    expect(successText('Defect', 12)).toBe('Your defects are in. 12 metrics updated.')
    expect(successText('Epic', 1)).toBe('Your epics are in. 1 metric updated.')
    expect(successText('Defect', 0)).toBe('Your defects are in. No scorecard numbers changed.')
    expect(successText('Epic', 12, { waitsForPublish: true })).toBe('Your epics are in. 12 metrics update when you publish.')
  })
})
