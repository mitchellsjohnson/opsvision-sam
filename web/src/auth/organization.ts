/** Which Auth0 organization to sign in to: the configured one, `?organization=` or the last one used. */

export const LAST_ORG_KEY = 'opsvision.lastOrganization'
export const TENANT_ORGS_KEY = 'opsvision.tenantOrganizations'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = ReadableStorage & Pick<Storage, 'setItem'>

/**
 * The organization to sign in to: the deployment's configured one, else
 * `?organization=`, else the last one used. With `onlyConfigured` (the
 * deployment's /config.json set up sign-in) it is the configured one or none.
 * Pure: it reads storage but never writes it.
 */
export function resolveOrganization(
  search: string,
  storage: ReadableStorage,
  configured?: string,
  onlyConfigured = false,
): string | undefined {
  if (configured) return configured
  if (onlyConfigured) return undefined
  const fromUrl = new URLSearchParams(search).get('organization')
  return fromUrl || (storage.getItem(LAST_ORG_KEY) ?? undefined)
}

/** Auth0 authorization params; `organization` is present only when there is one. */
export function auth0AuthorizationParams({
  audience,
  organization,
  redirectUri,
}: {
  audience: string
  organization?: string
  redirectUri: string
}): { audience: string; organization?: string; redirect_uri: string } {
  return organization
    ? { audience, organization, redirect_uri: redirectUri }
    : { audience, redirect_uri: redirectUri }
}

/** Records the organization as the last one used. Call from an effect or callback. */
export function rememberOrganization(organizationId: string, storage: WritableStorage): void {
  storage.setItem(LAST_ORG_KEY, organizationId)
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
