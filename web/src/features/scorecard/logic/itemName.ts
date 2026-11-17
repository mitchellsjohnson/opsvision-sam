/** Where an item name splits into its shared prefix and the part that tells siblings apart. */
const SEPARATORS = [' - ', ' – ', ' — ', ' · ', ' / ', ': ']

/** The last index of `sep` in `name` that is neither at the very start nor runs to the very end. */
function lastInside(name: string, sep: string): number {
  for (let i = name.lastIndexOf(sep); i > 0; i = name.lastIndexOf(sep, i - 1)) {
    if (i + sep.length < name.length) return i
  }
  return -1
}

/**
 * Splits an item name so a narrow column can shorten the head and keep the
 * tail (§2.3): at the last separator (the tail keeps it), else, for three or
 * more words, before the last two words; a name of one or two words is all
 * tail. `head + tail` is always the name.
 */
export function splitItemName(name: string): { head: string; tail: string } {
  const at = Math.max(...SEPARATORS.map((s) => lastInside(name, s)))
  if (at > 0) return { head: name.slice(0, at), tail: name.slice(at) }
  const words = /^(.*\S)(\s+\S+\s+\S+)$/.exec(name)
  if (words) return { head: words[1]!, tail: words[2]! }
  return { head: '', tail: name }
}
