import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { endMonth, type ViewRequest } from '../lib/period'
import { ApiError, apiErrorFromResponse } from './errors'
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
export type AccessToken = Schemas['AccessToken']
export type CreatedAccessToken = Schemas['CreatedAccessToken']
export type CreateTokenRequest = Schemas['CreateTokenRequest']
export type AssistantContext = Schemas['AssistantContext']
export type AssistantThread = Schemas['AssistantThread']
export type AssistantMessage = Schemas['AssistantMessage']
export type AssistantUsage = Schemas['AssistantUsage']
export type AssistantSettings = Schemas['AssistantSettings']
export type AssistantCredentialStatus = Schemas['AssistantCredentialStatus']
export type ReportSummaryDraft = Schemas['ReportSummaryDraft']
export type CellAttribution = Schemas['CellAttribution']
export type MetricSummary = Schemas['MetricSummary']
export type MetricSummaryList = Schemas['MetricSummaryList']
export type MetricSummaryState = Schemas['MetricSummaryState']
export type MetricSummaryDraft = Schemas['MetricSummaryDraft']
export type MetricSummaryConflict = Schemas['MetricSummaryConflict']
export type PutMetricSummaryRequest = Schemas['PutMetricSummaryRequest']
export type PublishBlocked = Schemas['PublishBlocked']
export type RcaLink = Schemas['RcaLink']
/** One metric cell whose attribution a card shows. */
export type RcaCellRef = { metric: string; subject: string; period: string }
export type SummaryListState = 'missing' | 'stale' | 'written' | 'optional' | 'all'
export interface MetricSummaryListQuery {
  period: string
  /** Default `missing`. */
  state?: SummaryListState
  /** Whole texts and every link, 16 rows a page. */
  full?: boolean
  /** A published revision's frozen summaries instead of the live ones. */
  revision?: number
}
/** Which next page of a cell's attribution to load: incidents first, then records. */
export interface AttributionPageParam {
  incidentsCursor?: string
  recordsCursor?: string
}
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
  preferences: ['preferences'] as const,
  reportMonths: (sc: string) => ['reportMonths', sc] as const,
  report: (sc: string, period: string, revision: string) => ['report', sc, period, revision] as const,
  reportSummary: (sc: string, period: string) => ['reportSummary', sc, period] as const,
  attribution: (sc: string, ref: RcaCellRef) => ['attribution', sc, ref] as const,
  metricSummary: (sc: string, metric: string, period: string, revision?: number) =>
    ['metric-summary', sc, metric, period, revision ?? 'live'] as const,
  metricSummaries: (sc: string, q: MetricSummaryListQuery) =>
    ['metric-summaries', sc, q.period, { state: q.state ?? 'missing', full: q.full ?? false, revision: q.revision ?? 0 }] as const,
  metricSummaryCounts: (sc: string, period: string) => ['metric-summary-counts', sc, period] as const,
  myTokens: ['myTokens'] as const,
  assistantCredential: ['assistantCredential'] as const,
  assistantSettings: ['assistantSettings'] as const,
  assistantThreads: ['assistantThreads'] as const,
  assistantThread: (id: string) => ['assistantThread', id] as const,
  askSam: ['askSam'] as const,
}

