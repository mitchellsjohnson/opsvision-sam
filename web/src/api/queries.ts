import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { ViewRequest } from '../lib/period'
import { apiErrorFromResponse } from './errors'
import type { components } from './schema'
import { useApi } from './useApi'

type Schemas = components['schemas']
export type DataBatchRequest = Schemas['DataBatchRequest']
export type PutOverrideRequest = Schemas['PutOverrideRequest']
export type Level = Schemas['Level']
export type OrgUnit = Schemas['OrgUnit']
export type OrgTree = Schemas['OrgTree']
export type OrgTreeNode = Schemas['OrgTreeNode']
export type CreateOrgUnitRequest = Schemas['OrgUnit']
export type UpdateOrgUnitRequest = Schemas['UpdateOrgUnitRequest']
export type CreateOrgMoveRequest = Schemas['CreateOrgMoveRequest']
export type ItemKind = Schemas['ItemKind']
export type TrackedItem = Schemas['TrackedItem']
export type UpdateItemRequest = Schemas['UpdateItemRequest']
export type Membership = Schemas['Membership']
export type UpdateMemberRequest = Schemas['UpdateMemberRequest']
export type InviteMemberRequest = Schemas['InviteMemberRequest']
export type MethodologyVersion = Schemas['MethodologyVersion']
export type Methodology = Schemas['Methodology']
export type Metric = Schemas['Metric']
export type VersionDiff = Schemas['VersionDiff']
export type VersionChange = Schemas['VersionChange']
export type ImportTemplate = Schemas['ImportTemplate']
export type ChangeSetPreview = Schemas['ChangeSetPreview']
export type ImportUpload = Schemas['ImportUpload']
export type RecordType = Schemas['RecordType']
export type RecordTemplate = Schemas['RecordTemplate']
export type RecordsInspectResult = Schemas['RecordsInspectResult']
export type RecordsPreviewRequest = Schemas['RecordsPreviewRequest']
export type RecordsPreview = Schemas['RecordsPreview']
export type ApplyImportRequest = Schemas['ApplyImportRequest']
export type RecordsSampleRequest = Schemas['RecordsSampleRequest']
export type RecordsSample = Schemas['RecordsSample']
export type RecordValueCount = Schemas['RecordValueCount']
export type RecordContributions = Schemas['RecordContributions']
export interface OverrideCell {
  metricKey: string
  subjectId: string
  period: string
}

