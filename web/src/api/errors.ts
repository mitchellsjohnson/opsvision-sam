import type { components } from './schema'

export type ErrorCode = components['schemas']['Error']['error']['code']
export type ErrorDetail = components['schemas']['ErrorDetail']

/** An API failure: the HTTP status plus the contract's error envelope. */
export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode | string
  readonly details: ErrorDetail[]
  /** The parsed response body, for non-envelope bodies such as batch conflicts. */
  readonly body?: unknown

  constructor(init: {
    status: number
    code: ErrorCode | string
    message: string
    details?: ErrorDetail[]
    body?: unknown
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.details = init.details ?? []
    this.body = init.body
  }
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  501: 'not_implemented',
}

function isEnvelope(body: unknown): body is { error: { code: string; message: string; details?: ErrorDetail[] } } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false
  const e = (body as { error: unknown }).error
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  )
}

/** Builds an ApiError from a failed response; never throws. */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    body = undefined
  }
  if (isEnvelope(body)) {
    return new ApiError({
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      details: Array.isArray(body.error.details) ? body.error.details : [],
      body,
    })
  }
  return new ApiError({
    status: response.status,
    code: CODE_BY_STATUS[response.status] ?? 'error',
    message: response.statusText || `Request failed with status ${response.status}`,
    body,
  })
}
