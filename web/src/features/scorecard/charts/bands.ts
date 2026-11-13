import type { components } from '../../../api/schema'

type Band = components['schemas']['Band']

export interface BandInterval {
  y0: number
  y1: number
  status: string
}

/**
 * The engine's band rule (api/internal/engine/status.go): the first band in
 * order whose condition holds wins, and the band with op '' matches anything.
 * '' when nothing matches.
 */
export function bandStatus(bands: Band[], v: number): string {
  for (const b of bands) {
    switch (b.op) {
      case '':
        return b.status
      case '>=':
        if (v >= b.value) return b.status
        break
      case '>':
        if (v > b.value) return b.status
        break
      case '<=':
        if (v <= b.value) return b.status
        break
      case '<':
        if (v < b.value) return b.status
        break
    }
  }
  return ''
}

/**
 * Splits `domain` at the band thresholds and gives each piece the status the
 * engine would give its midpoint. Adjacent pieces with the same status merge;
 * pieces no band matches are left out.
 */
export function statusIntervals(bands: Band[] | undefined, domain: [number, number]): BandInterval[] {
  if (!bands?.length) return []
  const [lo, hi] = domain
  if (!(hi > lo)) return []
  const cuts = [...new Set(bands.filter((b) => b.op !== '' && b.value > lo && b.value < hi).map((b) => b.value))].sort(
    (a, b) => a - b,
  )
  const edges = [lo, ...cuts, hi]
  const out: BandInterval[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const y0 = edges[i]!
    const y1 = edges[i + 1]!
    const status = bandStatus(bands, (y0 + y1) / 2)
    if (!status) continue
    const last = out[out.length - 1]
    if (last && last.status === status && last.y1 === y0) last.y1 = y1
    else out.push({ y0, y1, status })
  }
  return out
}
