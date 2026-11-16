import { useItemKinds, useOrgLevels } from '../../api/queries'
import type { components } from '../../api/schema'
import { nounForms, type NounForms } from './logic/nouns'

type Metric = components['schemas']['Metric']

/** The metric's item kind as a noun (`service` / `services`); `item` until known. */
export function useItemNoun(metric: Metric | undefined): NounForms {
  const kinds = useItemKinds()
  const kindId = metric?.reportedAt.find((s) => s.kind === 'item_kind')?.id
  return nounForms(kindId ? kinds.data?.find((k) => k.id === kindId)?.name : undefined, 'item')
}

/** The org level at `depth` as a noun (`segment` / `segments`); `unit` until known. */
export function useLevelNoun(depth: number): NounForms {
  const levels = useOrgLevels()
  return nounForms(levels.data?.find((l) => l.depth === depth)?.name, 'unit')
}
