import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ViewRequest } from '../lib/period'
import { apiErrorFromResponse } from './errors'
import type { components } from './schema'
import { useApi } from './useApi'

type Schemas = components['schemas']
export type DataBatchRequest = Schemas['DataBatchRequest']

/** Query keys, shared so mutations and pages invalidate the same entries. */
export const keys = {
  me: ['me'] as const,
  scorecards: ['scorecards'] as const,
  orgUnits: ['orgUnits'] as const,
  view: (sc: string, req: ViewRequest) => ['view', sc, req] as const,
  entry: (sc: string, period: string) => ['entry', sc, period] as const,
}

type Result<T> = { data?: T; error?: unknown; response: Response }

/** Returns the response data; the client already rejects non-2xx with an ApiError. */
async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const result = await request
  if (result.error !== undefined) throw await apiErrorFromResponse(result.response)
  return result.data as T
}

/** The signed-in user, active tenant and role. */
export function useMe() {
  const api = useApi()
  return useQuery({ queryKey: keys.me, queryFn: () => unwrap(api.GET('/me')) })
}

export function useScorecards() {
  const api = useApi()
  return useQuery({ queryKey: keys.scorecards, queryFn: () => unwrap(api.GET('/scorecards')) })
}

export function useOrgUnits() {
  const api = useApi()
  return useQuery({ queryKey: keys.orgUnits, queryFn: () => unwrap(api.GET('/org/units')) })
}

/** The computed scorecard table for the requested columns. */
export function useView(sc: string | undefined, req: ViewRequest) {
  const api = useApi()
  return useQuery({
    queryKey: keys.view(sc ?? '', req),
    enabled: sc !== undefined,
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/view', {
          params: { path: { sc: sc ?? '' }, query: req },
        }),
      ),
  })
}

/** The data-entry grid for one period. */
export function useEntry(sc: string | undefined, period: string) {
  const api = useApi()
  return useQuery({
    queryKey: keys.entry(sc ?? '', period),
    enabled: sc !== undefined,
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/entry', {
          params: { path: { sc: sc ?? '' }, query: { period } },
        }),
      ),
  })
}

/** Saves a batch of data points; refreshes the scorecard view and entry grid. */
export function useSaveData(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: DataBatchRequest) =>
      unwrap(api.POST('/scorecards/{sc}/data:batch', { params: { path: { sc } }, body })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['view', sc] }),
        queryClient.invalidateQueries({ queryKey: ['entry', sc] }),
      ])
    },
  })
}

/** Computes the cells a batch would affect, without saving it. */
export function usePreview(sc: string) {
  const api = useApi()
  return useMutation({
    mutationFn: (body: DataBatchRequest) =>
      unwrap(api.POST('/scorecards/{sc}/preview', { params: { path: { sc } }, body })),
  })
}
