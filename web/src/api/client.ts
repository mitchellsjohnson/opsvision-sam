import createClient, { type Middleware } from 'openapi-fetch'
import { apiErrorFromResponse } from './errors'
import type { paths } from './schema'

export interface ApiClientOptions {
  /** API origin, without the `/v1` base path. */
  apiUrl: string
  getToken: () => Promise<string | undefined>
  /** Called when the API answers 401, before the error is thrown. */
  onUnauthorized?: () => void
}

export type ApiClient = ReturnType<typeof createApiClient>

/**
 * An openapi-fetch client for the OpsVision API. Requests carry the bearer
 * token; any non-2xx response rejects with a typed ApiError.
 */
export function createApiClient({ apiUrl, getToken, onUnauthorized }: ApiClientOptions) {
  const middleware: Middleware = {
    async onRequest({ request }) {
      const token = await getToken()
      if (token) request.headers.set('Authorization', `Bearer ${token}`)
      return request
    },
    async onResponse({ response }) {
      if (response.ok) return undefined
      if (response.status === 401) onUnauthorized?.()
      throw await apiErrorFromResponse(response)
    },
  }
  const client = createClient<paths>({ baseUrl: `${apiUrl.replace(/\/+$/, '')}/v1` })
  client.use(middleware)
  return client
}
