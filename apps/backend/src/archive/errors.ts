import { causes } from '../runtime/errors.js'
import type { ARCHIVE_LEASE_BUSY } from './wire.js'

/** How long a client refused by an archive hold waits before it retries. */
export const ARCHIVE_RETRY_AFTER_SECONDS = 60

/** An archive problem the administrator can act on. Nothing has been activated when it is thrown. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError'
  /** When a refused request may be retried unchanged. */
  readonly retryAt: number | undefined
  /** A stable reason a client may branch on; the message is for people. */
  readonly code: typeof ARCHIVE_LEASE_BUSY | undefined
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 422 = 422,
    options: { readonly retryAt?: number; readonly code?: typeof ARCHIVE_LEASE_BUSY } = {},
  ) {
    super(message)
    this.retryAt = options.retryAt
    this.code = options.code
  }
}

/** A write reached a store while an archive operation held the server. */
export class ArchiveOperationActiveError extends Error {
  override readonly name = 'ArchiveOperationActiveError'
  constructor(options?: ErrorOptions) {
    super('This server is being archived or restored. Try again later.', options)
  }
}

/** Archive work arrived for an operation that no longer holds the server. */
export class StaleArchiveOperationError extends Error {
  override readonly name = 'StaleArchiveOperationError'
  constructor() {
    super('This archive operation no longer holds the server')
  }
}

type ArchiveErrorName = ArchiveOperationActiveError['name'] | StaleArchiveOperationError['name']

/**
 * Whether `error`, or any error in its cause chain, is the named archive error. Matches by name
 * because a Durable Object RPC rebuilds errors as plain `Error`s that keep only name, message and
 * own properties, and because stores wrap what the fence throws.
 */
export const isArchiveError = (error: unknown, name: ArchiveErrorName): boolean =>
  causes(error).some((cause) => cause.name === name)
