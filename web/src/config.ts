export type AuthMode = 'dev' | 'auth0'

export interface AppConfig {
  apiUrl: string
  authMode: AuthMode
  auth0Domain: string
  auth0ClientId: string
  auth0Audience: string
}

const env = import.meta.env

export const config: AppConfig = {
  apiUrl: (env.VITE_API_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  authMode: env.VITE_AUTH_MODE === 'auth0' ? 'auth0' : 'dev',
  auth0Domain: env.VITE_AUTH0_DOMAIN ?? '',
  auth0ClientId: env.VITE_AUTH0_CLIENT_ID ?? '',
  auth0Audience: env.VITE_AUTH0_AUDIENCE ?? '',
}