/** Query keys, shared so mutations and pages invalidate the same entries. */
export const keys = {
  me: ['me'] as const,
  scorecards: ['scorecards'] as const,
  orgUnits: ['orgUnits'] as const,
  orgLevels: ['orgLevels'] as const,
  orgTree: (month: string) => ['orgTree', month] as const,
  itemKinds: ['itemKinds'] as const,
  items: ['items'] as const,
  members: ['members'] as const,
  view: (sc: string, req: ViewRequest) => ['view', sc, req] as const,
  entry: (sc: string, period: string) => ['entry', sc, period] as const,
  versions: (sc: string) => ['versions', sc] as const,
  diff: (sc: string, v: string, against: string) => ['diff', sc, v, against] as const,
  importTemplates: ['importTemplates'] as const,
  recordTypes: ['recordTypes'] as const,
  recordsSample: (sc: string, body: RecordsSampleRequest) => ['recordsSample', sc, body] as const,
  recordValues: (recordType: string, field: string) => ['recordValues', recordType, field] as const,
  history: (sc: string, measure: string, subject: string, period: string) =>
    ['history', sc, measure, subject, period] as const,
  contributions: (sc: string, metric: string, subject: string, period: string) =>
    ['contributions', sc, metric, subject, period] as const,
  layout: (sc: string) => ['layout', sc] as const,
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

/** The tenant's fiscal year start month (1-12); January until the identity loads. */
export function useFiscalYearStartMonth(): number {
  const me = useMe()
  return me.data?.tenant?.fiscalYearStartMonth ?? 1
}

export function useScorecards() {
  const api = useApi()
  return useQuery({ queryKey: keys.scorecards, queryFn: () => unwrap(api.GET('/scorecards')) })
}

export function useOrgUnits() {
  const api = useApi()
  return useQuery({ queryKey: keys.orgUnits, queryFn: () => unwrap(api.GET('/org/units')) })
}

/**
 * The computed scorecard table for the requested columns. With
 * `keepPrevious`, the last result stays (as placeholder data) while a new
 * request loads.
 */
export function useView(sc: string | undefined, req: ViewRequest, options: { keepPrevious?: boolean } = {}) {
  const api = useApi()
  return useQuery({
    queryKey: keys.view(sc ?? '', req),
    enabled: sc !== undefined,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
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
        queryClient.invalidateQueries({ queryKey: ['contributions', sc] }),
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

/** A scorecard's methodology versions, newest first. */
export function useVersions(sc: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: keys.versions(sc ?? ''),
    enabled: sc !== undefined,
    queryFn: () => unwrap(api.GET('/scorecards/{sc}/versions', { params: { path: { sc: sc ?? '' } } })),
  })
}

/** Stored revisions of one data point, newest first. */
export function useHistory(
  sc: string,
  measure: string,
  subject: string,
  period: string,
  enabled = true,
) {
  const api = useApi()
  return useQuery({
    queryKey: keys.history(sc, measure, subject, period),
    enabled,
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/history', {
          params: { path: { sc }, query: { measure, subject, period } },
        }),
      ),
  })
}

/** The records behind a metric cell, by derived measure; pages of 100 records across measures. */
export function useContributions(sc: string, metric: string, subject: string, period: string, enabled = true) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: keys.contributions(sc, metric, subject, period),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RecordContributions) => last.nextCursor,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/scorecards/{sc}/records/contributions', {
          params: {
            path: { sc },
            query: pageParam === undefined ? { metric, subject, period } : { metric, subject, period, cursor: pageParam },
          },
        }),
      ),
  })
}

/** Creates or replaces an override on a metric cell; refreshes the scorecard view. */
export function usePutOverride(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PutOverrideRequest) =>
      unwrap(api.PUT('/scorecards/{sc}/overrides', { params: { path: { sc } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['view', sc] }),
  })
}

/** Removes an override from a metric cell; refreshes the scorecard view. */
export function useClearOverride(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (cell: OverrideCell) =>
      unwrap(api.DELETE('/scorecards/{sc}/overrides', { params: { path: { sc }, query: cell } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['view', sc] }),
  })
}

// ---- Admin: org, items, members ---------------------------------------------

/** The org hierarchy levels, shallowest first. */
export function useOrgLevels() {
  const api = useApi()
  return useQuery({
    queryKey: keys.orgLevels,
    queryFn: async () => (await unwrap(api.GET('/org/levels'))).levels,
  })
}

/** Replaces the hierarchy levels. */
export function usePutOrgLevels() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (levels: Level[]) =>
      (await unwrap(api.PUT('/org/levels', { body: { levels } }))).levels,
    onSuccess: async (levels) => {
      queryClient.setQueryData(keys.orgLevels, levels)
      await queryClient.invalidateQueries({ queryKey: ['orgTree'] })
    },
  })
}

/** The org tree as it stood in a fiscal month (`2026-M10`). */
export function useOrgTree(month: string) {
  const api = useApi()
  return useQuery({
    queryKey: keys.orgTree(month),
    queryFn: () => unwrap(api.GET('/org/tree', { params: { query: { month } } })),
  })
}

/** Org structure changes also change what scorecards show, so refresh them too. */
async function refreshOrg(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.orgUnits }),
    queryClient.invalidateQueries({ queryKey: ['orgTree'] }),
    queryClient.invalidateQueries({ queryKey: ['view'] }),
  ])
}