/** How often the client asks for SAM's answer (or draft) while one is pending. */
export const ASSISTANT_POLL_MS = 1500

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
export function useMembers(options: { enabled?: boolean } = {}) {
  const api = useApi()
  return useQuery({
    queryKey: keys.members,
    enabled: options.enabled,
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
 * Persists overview tile order, one request at a time. The new order shows at
 * once. A save asked for while one is in flight waits, keeping only the latest
 * order, and then goes with the revision the earlier save returned, so quick
 * moves never conflict with each other. The promise of the save that started
 * the run settles when the run ends and rejects on its first failure, after the
 * order shown before the run is put back (callers handle 409 by refetching);
 * a save that joined a running one resolves at once.
 */
export function useSaveLayout(sc: string): (items: Schemas['LayoutItem'][]) => Promise<void> {
  const api = useApi()
  const queryClient = useQueryClient()
  const queue = useRef<{ running: boolean; next: Schemas['LayoutItem'][] | null }>({ running: false, next: null })
  return useCallback(
    async (items) => {
      const key = keys.layout(sc)
      const show = (shown: Schemas['LayoutItem'][]) =>
        queryClient.setQueryData<Schemas['LayoutResponse']>(key, (prev) => (prev ? { ...prev, items: shown } : prev))
      const q = queue.current
      if (q.running) {
        q.next = items
        show(items)
        return
      }
      q.running = true
      q.next = null
      const previous = queryClient.getQueryData<Schemas['LayoutResponse']>(key)
      let revision = previous?.revision ?? 0
      show(items)
      let pending: Schemas['LayoutItem'][] | null = items
      try {
        await queryClient.cancelQueries({ queryKey: key })
        pending = q.next ?? items
        q.next = null
        show(pending)
        while (pending) {
          const saved = await unwrap(
            api.PUT('/me/layouts/{sc}', { params: { path: { sc } }, body: { items: pending, expectedRevision: revision } }),
          )
          revision = saved.revision
          pending = q.next
          q.next = null
          queryClient.setQueryData(key, pending ? { ...saved, items: pending } : saved)
        }
      } catch (err) {
        q.next = null
        if (previous) queryClient.setQueryData(key, previous)
        throw err
      } finally {
        q.running = false
      }
    },
    [api, queryClient, sc],
  )
}

/** The caller's preferences; `defaultScope` is '' for the company. */
export function useMyPreferences() {
  const api = useApi()
  return useQuery({ queryKey: keys.preferences, queryFn: () => unwrap(api.GET('/me/preferences')) })
}

/** Saves the caller's preferences. */
export function usePutMyPreferences() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['UserPreferences']) => unwrap(api.PUT('/me/preferences', { body })),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.preferences, data)
    },
  })
}

/** The caller's access tokens, oldest first, expired ones included; never the secrets. */
export function useMyTokens() {
  const api = useApi()
  return useQuery({
    queryKey: keys.myTokens,
    queryFn: async () => (await unwrap(api.GET('/me/tokens'))).tokens,
  })
}

/**
 * Creates an access token; the response carries the secret, the only time it
 * is sent. The finished mutation (and the secret with it) leaves the cache as
 * soon as nothing observes it: call `reset()` when the secret is no longer shown.
 * Resolves without waiting for the list to refresh.
 */
export function useCreateToken() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (body: CreateTokenRequest) => unwrap(api.POST('/me/tokens', { body })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.myTokens })
    },
  })
}

/** Revokes one of the caller's access tokens; resolves once the list has refreshed. */
export function useDeleteToken() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/me/tokens/{id}', { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.myTokens }),
  })
}

/** The report history window: each month, live or published (by whom and when). */
export function useReportMonths(sc: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: keys.reportMonths(sc ?? ''),
    enabled: sc !== undefined,
    queryFn: () => unwrap(api.GET('/scorecards/{sc}/reports', { params: { path: { sc: sc ?? '' } } })),
  })
}

/**
 * A month's report: the latest published snapshot, else live. `revision`
 * `live` forces live; '' lets the API choose.
 */
export function useReportDocument(sc: string | undefined, period: string, revision: string) {
  const api = useApi()
  return useQuery({
    queryKey: keys.report(sc ?? '', period, revision),
    enabled: sc !== undefined,
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/reports/{period}', {
          // Published revisions also return what the Overview counted (`standing`). Exec summaries
          // are not in the document: read them with `useMetricSummaries`.
          params: {
            path: { sc: sc ?? '', period },
            query: revision === '' ? { standing: true } : { revision, standing: true },
          },
        }),
      ),
  })
}

/** The stored company-scope summary for a month, with the revision to save against. */
export function useReportSummary(sc: string | undefined, period: string, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.reportSummary(sc ?? '', period),
    enabled: sc !== undefined && enabled,
    queryFn: () =>
      unwrap(api.GET('/scorecards/{sc}/reports/{period}/summary', { params: { path: { sc: sc ?? '', period } } })),
  })
}

/** Saves the month's summary against the revision loaded (409 when stale); refreshes the report. */
export function usePutReportSummary(sc: string, period: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['PutReportSummaryRequest']) =>
      unwrap(api.PUT('/scorecards/{sc}/reports/{period}/summary', { params: { path: { sc, period } }, body })),
    onSuccess: async (data) => {
      queryClient.setQueryData(keys.reportSummary(sc, period), data)
      await queryClient.invalidateQueries({ queryKey: ['report', sc, period] })
    },
  })
}

