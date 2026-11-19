import { type Millis, type Seconds, seconds } from '@caelestis/shared'

/**
 * Live contribution counters, buffered by the telemetry coordinator in front of the time series.
 *
 * The contract is **exactness**, not a storage mechanism: a value read back immediately after a
 * record reflects that record. A Durable Object delivers that through single-threaded execution;
 * a relational coordinator database through transactions.
 *
 * Flushing to the time series is deliberately **not** in this interface. The bucket resolution,
 * grace period, and retention window are contract values because every implementation must assign
 * and retain activity identically; alarms remain an adapter detail.
 */

export const RESOLUTION_SECONDS: Seconds = seconds(60)
export const GRACE_SECONDS: Seconds = seconds(30)
export const RETENTION_SECONDS: Seconds = seconds(3_600)

/**
 * Derived windows, exported so every implementation and the validator share one definition.
 *
 * Expiry is the sole authority on how late a delta may be, so if the validator's notion of
 * "expired" drifts from the store's by even a second, it accepts a bucket whose retained row has
 * already been pruned — and the promotion join then writes only the late portion, which D1's
 * replace semantics turn into a silent undercount. Derive, never restate.
 *
 * The store's own pruning defends the same boundary from the other side: a retained row outlives its
 * expiry for as long as pending or flush-batch state still references it, so an in-flight rewrite
 * always has its subtrahend.
 */
export const FLUSHABLE_AFTER_SECONDS: Seconds = seconds(RESOLUTION_SECONDS + GRACE_SECONDS)
export const EXPIRES_AFTER_SECONDS: Seconds = seconds(FLUSHABLE_AFTER_SECONDS + RETENTION_SECONDS)
/** Event keys outlive every counter timestamp that could have been valid when first received. */
export const COUNTER_IDEMPOTENCY_RETENTION_SECONDS: Seconds = seconds(
  EXPIRES_AFTER_SECONDS + GRACE_SECONDS,
)

/** Prevent unbounded identifiers from creating permanent rows in the shared stores. */
export const MAX_TEMPLATE_ID_LENGTH = 64

/** Bound synchronous validation and writes on the single global counter shard. */
export const MAX_COUNTER_DELTAS_PER_RECORD = 1_000

export interface CounterDelta {
  /** Non-empty template identifier. */
  readonly templateId: string
  /**
   * Safe-integer Unix seconds when the paint happened. This must be the true event time, not the
   * time the caller happened to report it. At record time it must be no later than
   * `now + GRACE_SECONDS`, and its minute bucket must not yet have expired — see
   * `EXPIRES_AFTER_SECONDS`. Until then a rewrite of an already-flushed bucket is absorbed
   * cumulatively, against whatever retained state the store still holds. The exact expiry instant
   * is exclusive.
   */
  readonly occurredAt: Seconds
  /** Non-negative safe integer. */
  readonly placed: number
  /** Non-negative integer no greater than placed. */
  readonly correct: number
  /** Non-negative integer no greater than correct. */
  readonly repairs: number
}

export type CounterValues = Pick<CounterDelta, 'placed' | 'correct' | 'repairs'>

/**
 * Counters accumulated **since the last flush** — not lifetime totals.
 *
 * This distinction is easy to get wrong and expensive when you do. The store is a buffer in front of
 * the time series, so it only ever knows about activity the time series has not absorbed yet.
 *
 * ```
 * live total = time-series history (SqlStore) + pending (CounterStore)
 * ```
 */
export interface PendingCounters {
  readonly templateId: string
  readonly placed: number
  readonly correct: number
  readonly repairs: number
  /** When this shard last folded a bucket into the time series, or null if it never has. */
  readonly flushedAt: Millis | null
}

export interface CounterStore {
  /**
   * Atomically record deltas once for an optional idempotency key.
   *
   * Paint ingestion supplies its event id so a retry after an ambiguous cross-store failure cannot
   * increment this buffer twice. Internal callers and focused adapter tests may omit the key.
   */
  record(deltas: readonly CounterDelta[], idempotencyKey?: string): Promise<void>

  /**
   * Unflushed counters for these templates, reflecting anything recorded up to this moment.
   * Returns one entry per requested id, zeroed where there has been no activity.
   */
  readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]>

  /**
   * Number of deltas rejected as invalid or expired.
   *
   * This counts every rejection, including one at the exact expiry instant while a matching
   * flush-batch row still exists, so it does not mean "nothing local to reconcile against".
   */
  readDroppedLateCount(): Promise<number>

  /**
   * Consecutive failed flushes to the time series, or 0 when the last flush succeeded.
   *
   * The flush deliberately does not throw (see `CounterFlusher.flush`), so the platform records
   * no error for a failed flush. This counter is the signal that replaces it.
   */
  readFlushFailureCount(): Promise<number>
}