export function useCreateOrgUnit() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateOrgUnitRequest) => unwrap(api.POST('/org/units', { body })),
    onSuccess: () => refreshOrg(queryClient),
  })
}

export function useUpdateOrgUnit() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateOrgUnitRequest }) =>
      unwrap(api.PATCH('/org/units/{id}', { params: { path: { id } }, body })),
    onSuccess: () => refreshOrg(queryClient),
  })
}

/** Reparents a unit from a month. */
export function useCreateOrgMove() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CreateOrgMoveRequest }) =>
      unwrap(api.POST('/org/units/{id}/moves', { params: { path: { id } }, body })),
    onSuccess: () => refreshOrg(queryClient),
  })
}

export function useItemKinds() {
  const api = useApi()
  return useQuery({
    queryKey: keys.itemKinds,
    queryFn: async () => (await unwrap(api.GET('/item-kinds'))).itemKinds,
  })
}

export function useCreateItemKind() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ItemKind) => unwrap(api.POST('/item-kinds', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.itemKinds }),
  })
}

/** Every tracked item, of all kinds. */
export function useItems(options: { enabled?: boolean } = {}) {
  const api = useApi()
  return useQuery({
    queryKey: keys.items,
    enabled: options.enabled,
    queryFn: async () => (await unwrap(api.GET('/items', { params: { query: {} } }))).items,
  })
}

export function useCreateItem() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TrackedItem) => unwrap(api.POST('/items', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.items }),
  })
}

export function useUpdateItem() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateItemRequest }) =>
      unwrap(api.PATCH('/items/{id}', { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.items }),
  })
}

/** The tenant's members, pending invitations included (admins only). */
export function useMembers() {
  const api = useApi()
  return useQuery({
    queryKey: keys.members,
    queryFn: async () => (await unwrap(api.GET('/members'))).members,
  })
}

export function useUpdateMember() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateMemberRequest }) =>
      unwrap(api.PATCH('/members/{userId}', { params: { path: { userId } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.members }),
  })
}

export function useInviteMember() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: InviteMemberRequest) => unwrap(api.POST('/members', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.members }),
  })
}

// ---- Admin: methodology -----------------------------------------------------

/** Version changes also change what scorecards show and which cells can be entered. */
async function refreshVersions(queryClient: ReturnType<typeof useQueryClient>, sc: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.versions(sc) }),
    queryClient.invalidateQueries({ queryKey: ['diff', sc] }),
  ])
}

/** Creates a draft, empty or cloned from `cloneFrom`. */
export function useCreateVersion(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; cloneFrom?: string }) =>
      unwrap(api.POST('/scorecards/{sc}/versions', { params: { path: { sc } }, body })),
    onSuccess: () => refreshVersions(queryClient, sc),
  })
}

/** Saves a draft's content against the revision the editor loaded. */
export function usePutVersion(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ v, body }: { v: string; body: { revision: number; name?: string; content: Methodology } }) =>
      unwrap(api.PUT('/scorecards/{sc}/versions/{v}', { params: { path: { sc, v } }, body })),
    onSuccess: () => refreshVersions(queryClient, sc),
  })
}

/** Validates the stored content of a version (not unsaved edits). */
export function useValidateVersion(sc: string) {
  const api = useApi()
  return useMutation({
    mutationFn: (v: string) =>
      unwrap(api.POST('/scorecards/{sc}/versions/{v}/validate', { params: { path: { sc, v } } })),
  })
}

/** Publishes a draft from a period, then refreshes versions and everything computed from them. */
export function usePublishVersion(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ v, effectiveFrom }: { v: string; effectiveFrom: string }) =>
      unwrap(
        api.POST('/scorecards/{sc}/versions/{v}/publish', {
          params: { path: { sc, v } },
          body: { effectiveFrom },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        refreshVersions(queryClient, sc),
        queryClient.invalidateQueries({ queryKey: ['view', sc] }),
        queryClient.invalidateQueries({ queryKey: ['entry', sc] }),
        queryClient.invalidateQueries({ queryKey: ['contributions', sc] }),
      ])
    },
  })
}

