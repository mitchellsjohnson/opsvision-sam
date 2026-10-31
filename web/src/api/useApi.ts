import { useMemo } from 'react'
import { useAuth } from '../auth/context'
import { config } from '../config'
import { createApiClient, type ApiClient } from './client'

/** The API client for the signed-in user; stable while the session is. */
export function useApi(): ApiClient {
  const { getToken, signOut } = useAuth()
  return useMemo(
    () => createApiClient({ apiUrl: config.apiUrl, getToken, onUnauthorized: signOut }),
    [getToken, signOut],
  )
}
