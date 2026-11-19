import { type Seconds, seconds } from './time.js'

/**
 * How long the server keeps history at each precision. Clients read these to ask only for what can
 * still change and for the tiers that still exist; the backend implements them.
 */

/** Live counters bucket per minute, flush after a grace period, and accept late reports this long. */
export const COUNTER_RESOLUTION_SECONDS: Seconds = seconds(60)
export const COUNTER_GRACE_SECONDS: Seconds = seconds(30)
export const COUNTER_RETENTION_SECONDS: Seconds = seconds(3_600)

/**
 * Derived windows, exported so every implementation and the validator share one definition: derive,
 * never restate. Expiry is the sole authority on how late a delta may be, so if the validator's
 * notion of "expired" drifts from the store's by even a second, it accepts a bucket whose retained
 * row has already been pruned — and the promotion join then writes only the late portion, which
 * D1's replace semantics turn into a silent undercount.
 *
 * The store's own pruning defends the same boundary from the other side: a retained row outlives its
 * expiry for as long as pending or flush-batch state still references it, so an in-flight rewrite
 * always has its subtrahend.
 */
export const COUNTER_FLUSHABLE_AFTER_SECONDS: Seconds = seconds(
  COUNTER_RESOLUTION_SECONDS + COUNTER_GRACE_SECONDS,
)
/** After this long a bucket's counters no longer change, short of a backlog after an outage. */
export const COUNTER_EXPIRES_AFTER_SECONDS: Seconds = seconds(
  COUNTER_FLUSHABLE_AFTER_SECONDS + COUNTER_RETENTION_SECONDS,
)

/** One compaction step: `source`-wide buckets older than `retainSeconds` fold into `target`. */
export interface DecayEdge {
  readonly source: number
  readonly target: number
  readonly retainSeconds: number
}

/** How long tile observations stay raw, and how long their hourly folds stay. */
export const RAW_TILE_HISTORY_SECONDS = 86_400
export const HOURLY_TILE_HISTORY_SECONDS = 7 * 86_400

/** Tile observations: raw for a day, hourly for a week, six-hourly for a month, then daily. */
export const TILE_HISTORY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 0, target: 3_600, retainSeconds: RAW_TILE_HISTORY_SECONDS },
  { source: 3_600, target: 21_600, retainSeconds: HOURLY_TILE_HISTORY_SECONDS },
  { source: 21_600, target: 86_400, retainSeconds: 30 * 86_400 },
]