/** The differences from `against` (the version in force when empty) to version `v`. */
export function useVersionDiff(sc: string, v: string, against: string) {
  const api = useApi()
  return useQuery({
    queryKey: keys.diff(sc, v, against),
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/versions/{v}/diff', {
          params: { path: { sc, v }, query: against === '' ? {} : { against } },
        }),
      ),
  })
}

// ---- Admin: import ----------------------------------------------------------

export function useImportTemplates() {
  const api = useApi()
  return useQuery({
    queryKey: keys.importTemplates,
    queryFn: async () => (await unwrap(api.GET('/import-templates'))).templates,
  })
}

/** Creates or replaces one template. */
export function usePutImportTemplate() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ImportTemplate) =>
      unwrap(api.PUT('/import-templates/{id}', { params: { path: { id: body.id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.importTemplates }),
  })
}

export function useCreateImportUpload() {
  const api = useApi()
  return useMutation({
    mutationFn: (body: { filename?: string; contentType?: string }) =>
      unwrap(api.POST('/imports/uploads', { body })),
  })
}

export function useParseImport() {
  const api = useApi()
  return useMutation({
    mutationFn: ({ id, templateId }: { id: string; templateId: string }) =>
      unwrap(
        api.POST('/imports/{id}/parse', {
          params: { path: { id } },
          body: { profile: 'legacy_workbook', templateId },
        }),
      ),
  })
}

/** Applies a parsed import, then refreshes everything it may have changed. */
export function useApplyImport() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/imports/{id}/apply', { params: { path: { id } } })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['view'] }),
        queryClient.invalidateQueries({ queryKey: ['entry'] }),
        queryClient.invalidateQueries({ queryKey: ['contributions'] }),
        queryClient.invalidateQueries({ queryKey: ['versions'] }),
        queryClient.invalidateQueries({ queryKey: ['diff'] }),
      ])
    },
  })
}

// ---- Admin: records import --------------------------------------------------

function recordTypesQuery(api: ReturnType<typeof useApi>) {
  return {
    queryKey: keys.recordTypes,
    queryFn: async () => (await unwrap(api.GET('/record-types'))).recordTypes,
  }
}

export function useRecordTypes(enabled = true) {
  const api = useApi()
  return useQuery({ ...recordTypesQuery(api), enabled })
}

/** Loads the record types (from the cache when there), for handlers that need them now. */
export function useLoadRecordTypes(): () => Promise<RecordType[]> {
  const api = useApi()
  const queryClient = useQueryClient()
  return () => queryClient.ensureQueryData(recordTypesQuery(api))
}

/** Creates (revision 0) or replaces a record type against the revision the page loaded. */
export function usePutRecordType() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: RecordType) =>
      unwrap(api.PUT('/record-types/{id}', { params: { path: { id: body.id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.recordTypes }),
  })
}

/** The distinct values stored records hold in one field, most common first (at most 100). */
export function useRecordValues(recordType: string, field: string, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.recordValues(recordType, field),
    enabled: enabled && recordType !== '' && field !== '',
    staleTime: 60_000,
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/record-types/{id}/values', { params: { path: { id: recordType }, query: { field } } }),
        )
      ).values,
  })
}

/** How many stored records a condition matches in a period, per product or team. */
export function useRecordsSample(sc: string, body: RecordsSampleRequest, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.recordsSample(sc, body),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => unwrap(api.POST('/scorecards/{sc}/records/sample', { params: { path: { sc } }, body })),
  })
}

/** Looks at an uploaded records export: its columns, values and the saved template it matches. */
export function useInspect() {
  const api = useApi()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/imports/{id}/inspect', { params: { path: { id } } })),
  })
}

/** Previews a records import; nothing is applied. */
export function useRecordsPreview() {
  const api = useApi()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RecordsPreviewRequest }) =>
      unwrap(api.POST('/imports/{id}/records-preview', { params: { path: { id } }, body })),
  })
}

