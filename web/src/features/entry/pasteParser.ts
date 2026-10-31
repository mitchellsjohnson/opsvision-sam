export type EntryValue =
  | { kind: 'empty' }
  | { kind: 'value'; value: number }
  | { kind: 'na' }
  | { kind: 'error'; message: string }

const NOT_APPLICABLE = /^n\/?a$/i

/**
 * Digits with optional thousands groups (`1,234,567`) and decimals, or a bare
 * fraction (`.5`). Commas are only accepted as groups of exactly three digits.
 */
const NUMBER = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d*)?|\\d+(?:\\.\\d*)?|\\.\\d+)'
const ENTRY = new RegExp(`^([+-])?\\$?([+-])?${NUMBER}([km%])?$`, 'i')

const MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000 }

/**
 * Reads one spreadsheet-style cell: `84%` is 84, `1,234` is 1234, `$10k` is
 * 10000, `3m` is 3000000. Blank text is empty, `n/a` is not applicable, and
 * anything else is an error. It never guesses (text is never read as 0).
 */
export function parseEntryValue(raw: string): EntryValue {
  const text = raw.trim().replace(/\u2212/g, '-')
  if (text === '') return { kind: 'empty' }
  if (NOT_APPLICABLE.test(text)) return { kind: 'na' }

  const match = ENTRY.exec(text)
  if (!match) {
    const commasOnly = text.replace(/,/g, '')
    if (text.includes(',') && ENTRY.test(commasOnly)) {
      return { kind: 'error', message: `"${text}" has misplaced commas; use them only between groups of three digits` }
    }
    return { kind: 'error', message: `"${text}" is not a number` }
  }
  const [, lead, trail, digits, suffix] = match
  if (lead && trail) return { kind: 'error', message: `"${text}" has two signs` }

  const magnitude = Number((digits ?? '').replace(/,/g, ''))
  const scaled = magnitude * (MULTIPLIER[(suffix ?? '').toLowerCase()] ?? 1)
  // Trim binary noise such as 1.1 * 1000 = 1100.0000000000002.
  const clean = Number(scaled.toPrecision(15))
  if (!Number.isFinite(clean)) return { kind: 'error', message: `"${text}" is too large` }
  const negative = (lead ?? trail) === '-'
  return { kind: 'value', value: negative && clean !== 0 ? -clean : clean }
}

/**
 * Splits pasted spreadsheet text (tab-separated columns, CR/LF/CRLF rows)
 * into rows of cells. The newline that ends the last row and an empty
 * trailing column are ignored; blank cells and blank lines are kept.
 */
export function parsePaste(tsv: string): string[][] {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => {
    const cells = line.split('\t')
    if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
    return cells
  })
}
