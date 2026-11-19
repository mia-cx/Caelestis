import { Data, Effect } from 'effect'

/**
 * A store or other dependency rejected an otherwise valid operation. The HTTP edge logs the cause
 * and answers a bare 500, so internals never reach the caller.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {
  readonly status = 500
}

/** Run one dependency call, turning a rejection into a `StorageError` that names the operation. */
export const storage = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, StorageError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new StorageError({ operation, cause }) })

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string
}> {
  readonly status = 400
}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
  readonly message: string
}> {
  readonly status = 404
}

/** A write lost an optimistic concurrency race. */
export class ConflictError extends Data.TaggedError('ConflictError')<{
  readonly message: string
}> {
  readonly status = 409
}

/** A permanently deleted identity cannot be recreated by a stale writer. */
export class GoneError extends Data.TaggedError('GoneError')<{
  readonly message: string
}> {
  readonly status = 410
}

/** Authentication failed. The body never reveals whether a credential exists or was revoked. */
export class UnauthorizedError extends Data.TaggedError('UnauthorizedError') {
  readonly status = 401
  override readonly message = 'unauthorized'
}

/** The authenticated caller does not hold the required scope. */
export class ForbiddenError extends Data.TaggedError('ForbiddenError') {
  readonly status = 403
  override readonly message = 'forbidden'
}

export type BackendHttpError =
  | StorageError
  | ValidationError
  | NotFoundError
  | ConflictError
  | GoneError
  | UnauthorizedError
  | ForbiddenError