/** Applies a previewed records import, then refreshes everything it may have changed. */
export function useApplyRecords() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ApplyImportRequest }) =>
      unwrap(api.POST('/imports/{id}/apply', { params: { path: { id } }, body })),
    onSuccess: async () => {
      // Apply saves answered source keys, shared units and templates, a first tracked-from
      // month, and recalculates derived values.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['view'] }),
        queryClient.invalidateQueries({ queryKey: ['entry'] }),
        queryClient.invalidateQueries({ queryKey: ['contributions'] }),
        queryClient.invalidateQueries({ queryKey: keys.importTemplates }),
        queryClient.invalidateQueries({ queryKey: keys.recordTypes }),
        queryClient.invalidateQueries({ queryKey: keys.orgUnits }),
        queryClient.invalidateQueries({ queryKey: ['orgTree'] }),
        queryClient.invalidateQueries({ queryKey: keys.items }),
      ])
    },
  })
}

export interface MetricOption {
  key: string
  name: string
}

/**
 * The metrics of each scorecard's current published methodology version,
 * merged across scorecards (deduplicated by key, sorted by name).
 */
export function usePublishedMetrics(): {
  data: MetricOption[] | undefined
  isPending: boolean
  isError: boolean
} {
  const api = useApi()
  const scorecards = useScorecards()
  const ids = scorecards.data?.scorecards.map((s) => s.id) ?? []
  const versions = useQueries({
    queries: ids.map((sc) => ({
      queryKey: keys.versions(sc),
      queryFn: () => unwrap(api.GET('/scorecards/{sc}/versions', { params: { path: { sc } } })),
    })),
  })
  if (scorecards.isError || versions.some((v) => v.isError)) {
    return { data: undefined, isPending: false, isError: true }
  }
  if (scorecards.isPending || versions.some((v) => v.isPending)) {
    return { data: undefined, isPending: true, isError: false }
  }
  const byKey = new Map<string, MetricOption>()
  for (const v of versions) {
    // Newest first: the first published version is the current one.
    const current = v.data?.versions.find((x) => x.status === 'published')
    for (const m of current?.content.metrics ?? []) byKey.set(m.key, { key: m.key, name: m.name })
  }
  const data = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { data, isPending: false, isError: false }
}

/** Saved overview tile order for a scorecard. */
export function useLayout(sc: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: keys.layout(sc ?? ''),
    enabled: sc !== undefined,
    queryFn: () => unwrap(api.GET('/me/layouts/{sc}', { params: { path: { sc: sc ?? '' } } })),
  })
}

/**
 * Persists overview tile order. The new order shows at once and is put back
 * if the save fails; callers handle 409 by refetching.
 */
export function usePutLayout(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['PutLayoutRequest']) =>
      unwrap(api.PUT('/me/layouts/{sc}', { params: { path: { sc } }, body })),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: keys.layout(sc) })
      const previous = queryClient.getQueryData<Schemas['LayoutResponse']>(keys.layout(sc))
      queryClient.setQueryData<Schemas['LayoutResponse']>(keys.layout(sc), (prev) =>
        prev ? { ...prev, items: body.items } : prev,
      )
      return { previous }
    },
    onError: (_err, _body, context) => {
      if (context?.previous) queryClient.setQueryData(keys.layout(sc), context.previous)
    },
    onSuccess: (data) => {
      queryClient.setQueryData(keys.layout(sc), data)
    },
  })
}

/** Saves the tenant default overview layout (admin). */
export function usePutDefaultLayout(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['PutLayoutRequest']) =>
      unwrap(api.PUT('/scorecards/{sc}/default-layout', { params: { path: { sc } }, body })),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.layout(sc), (prev: Schemas['LayoutResponse'] | undefined) =>
        prev ? { ...prev, defaultRevision: data.revision } : prev,
      )
    },
  })
}
