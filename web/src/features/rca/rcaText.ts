import type { WhyDisplay } from './rcaState'

/** The note's limit, in code points of the NFC-normalized text. */
export const RCA_MAX = 280
export const RCA_LINKS_MAX = 5
/** Titles and URLs of all links together, in UTF-8 bytes. */
export const RCA_LINKS_BYTES = 4096

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

/** UTF-8 bytes of every link's title and URL together (the 4 KB budget). */
export function linksBytes(links: readonly { title: string; url: string }[]): number {
  const enc = new TextEncoder()
  return links.reduce((n, l) => n + enc.encode(l.title).length + enc.encode(l.url).length, 0)
}

export interface WhyNameInput {
  display: WhyDisplay
  /** Omit when the surface already names the subject. */
  subjectName?: string
  valueDisplay: string
  periodLabel: string
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The Why trigger's accessible name (spec §10.1); hints belong in `aria-description`. */
export function whyName({ display, subjectName, valueDisplay, periodLabel }: WhyNameInput): string {
  const subject = subjectName ? `${subjectName} ` : ''
  const question = `Why is ${subject}${valueDisplay} in ${periodLabel}?`
  switch (display.state) {
    case 'available':
      return question
    case 'needed':
      return display.canEdit ? `${question} RCA needed` : question
    case 'written':
    case 'stale': {
      const written = `Why ${subject}is ${valueDisplay} in ${periodLabel}: RCA by ${display.author}`
      return display.state === 'stale' && display.canEdit ? `${written}. RCA may be out of date` : written
    }
    case 'rollup': {
      if (!display.showCounts) return question
      const { neededBelow: n, staleBelow: s } = display
      if (n > 0) return `${question} ${plural(n, 'RCA', 'RCAs')} needed below it${s > 0 ? `, ${s} to review` : ''}`
      return `${question} ${plural(s, 'RCA', 'RCAs')} to review below it`
    }
  }
}

/** The roll-up tag: `2 needed`, `2 needed · 1 to review`, `1 to review`. */
export function rollupTag(neededBelow: number, staleBelow: number): string {
  const parts = []
  if (neededBelow > 0) parts.push(`${neededBelow} needed`)
  if (staleBelow > 0) parts.push(`${staleBelow} to review`)
  return parts.join(' · ')
}
