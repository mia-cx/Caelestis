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

/** How a store refusal reads to the caller. */
export type PortErrorKind = 'invalid' | 'not-found' | 'conflict' | 'gone'

/** A store refused an operation for a reason the caller can act on; `kind` decides the answer. */
export abstract class PortError extends Error {
  abstract readonly kind: PortErrorKind
}

const ANSWER = {
  invalid: ValidationError,
  conflict: ConflictError,
  gone: GoneError,
} as const

/**
 * Run one store call. A `PortError` becomes the error its kind names, and anything else a
 * `StorageError`. A 404 never echoes what it missed. `refine` re-reads a kind where the call site
 * knows better, such as a missing folder in a template write being bad input, not a missing
 * resource.
 */
export const fromPort = <A>(
  operation: string,
  run: () => Promise<A>,
  refine: Partial<Record<PortErrorKind, PortErrorKind>> = {},
): Effect.Effect<A, ValidationError | NotFoundError | ConflictError | GoneError | StorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      if (!(cause instanceof PortError)) return new StorageError({ operation, cause })
      const kind = refine[cause.kind] ?? cause.kind
      return kind === 'not-found'
        ? new NotFoundError({ message: 'not found' })
        : new ANSWER[kind]({ message: cause.message })
    },
  })

export type BackendHttpError =
  | StorageError
  | ValidationError
  | NotFoundError
  | ConflictError
  | GoneError
  | UnauthorizedError
  | ForbiddenError
