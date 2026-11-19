import { Effect } from 'effect'
import type { Context } from 'hono'
import {
  ARCHIVE_RETRY_AFTER_SECONDS,
  ArchiveError,
  ArchiveOperationActiveError,
  isArchiveError,
} from '../archive/errors.js'
import type { BackendRuntime, BackendServices } from './backend-runtime.js'
import { type BackendHttpError, StorageError } from './errors.js'

const retryAfter = (at: number) => String(Math.max(1, Math.ceil((at - Date.now()) / 1_000)))

/**
 * Answer a failure with its status. A write refused by an archive hold answers 503 however deep a
 * store wrapped it. Storage causes and unexpected errors are logged and never sent.
 */
export const errorResponse = (context: Context, error: BackendHttpError | unknown): Response => {
  if (isArchiveError(error, 'ArchiveOperationActiveError')) {
    context.header('retry-after', String(ARCHIVE_RETRY_AFTER_SECONDS))
    return context.json({ error: new ArchiveOperationActiveError().message }, 503)
  }
  if (error instanceof ArchiveError) {
    if (error.retryAt !== undefined) context.header('retry-after', retryAfter(error.retryAt))
    return context.json(
      { error: error.message, ...(error.code === undefined ? {} : { code: error.code }) },
      error.status,
    )
  }
  if (isAnswerable(error)) return context.json({ error: error.message }, error.status)
  console.error(error instanceof StorageError ? error.cause : error)
  return context.text('Internal Server Error', 500)
}

/** A backend error whose message is written for the caller. */
const isAnswerable = (error: unknown): error is Exclude<BackendHttpError, StorageError> =>
  error instanceof Error && '_tag' in error && 'status' in error && !(error instanceof StorageError)

/** Run one Effect use case at the Hono boundary while leaving defects to Hono's error handler. */
export const runBackendHttp = <A, E extends BackendHttpError>(
  context: Context,
  runtime: BackendRuntime,
  effect: Effect.Effect<A, E, BackendServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> =>
  runtime.runHandled(Effect.map(effect, onSuccess), (error) => errorResponse(context, error))

/** Run an Effect at a Hono middleware boundary, then continue only on successful authentication. */
export const runBackendMiddleware = async <A, E extends BackendHttpError>(
  context: Context,
  runtime: BackendRuntime,
  effect: Effect.Effect<A, E, BackendServices>,
  onSuccess: (value: A) => Promise<void>,
): Promise<Response | undefined> => {
  const result = await runtime.run(
    Effect.match(effect, {
      onFailure: (error) => ({ ok: false as const, response: errorResponse(context, error) }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  )
  if (!result.ok) return result.response
  await onSuccess(result.value)
  return undefined
}