/**
 * A publish the server refused because required exec summaries are missing
 * (409 with the error envelope's code `summaries_missing`; a publish that
 * raced another is a plain 409 `conflict`). `missing` lists them; `stale`
 * counts the stale ones, which do not block.
 */
export class PublishBlockedError extends ApiError {
  readonly missing: MetricSummary[]
  readonly stale: number

  constructor(body: PublishBlocked) {
    super({ status: 409, code: body.error.code, message: body.error.message, body })
    this.name = 'PublishBlockedError'
    this.missing = body.missing
    this.stale = body.stale ?? 0
  }
}

function isPublishBlocked(e: ApiError): e is ApiError & { body: PublishBlocked } {
  return e.status === 409 && e.code === 'summaries_missing' && Array.isArray((e.body as { missing?: unknown } | undefined)?.missing)
}

/**
 * Publishes the month's company-scope report (admin), then refreshes the
 * report and the month list. Rejects with `PublishBlockedError` while
 * required exec summaries are missing, and refreshes the month's summaries.
 */
export function usePublishReport(sc: string, period: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      try {
        return await unwrap(api.POST('/scorecards/{sc}/reports/{period}/publish', { params: { path: { sc, period } } }))
      } catch (e) {
        if (e instanceof ApiError && isPublishBlocked(e)) throw new PublishBlockedError(e.body)
        throw e
      }
    },
    onError: async (e) => {
      if (!(e instanceof PublishBlockedError)) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['metric-summaries', sc, period] }),
        queryClient.invalidateQueries({ queryKey: keys.metricSummaryCounts(sc, period) }),
      ])
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['report', sc, period] }),
        queryClient.invalidateQueries({ queryKey: keys.reportMonths(sc) }),
      ])
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

// ---- Ask SAM ------------------------------------------------------------------

/** True while SAM is still writing one of the thread's answers. */
export function threadPending(thread: AssistantThread | undefined): boolean {
  return thread?.messages.some((m) => m.status === 'pending') ?? false
}

/** Whether the caller has saved a model provider key (never the key itself). */
export function useMyAssistantCredential(enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.assistantCredential,
    enabled,
    queryFn: () => unwrap(api.GET('/me/assistant/credential')),
  })
}

/**
 * Saves or replaces the caller's key. The key is in the mutation's variables,
 * so the finished mutation leaves the cache as soon as nothing observes it.
 */
export function usePutAssistantCredential() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (apiKey: string) => unwrap(api.PUT('/me/assistant/credential', { body: { apiKey } })),
    onSuccess: (data) => queryClient.setQueryData(keys.assistantCredential, data),
  })
}

export function useDeleteAssistantCredential() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/me/assistant/credential')),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.assistantCredential }),
  })
}

/** Whether Ask SAM is on for the organization, and the model it answers with. */
export function useAssistantSettings(enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.assistantSettings,
    enabled,
    queryFn: () => unwrap(api.GET('/assistant/settings')),
  })
}

export function usePutAssistantSettings() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: AssistantSettings) => unwrap(api.PUT('/assistant/settings', { body })),
    onSuccess: (data) => queryClient.setQueryData(keys.assistantSettings, data),
  })
}

/** The caller's chats, most recently used first. */
export function useAssistantThreads(enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: keys.assistantThreads,
    enabled,
    queryFn: async () => (await unwrap(api.GET('/assistant/threads'))).threads,
  })
}

/** One chat; polled while an answer is pending, and only while something shows it. */
export function useAssistantThread(id: string | null) {
  const api = useApi()
  return useQuery({
    queryKey: keys.assistantThread(id ?? ''),
    enabled: id !== null,
    // The chat a question just returned is current; the next read is the first poll.
    staleTime: 1000,
    refetchInterval: (query) => (threadPending(query.state.data) ? ASSISTANT_POLL_MS : false),
    queryFn: () => unwrap(api.GET('/assistant/threads/{id}', { params: { path: { id: id ?? '' } } })),
  })
}

/**
 * Asks SAM a question, starting a chat first when there is none; resolves with the chat, its answer pending.
 * `onThread` gets a new chat's id as soon as it exists, so a question that then fails, or outlives the
 * drawer that asked it, still belongs to that chat.
 */
