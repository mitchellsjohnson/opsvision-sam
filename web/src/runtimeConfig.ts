import { ConfigError, resolveConfig, type AppConfig, type EnvVars } from './config'

/**
 * Where a deployment that serves the app publishes its configuration, so the
 * public build holds no deployment values.
 */
export const RUNTIME_CONFIG_PATH = '/config.json'

export interface LoadOptions {
  env: EnvVars
  isProduction: boolean
  /** The page's origin; the API's when /config.json leaves apiUrl empty. */
  origin: string
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>
}

/**
 * Resolves the app configuration at startup.
 *
 * A development build uses the build env, exactly as resolveConfig does. A
 * production build first fetches /config.json and uses it when the server
 * has one. When there is none (404, an HTML page from a static host's
 * fallback, or no response at all) it falls back to the build env. Any other
 * failure rejects, so a broken deployment is reported rather than guessed at.
 */
export async function loadRuntimeConfig({
  env,
  isProduction,
  origin,
  fetchFn = (input, init) => fetch(input, init),
}: LoadOptions): Promise<AppConfig> {
  if (!isProduction) return resolveConfig(env, false)

  let res: Response
  try {
    res = await fetchFn(RUNTIME_CONFIG_PATH, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return resolveConfig(env, true)
  }
  if (res.status === 404) return resolveConfig(env, true)
  if (!res.ok) throw new Error(`Could not load ${RUNTIME_CONFIG_PATH}: HTTP ${res.status}.`)
  if (!(res.headers.get('Content-Type') ?? '').includes('json')) return resolveConfig(env, true)

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`${RUNTIME_CONFIG_PATH} is not valid JSON.`)
  }
  return parseRuntimeConfig(body, origin)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseRuntimeConfig(body: unknown, origin: string): AppConfig {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`${RUNTIME_CONFIG_PATH} is not a JSON object.`)
  }
  const raw = body as Record<string, unknown>
  // A deployed server never offers the development sign-in.
  if (raw.authMode !== 'auth0') {
    throw new Error(`${RUNTIME_CONFIG_PATH}: authMode must be "auth0".`)
  }
  const config: AppConfig = {
    apiUrl: text(raw.apiUrl).replace(/\/+$/, '') || origin,
    authMode: 'auth0',
    auth0Domain: text(raw.auth0Domain),
    auth0ClientId: text(raw.auth0ClientId),
    auth0Audience: text(raw.auth0Audience),
    fromRuntimeConfig: true,
  }
  const missing = (['auth0Domain', 'auth0ClientId', 'auth0Audience'] as const).filter(
    (key) => config[key] === '',
  )
  if (missing.length > 0) {
    throw new ConfigError([...missing], `Set them in the deployment's ${RUNTIME_CONFIG_PATH}.`)
  }
  const organization = text(raw.organization)
  if (organization) config.organization = organization
  return config
}
