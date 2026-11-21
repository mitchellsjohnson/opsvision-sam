import type { SummaryDisplay } from './rcaState'

/** An exec summary's limit, in code points of the NFC-normalized text. */
export const RCA_MAX = 280
export const RCA_LINKS_MAX = 25
/** Titles and URLs of all links together, in UTF-8 bytes. */
export const RCA_LINKS_BYTES = 16384
/** A link title's limit, in code points. */
export const RCA_TITLE_MAX = 80
/** Links a card shows before `Show all`. */
export const RCA_LINKS_SHOWN = 3

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Code points of the text after NFC normalization: what the counter shows and the server's runes. */
export function codePoints(text: string): number {
  return [...text.normalize('NFC')].length
}

/**
 * The URL to put in an `href`, or null when it may not be linked: https only
 * (any case; returned with a lowercase scheme), a host, no user info, no
 * whitespace, at most 2,048 bytes.
 */
export function safeHref(url: string): string | null {
  if (url === '' || /\s/.test(url) || new TextEncoder().encode(url).length > 2048) return null
  if (!/^https:\/\//i.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return null
  return `https:${url.slice('https:'.length)}`
}

/** The link's host as `URL.hostname`, so internationalized hosts show as punycode; '' when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** The note cut at `max` code points plus an ellipsis. */
export function rcaExcerpt(text: string, max = 60): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('').trimEnd()}…`
}

/** `45m`, `3h 36m`, `1d 2h 05m`, as the API writes durations. */
export function durationText(minutes: number): string {
  const m = Math.round(Math.max(minutes, 0))
  const days = Math.floor(m / 1440)
  const hours = Math.floor(m / 60) % 24
  const mins = String(m % 60)
  if (days > 0) return `${days}d ${hours}h ${mins.padStart(2, '0')}m`
  if (hours > 0) return `${hours}h ${mins.padStart(2, '0')}m`
  return `${mins}m`
}

function utcParts(iso: string): { day: string; time: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return {
    day: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
    time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
  }
}

/** `Oct 3, 14:05–18:15 UTC`; across days `Sep 30, 23:05 – Oct 1, 00:50 UTC`; '' without a start. */
export function timeRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = start ? utcParts(start) : null
  if (!s) return ''
  const e = end ? utcParts(end) : null
  if (!e) return `From ${s.day}, ${s.time} UTC`
  if (e.day === s.day) return `${s.day}, ${s.time}–${e.time} UTC`
  return `${s.day}, ${s.time} – ${e.day}, ${e.time} UTC`
}

/** `Nov 3` (UTC) for the byline. */
export function noteDate(iso: string): string {
  return utcParts(iso)?.day ?? ''
}

/** An incident source as a label: `status-page` → `Status page`. */
export function sourceLabel(source: string): string {
  const words = source.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : source
}

/** UTF-8 bytes of every link's title and URL together (the 16 KB budget). */
export function linksBytes(links: readonly { title: string; url: string }[]): number {
  const enc = new TextEncoder()
  return links.reduce((n, l) => n + enc.encode(l.title).length + enc.encode(l.url).length, 0)
}

export interface PastedLinks {
  /** One row per valid, new https line, titled from its URL. */
  added: { title: string; url: string }[]
  /** Every line not added (not https, or already listed), as pasted (trimmed), in order. */
  rejected: string[]
  /** Lines that are not https links. */
  notHttps: string[]
  /** Lines repeating a listed (or just-added) link, with that link's title. */
  duplicates: { line: string; title: string }[]
  /** Which limit stopped the rest from being added: 25 links, or the 16 KB budget. */
  limit: 'count' | 'bytes' | null
}

/** A pasted link's title: its last path segment (`INC-2041`, `88412`), else its host. */
function pastedTitle(href: string): string {
  const u = new URL(href)
  const last = u.pathname.split('/').filter(Boolean).at(-1) ?? ''
  let title = last
  try {
    title = decodeURIComponent(last)
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  title = title.trim() || u.hostname
  return [...title].slice(0, RCA_TITLE_MAX).join('')
}

/**
 * `Paste links` (spec §10.3): one URL per line. Blank lines are ignored;
 * https URLs not already listed become rows until 25 links or the 16 KB
 * budget; everything else is reported.
 */
export function parsePastedLinks(text: string, existing: readonly { title: string; url: string }[]): PastedLinks {
  const seen = new Map(existing.map((l) => [safeHref(l.url.trim()) ?? l.url.trim(), l.title] as const))
  const added: PastedLinks['added'] = []
  const rejected: string[] = []
  const notHttps: string[] = []
  const duplicates: PastedLinks['duplicates'] = []
  let limit: PastedLinks['limit'] = null
  let bytes = linksBytes(existing)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const href = safeHref(line)
    if (!href) {
      rejected.push(line)
      notHttps.push(line)
      continue
    }
    const listed = seen.get(href)
    if (listed !== undefined) {
      rejected.push(line)
      duplicates.push({ line, title: listed })
      continue
    }
    if (limit) continue
    if (existing.length + added.length >= RCA_LINKS_MAX) {
      limit = 'count'
      continue
    }
    const link = { title: pastedTitle(href), url: href }
    const size = linksBytes([link])
    if (bytes + size > RCA_LINKS_BYTES) {
      limit = 'bytes'
      continue
    }
    bytes += size
    seen.set(href, link.title)
    added.push(link)
  }
  return { added, rejected, notHttps, duplicates, limit }
}

export interface WhyNameInput {
  summary?: SummaryDisplay
  /** Omit when the surface already names the subject (or, on company surfaces, the metric). */
  subjectName?: string
  valueDisplay: string
  periodLabel: string
}

/** The Why trigger's accessible name (spec §10.1); hints belong in `aria-description`. */
export function whyName({ summary, subjectName, valueDisplay, periodLabel }: WhyNameInput): string {
  const subject = subjectName ? `${subjectName} ` : ''
  const question = `Why is ${subject}${valueDisplay} in ${periodLabel}?`
  if (!summary) return question
  if (summary.state === 'missing') return `${question} ${summary.canEdit ? 'Exec summary needed' : 'No exec summary yet'}`
  const written = `Why ${subject}is ${valueDisplay} in ${periodLabel}: exec summary by ${summary.author}`
  return summary.state === 'stale' && summary.canEdit ? `${written}. Exec summary may be out of date` : written
}
