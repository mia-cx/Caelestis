import type { Seconds } from '@caelestis/shared'
import { type DecayEdge, foldCutoff, targetWindowStart } from '../decay.js'

/** One folded bucket of the decay ladder. */
export interface TelemetryBucket {
  readonly templateId: string
  /** A `LADDER_RESOLUTIONS` width in seconds. */
  readonly resolution: number
  /** Unix seconds, floored to `resolution`. */
  readonly bucketStart: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * One painter's share of a folded bucket: `telemetry_buckets` with a painter in the key.
 *
 * Painter buckets are written straight from each paint report rather than through the counter
 * shard, and they add up rather than replace: every event is applied once, under the
 * `applied_events` claim, so an additive upsert is exact and needs no retained-state reconciliation.
 * The fold is additive for the same reason, which is what lets a late report land at whichever
 * tier its window has already reached (`painterBucketResolution`) without a later fold overwriting
 * it.
 */
export interface PainterTelemetryBucket extends TelemetryBucket {
  readonly wplaceUserId: number
}

/** Bucket widths the telemetry ladder folds to. */
export const LADDER_RESOLUTIONS: readonly number[] = [60, 300, 900, 3_600, 21_600]

/** Delta buckets compact only after the complete target window has aged past this boundary. */
export const TELEMETRY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 60, target: 300, retainSeconds: 6 * 3_600 },
  { source: 300, target: 900, retainSeconds: 24 * 3_600 },
  { source: 900, target: 3_600, retainSeconds: 7 * 86_400 },
  { source: 3_600, target: 21_600, retainSeconds: 30 * 86_400 },
]

/**
 * The domain `telemetry_buckets` will actually store: an aligned, non-negative `bucketStart`, a
 * ladder `resolution`, and integer counters with `repairs <= correct <= placed`.
 *
 * The CHECKs enforce the same, but checking first turns a poison row into a synchronous error that
 * names the column. That matters on the flush path: `CounterFlusher.flush` catches the rejection
 * and re-arms without clearing `flush_batch`, so one poison row would be re-sent every alarm forever.
 */
const invalidBucket = (bucket: TelemetryBucket): string | null => {
  const { resolution, bucketStart, placed, correct, repairs } = bucket
  if (!LADDER_RESOLUTIONS.includes(resolution))
    return `resolution ${resolution} is not a ladder tier`
  if (!Number.isSafeInteger(bucketStart) || bucketStart < 0) {
    return `bucketStart ${bucketStart} is not a non-negative integer`
  }
  if (bucketStart % resolution !== 0) {
    return `bucketStart ${bucketStart} is not a multiple of resolution ${resolution}`
  }
  if (![placed, correct, repairs].every(Number.isSafeInteger)) return 'counters must be integers'
  if (!(repairs >= 0 && repairs <= correct && correct <= placed)) {
    return `counters must satisfy 0 <= repairs <= correct <= placed, got ${repairs}, ${correct}, ${placed}`
  }
  return null
}

export const assertValidBuckets = (buckets: readonly TelemetryBucket[]): void => {
  for (const bucket of buckets) {
    const reason = invalidBucket(bucket)
    if (reason !== null) throw new Error(`appendAndFold rejected${bucket.templateId}: ${reason}`)
  }
}

const invalidPainterBucket = (bucket: PainterTelemetryBucket): string | null => {
  if (!Number.isSafeInteger(bucket.wplaceUserId) || bucket.wplaceUserId < 0) {
    return `wplaceUserId ${bucket.wplaceUserId} is not a non-negative integer`
  }
  return invalidBucket(bucket)
}

export const assertValidPainterBuckets = (buckets: readonly PainterTelemetryBucket[]): void => {
  for (const bucket of buckets) {
    const reason = invalidPainterBucket(bucket)
    if (reason !== null) throw new Error(`painter bucket rejected ${bucket.templateId}: ${reason}`)
  }
}

/**
 * The order every bucket read returns.
 *
 * Compared with `<`/`>` rather than `localeCompare`, which matches SQLite's BINARY collation and is
 * total. `localeCompare` treats default-ignorable codepoints as equal — `'a­b'` ties with `'ab'` —
 * and a tie would fall back to whatever order the rows arrived in.
 */
export const compareBuckets = (left: TelemetryBucket, right: TelemetryBucket): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.bucketStart - right.bucketStart
}

/** `compareBuckets` with the painter id between template and time, matching the primary key. */
export const comparePainterBuckets = (
  left: PainterTelemetryBucket,
  right: PainterTelemetryBucket,
): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.wplaceUserId - right.wplaceUserId || left.bucketStart - right.bucketStart
}

/**
 * The ladder tier a paint at `occurredAt` belongs to when it is written at `now`.
 *
 * Walks the decay edges with the fold's own predicate: once the target window containing the paint
 * has aged past an edge's retention, the fold has moved (or will move) every finer row in that
 * window up a tier, so a fresh finer row would only sit invisible under the coarser one until the
 * next fold sums it in. Writing at the reached tier instead keeps late reports readable at once.
 */
export const painterBucketResolution = (occurredAt: Seconds, now: Seconds): number => {
  let resolution = LADDER_RESOLUTIONS[0] ?? 60
  for (const edge of TELEMETRY_DECAY_EDGES) {
    if (edge.source !== resolution) break
    if (targetWindowStart(occurredAt, edge) + edge.target > foldCutoff(edge, now)) break
    resolution = edge.target
  }
  return resolution
}
