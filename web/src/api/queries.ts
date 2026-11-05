import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
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
  history: (sc: string, measure: string, subject: string, period: string) =>
    ['history', sc, measure, subject, period] as const,
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
export function useItems() {
  const api = useApi()
  return useQuery({
    queryKey: keys.items,
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
        queryClient.invalidateQueries({ queryKey: ['versions'] }),
        queryClient.invalidateQueries({ queryKey: ['diff'] }),
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
