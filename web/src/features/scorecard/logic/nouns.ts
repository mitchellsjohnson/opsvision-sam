export interface NounForms {
  one: string
  many: string
}

const FALLBACK: Record<'item' | 'unit', NounForms> = {
  item: { one: 'item', many: 'items' },
  unit: { one: 'unit', many: 'units' },
}

/** Endings that read as singular even though they end in `s`: `class`, `status`, `analysis`. */
const SINGULAR_S = /(ss|us|is)$/

function plural(one: string): string {
  if (/[^aeiou]y$/.test(one)) return `${one.slice(0, -1)}ies`
  if (/(s|x|ch|sh)$/.test(one)) return `${one}es`
  return `${one}s`
}

function singular(many: string): string {
  if (many.endsWith('ies')) return `${many.slice(0, -3)}y`
  if (/(sses|xes|ches|shes)$/.test(many)) return many.slice(0, -2)
  return many.slice(0, -1)
}

/**
 * A kind or level name as a lowercased noun in both numbers: `Repositories`
 * and `Repository` both give `repository` / `repositories`. Unknown names
 * fall back to `item` or `unit`.
 */
export function nounForms(name: string | undefined, fallback: 'item' | 'unit'): NounForms {
  const word = name?.trim().toLowerCase() ?? ''
  if (!word) return FALLBACK[fallback]
  if (word.endsWith('s') && !SINGULAR_S.test(word)) {
    const one = singular(word)
    return one ? { one, many: word } : FALLBACK[fallback]
  }
  return { one: word, many: plural(word) }
}

/** `1 service`, `3 services`. */
export function countNoun(n: number, forms: NounForms): string {
  return `${n} ${n === 1 ? forms.one : forms.many}`
}