export function useAskSamQuestion({ onThread }: { onThread?: (id: string) => void } = {}) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: keys.askSam,
    mutationFn: async ({
      threadId,
      text,
      context,
    }: {
      threadId: string | null
      text: string
      context: AssistantContext
    }) => {
      let id = threadId
      if (id === null) {
        id = (await unwrap(api.POST('/assistant/threads', { body: { context } }))).id
        onThread?.(id)
      }
      return unwrap(api.POST('/assistant/threads/{id}/messages', { params: { path: { id } }, body: { text, context } }))
    },
    onSuccess: async (thread) => {
      // A read of the chat from before the question must not land on top of it.
      await queryClient.cancelQueries({ queryKey: keys.assistantThread(thread.id) })
      queryClient.setQueryData(keys.assistantThread(thread.id), thread)
      await queryClient.invalidateQueries({ queryKey: keys.assistantThreads })
    },
  })
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * Asks SAM to draft the month's summary (admin) and polls until the draft is
 * written or fails. Nothing is saved: the caller puts the text in the editor.
 */
export function useDraftReportSummary(sc: string, period: string) {
  const api = useApi()
  return useMutation({
    mutationFn: async ({ signal }: { signal?: AbortSignal } = {}) => {
      let draft = await unwrap(
        api.POST('/scorecards/{sc}/reports/{period}/summary/draft', { params: { path: { sc, period } }, body: {} }),
      )
      while (draft.pending) {
        await wait(ASSISTANT_POLL_MS, signal)
        draft = await unwrap(
          api.GET('/scorecards/{sc}/reports/{period}/summary/draft/{id}', {
            params: { path: { sc, period, id: draft.id } },
            signal,
          }),
        )
      }
      return draft
    },
  })
}

// ---- Attribution and exec summaries -------------------------------------------

type QueryClient = ReturnType<typeof useQueryClient>
type AttributionData = InfiniteData<CellAttribution, AttributionPageParam>

/** Whether a view query shows `period` (or, for a coarse period, the month that closes it). */
function isViewOf(queryKey: readonly unknown[], sc: string, periods: readonly string[]): boolean {
  if (queryKey[0] !== 'view' || queryKey[1] !== sc) return false
  const req = queryKey[2] as ViewRequest | undefined
  return req?.periods === undefined || req.periods.some((p) => periods.includes(p))
}

/** A summary's period and the month that closes it (the same for a month). */
function summaryPeriods(period: string): string[] {
  return [...new Set([period, endMonth(period)])]
}

/** Whether an attribution query is for a cell of `metric` in one of `periods`: every card that shows its summary. */
function isAttributionOf(queryKey: readonly unknown[], sc: string, metric: string, periods: readonly string[]): boolean {
  if (queryKey[0] !== 'attribution' || queryKey[1] !== sc) return false
  const ref = queryKey[2] as RcaCellRef | undefined
  return ref?.metric === metric && periods.includes(ref.period)
}

/**
 * The cell's attribution with every loaded page joined: page 1, then the
 * incidents of pages asked for by `incidentsCursor` and the records of pages
 * asked for by `recordsCursor`. The cursors are those of the latest page of
 * each list (absent once it is all loaded).
 */
export function mergeAttribution(data: InfiniteData<CellAttribution, unknown> | undefined): CellAttribution | undefined {
  const first = data?.pages[0]
  if (!data || !first) return undefined
  let incidents = first.incidents
  let records = first.records
  let incidentsCursor = first.incidentsCursor
  let recordsCursor = first.recordsCursor
  data.pages.forEach((page, i) => {
    if (i === 0) return
    const param = data.pageParams[i] as AttributionPageParam | undefined
    if (param?.incidentsCursor) {
      incidents = [...incidents, ...page.incidents]
      incidentsCursor = page.incidentsCursor
    }
    if (param?.recordsCursor) {
      records = [...records, ...page.records]
      recordsCursor = page.recordsCursor
    }
  })
  return { ...first, incidents, records, incidentsCursor, recordsCursor }
}

function nextAttributionPage(pages: CellAttribution[], params: AttributionPageParam[]): AttributionPageParam | undefined {
  const merged = mergeAttribution({ pages, pageParams: params })
  if (merged?.incidentsCursor) return { incidentsCursor: merged.incidentsCursor }
  if (merged?.recordsCursor) return { recordsCursor: merged.recordsCursor }
  return undefined
}

