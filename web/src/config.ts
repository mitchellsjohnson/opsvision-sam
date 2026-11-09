export type AuthMode = 'dev' | 'auth0'

export interface AppConfig {
  apiUrl: string
  authMode: AuthMode
  auth0Domain: string
  auth0ClientId: string
  auth0Audience: string
  /** The Auth0 organization to sign in to, when the deployment fixes one. */
  organization?: string
}

/** The Vite env variables the app reads. */
export interface EnvVars {
  VITE_API_URL?: string
  VITE_AUTH_MODE?: string
  VITE_AUTH0_DOMAIN?: string
  VITE_AUTH0_CLIENT_ID?: string
  VITE_AUTH0_AUDIENCE?: string
}

/** The app cannot start: required configuration is missing. */
export class ConfigError extends Error {
  readonly missing: string[]

  constructor(
    missing: string[],
    hint = 'Set these environment variables when building the app, ' +
      'or set VITE_AUTH_MODE=dev to use the development sign-in (never in production).',
  ) {
    super(`Missing required configuration: ${missing.join(', ')}. ${hint}`)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

/**
 * Resolves the app configuration from the build environment.
 *
 * Auth mode: a development build defaults to `dev`; a production build
 * defaults to `auth0` and uses `dev` only when VITE_AUTH_MODE is explicitly
 * `dev`. In auth0 mode the Auth0 domain, client ID and audience are required;
 * a ConfigError names the missing ones.
 */
export function resolveConfig(env: EnvVars, isProduction: boolean): AppConfig {
  const explicit = env.VITE_AUTH_MODE
  const authMode: AuthMode =
    explicit === 'dev' ? 'dev' : explicit === 'auth0' || isProduction ? 'auth0' : 'dev'

  const config: AppConfig = {
    apiUrl: (env.VITE_API_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    authMode,
    auth0Domain: env.VITE_AUTH0_DOMAIN?.trim() ?? '',
    auth0ClientId: env.VITE_AUTH0_CLIENT_ID?.trim() ?? '',
    auth0Audience: env.VITE_AUTH0_AUDIENCE?.trim() ?? '',
  }

  if (authMode === 'auth0') {
    const missing = (
      [
        ['VITE_AUTH0_DOMAIN', config.auth0Domain],
        ['VITE_AUTH0_CLIENT_ID', config.auth0ClientId],
        ['VITE_AUTH0_AUDIENCE', config.auth0Audience],
      ] as const
    )
      .filter(([, value]) => value === '')
      .map(([name]) => name)
    if (missing.length > 0) throw new ConfigError(missing)
  }
  return config
}

let cached: AppConfig | undefined

/**
 * The app configuration: the one set at startup (see runtimeConfig.ts), else
 * the build's. Throws ConfigError if the build's is incomplete.
 */
export function getConfig(): AppConfig {
  cached ??= resolveConfig(import.meta.env, import.meta.env.PROD)
  return cached
}

/** Sets the configuration getConfig returns. Call once, before rendering. */
export function setConfig(config: AppConfig): void {
  cached = config
}
