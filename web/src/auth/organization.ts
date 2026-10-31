/** Which Auth0 organization to sign in to: `?organization=` or the last one used. */

export const LAST_ORG_KEY = 'opsvision.lastOrganization'
export const TENANT_ORGS_KEY = 'opsvision.tenantOrganizations'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = ReadableStorage & Pick<Storage, 'setItem'>

export function resolveOrganization(search: string, storage: WritableStorage): string | undefined {
  const fromUrl = new URLSearchParams(search).get('organization')
  if (fromUrl) {
    storage.setItem(LAST_ORG_KEY, fromUrl)
    return fromUrl
  }
  return storage.getItem(LAST_ORG_KEY) ?? undefined
}

function readMap(storage: ReadableStorage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TENANT_ORGS_KEY) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Records that a tenant belongs to an organization, so the user can switch back to it. */
export function rememberTenantOrganization(
  tenantId: string,
  organizationId: string,
  storage: WritableStorage,
): void {
  const map = readMap(storage)
  if (map[tenantId] === organizationId) return
  map[tenantId] = organizationId
  storage.setItem(TENANT_ORGS_KEY, JSON.stringify(map))
}

export function organizationForTenant(tenantId: string, storage: ReadableStorage): string | undefined {
  return readMap(storage)[tenantId]
}
