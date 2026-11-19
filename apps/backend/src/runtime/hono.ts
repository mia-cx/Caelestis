import { Effect } from 'effect'
import type { Context } from 'hono'
import type { BackendRuntime, BackendServices } from './backend-runtime.js'
import type { BackendHttpError } from './errors.js'

/** Answer a typed failure with its status. Storage causes are logged and never sent. */
const mapBackendHttpError = (context: Context, error: BackendHttpError): Response => {
  if (error._tag !== 'StorageError') return context.json({ error: error.message }, error.status)
  console.error(error.cause)
  return context.text('Internal Server Error', error.status)
}

/** Run one Effect use case at the Hono boundary while leaving defects to Hono's error handler. */
export const runBackendHttp = <A, E extends BackendHttpError>(
  context: Context,
  runtime: BackendRuntime,
  effect: Effect.Effect<A, E, BackendServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> =>
  runtime.runHandled(Effect.map(effect, onSuccess), (error) => mapBackendHttpError(context, error))

/** Run an Effect at a Hono middleware boundary, then continue only on successful authentication. */
export const runBackendMiddleware = async <A, E extends BackendHttpError>(
  context: Context,
  runtime: BackendRuntime,
  effect: Effect.Effect<A, E, BackendServices>,
  onSuccess: (value: A) => Promise<void>,
): Promise<Response | undefined> => {
  const result = await runtime.run(
    Effect.match(effect, {
      onFailure: (error) => ({ ok: false as const, response: mapBackendHttpError(context, error) }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  )
  if (!result.ok) return result.response
  await onSuccess(result.value)
  return undefined
}
