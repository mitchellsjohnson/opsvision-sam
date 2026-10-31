import { describe, expect, it } from 'vitest'
import { parseEntryValue, parsePaste } from './pasteParser'

const value = (n: number) => ({ kind: 'value', value: n })

describe('parseEntryValue', () => {
  it.each([
    ['84%', 84],
    ['1,234', 1234],
    [' 12 ', 12],
    ['$10k', 10000],
    ['-5', -5],
    ['12', 12],
    ['0', 0],
    ['3.5', 3.5],
    ['.5', 0.5],
    ['1,234.56', 1234.56],
    ['1,234,567', 1234567],
    ['2k', 2000],
    ['2K', 2000],
    ['1.2k', 1200],
    ['1.1k', 1100],
    ['3m', 3_000_000],
    ['3M', 3_000_000],
    ['$1.5M', 1_500_000],
    ['-$5', -5],
    ['$-5', -5],
    ['+7', 7],
    ['\u22125', -5],
  ])('%j parses to %d', (raw, expected) => {
    expect(parseEntryValue(raw)).toEqual(value(expected))
  })

  it('treats blank text as empty', () => {
    expect(parseEntryValue('')).toEqual({ kind: 'empty' })
    expect(parseEntryValue('   ')).toEqual({ kind: 'empty' })
  })

  it('recognizes not applicable', () => {
    expect(parseEntryValue('n/a')).toEqual({ kind: 'na' })
    expect(parseEntryValue('N/A')).toEqual({ kind: 'na' })
    expect(parseEntryValue(' na ')).toEqual({ kind: 'na' })
  })

  it.each(['abc', '1.2.3', '3,4', '1,23,456', '12,34', '--5', '$', '%', 'k', '1e5', '1 2', '5kk', '12abc', '$$5', '-$-5'])(
    '%j is an error with a message',
    (raw) => {
      const result = parseEntryValue(raw)
      expect(result.kind).toBe('error')
      if (result.kind === 'error') expect(result.message.length).toBeGreaterThan(0)
    },
  )

  it('never turns text into 0', () => {
    expect(parseEntryValue('abc')).not.toEqual(value(0))
    expect(parseEntryValue('')).not.toEqual(value(0))
  })
})

describe('parsePaste', () => {
  it('splits TSV into rows and columns and ignores the trailing newline', () => {
    expect(parsePaste('1\t2\n3\t4\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('handles CRLF and bare CR line endings', () => {
    expect(parsePaste('1\t2\r\n3\t4\r\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(parsePaste('1\r2')).toEqual([['1'], ['2']])
  })

  it('ignores a trailing empty column', () => {
    expect(parsePaste('1\t\n2\t\n')).toEqual([['1'], ['2']])
  })

  it('keeps an empty leading column and blank lines in the middle', () => {
    expect(parsePaste('\tbecause\n\n5')).toEqual([['', 'because'], [''], ['5']])
  })

  it('returns a single cell for plain text and nothing for empty text', () => {
    expect(parsePaste('84%')).toEqual([['84%']])
    expect(parsePaste('')).toEqual([])
    // Copying one empty spreadsheet cell yields just a newline: one blank cell.
    expect(parsePaste('\n')).toEqual([['']])
  })
})