/**
 * One cell's attribution (5 incidents and 10 records first, then pages of
 * 50: incidents until they are all loaded, then records) with its metric's
 * exec summary as context. Idle while `ref` is null. Read the joined cell
 * with `mergeAttribution(query.data)`.
 */
export function useCellAttribution(sc: string, ref: RcaCellRef | null) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: keys.attribution(sc, ref ?? { metric: '', subject: '', period: '' }),
    enabled: ref !== null,
    initialPageParam: {} as AttributionPageParam,
    getNextPageParam: (_last: CellAttribution, pages: CellAttribution[], _param: AttributionPageParam, params: AttributionPageParam[]) =>
      nextAttributionPage(pages, params),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/scorecards/{sc}/attribution', {
          params: {
            path: { sc },
            query: { metric: ref?.metric ?? '', subject: ref?.subject ?? '', period: ref?.period ?? '', ...pageParam },
          },
        }),
      ),
  })
}

/** One metric's exec summary for a period, with every link; `revision` reads a published copy. Idle while `metric` is null. */
export function useMetricSummary(sc: string, metric: string | null, period: string, revision?: number) {
  const api = useApi()
  return useQuery({
    queryKey: keys.metricSummary(sc, metric ?? '', period, revision),
    enabled: metric !== null && metric !== '' && period !== '',
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/metric-summaries/{metric}/{period}', {
          params: { path: { sc, metric: metric ?? '', period }, query: revision === undefined ? {} : { revision } },
        }),
      ),
  })
}

/** Puts `summary` on every loaded card of the metric and period, so they show it before the refetch. */
function setCardSummaries(queryClient: QueryClient, sc: string, metric: string, periods: string[], summary: MetricSummary) {
  queryClient.setQueriesData<AttributionData>({ predicate: (q) => isAttributionOf(q.queryKey, sc, metric, periods) }, (prev) =>
    prev ? { ...prev, pages: prev.pages.map((p, i) => (i === 0 && p.summary ? { ...p, summary } : p)) } : prev,
  )
}

/**
 * After a summary changes: the summary, the month's lists and counts, every
 * card of the metric in that period, the views that show it, and the
 * month's report.
 */
async function refreshSummary(queryClient: QueryClient, sc: string, metric: string, period: string) {
  const periods = summaryPeriods(period)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['metric-summary', sc, metric, period] }),
    ...periods.flatMap((p) => [
      queryClient.invalidateQueries({ queryKey: ['metric-summaries', sc, p] }),
      queryClient.invalidateQueries({ queryKey: keys.metricSummaryCounts(sc, p) }),
    ]),
    queryClient.invalidateQueries({ predicate: (q) => isAttributionOf(q.queryKey, sc, metric, periods) }),
    queryClient.invalidateQueries({ predicate: (q) => isViewOf(q.queryKey, sc, periods) }),
    queryClient.invalidateQueries({ queryKey: ['report', sc, endMonth(period)] }),
  ])
}

export type PutMetricSummaryVars = { metric: string; period: string } & PutMetricSummaryRequest

/**
 * Saves a metric's exec summary against the revision loaded (0 creates);
 * admins only (403 otherwise). A stale revision rejects with an ApiError of
 * status 409 whose `body` is a `MetricSummaryConflict` carrying the summary
 * as stored now.
 */
export function usePutMetricSummary(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ metric, period, ...body }: PutMetricSummaryVars) =>
      unwrap(api.PUT('/scorecards/{sc}/metric-summaries/{metric}/{period}', { params: { path: { sc, metric, period } }, body })),
    onSuccess: async (saved, { metric, period }) => {
      queryClient.setQueryData(keys.metricSummary(sc, metric, period), saved)
      setCardSummaries(queryClient, sc, metric, summaryPeriods(period), saved)
      await refreshSummary(queryClient, sc, metric, period)
    },
  })
}

/** The slot a deleted summary leaves: missing when the period requires one, else optional. */
function unwrittenSlot(s: MetricSummary): MetricSummary {
  const required = s.requirement === 'required'
  return {
    metricKey: s.metricKey,
    metricName: s.metricName,
    categoryId: s.categoryId,
    period: s.period,
    requirement: s.requirement,
    requirementReason: s.requirementReason,
    state: required ? 'missing' : 'optional',
    standing: s.standing,
    links: [],
    linksTotal: 0,
    stale: false,
    staleReasons: [],
    canEdit: s.canEdit,
  }
}

/** Deletes a metric's exec summary (admins; hard delete, the audit keeps it). 409 as for saving. */
export function useDeleteMetricSummary(sc: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ metric, period, expectedRevision }: { metric: string; period: string; expectedRevision: number }) =>
      unwrap(
        api.DELETE('/scorecards/{sc}/metric-summaries/{metric}/{period}', {
          params: { path: { sc, metric, period }, query: { expectedRevision } },
        }),
      ),
    onSuccess: async (_data, { metric, period }) => {
      const periods = summaryPeriods(period)
      queryClient.setQueriesData<AttributionData>({ predicate: (q) => isAttributionOf(q.queryKey, sc, metric, periods) }, (prev) =>
        prev
          ? { ...prev, pages: prev.pages.map((p, i) => (i === 0 && p.summary ? { ...p, summary: unwrittenSlot(p.summary) } : p)) }
          : prev,
      )
      queryClient.removeQueries({ queryKey: ['metric-summary', sc, metric, period, 'live'] })
      await refreshSummary(queryClient, sc, metric, period)
    },
  })
}

/**
 * Puts a summary as it is stored now (a 409's `current`) on the summary and
 * every loaded card of the metric and period, so the next action is taken
 * against it; null (deleted meanwhile) leaves the unwritten slot.
 */
export function useSetMetricSummary(sc: string) {
  const queryClient = useQueryClient()
  return useCallback(
    (metric: string, period: string, summary: MetricSummary | null) => {
      const periods = summaryPeriods(period)
      if (summary) {
        queryClient.setQueryData(keys.metricSummary(sc, metric, period), summary)
        setCardSummaries(queryClient, sc, metric, periods, summary)
        return
      }
      queryClient.removeQueries({ queryKey: ['metric-summary', sc, metric, period, 'live'] })
      queryClient.setQueriesData<AttributionData>({ predicate: (q) => isAttributionOf(q.queryKey, sc, metric, periods) }, (prev) =>
        prev
          ? { ...prev, pages: prev.pages.map((p, i) => (i === 0 && p.summary ? { ...p, summary: unwrittenSlot(p.summary) } : p)) }
          : prev,
      )
    },
    [queryClient, sc],
  )
}

/** A month's exec summaries, one row per metric (sorted by the server), paged by cursor; `state` defaults to `missing`. */
export function useMetricSummaries(sc: string, q: MetricSummaryListQuery) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: keys.metricSummaries(sc, q),
    enabled: q.period !== '',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MetricSummaryList) => last.nextCursor,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/scorecards/{sc}/metric-summaries', {
          params: {
            path: { sc },
            query: {
              period: q.period,
              ...(q.state ? { state: q.state } : {}),
              ...(q.full ? { full: true } : {}),
              ...(q.revision === undefined ? {} : { revision: q.revision }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
  })
}

/** A month's exec summary counts only (the tab pill, the publish line); kept fresh for a minute. */
export function useMetricSummaryCounts(sc: string | undefined, period: string) {
  const api = useApi()
  return useQuery({
    queryKey: keys.metricSummaryCounts(sc ?? '', period),
    enabled: sc !== undefined && period !== '',
    staleTime: 60_000,
    queryFn: () =>
      unwrap(
        api.GET('/scorecards/{sc}/metric-summaries', { params: { path: { sc: sc ?? '' }, query: { period, countsOnly: true } } }),
      ),
  })
}

/**
 * Asks SAM to draft a metric's exec summary (admins) and polls until it is
 * written or fails. Nothing is saved: the editor shows the draft as a
 * suggestion and nowhere else.
 */
export function useMetricSummaryDraft(sc: string) {
  const api = useApi()
  return useMutation({
    mutationFn: async ({ metric, period, signal }: { metric: string; period: string; signal?: AbortSignal }) => {
      let draft = await unwrap(
        api.POST('/scorecards/{sc}/metric-summaries/{metric}/{period}/draft', { params: { path: { sc, metric, period } }, signal }),
      )
      while (draft.pending) {
        await wait(ASSISTANT_POLL_MS, signal)
        draft = await unwrap(
          api.GET('/scorecards/{sc}/metric-summaries/{metric}/{period}/draft/{id}', {
            params: { path: { sc, metric, period, id: draft.id } },
            signal,
          }),
        )
      }
      return draft
    },
  })
}
