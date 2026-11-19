import { type Seconds, seconds, type TileCoord, type TileHistoryFrame } from '@caelestis/shared'

/**
 * The decay ladders: which tiers telemetry and tile history fold to, when, and how a fold merges
 * rows. `db/schema.ts` renders its resolution CHECKs from these lists, so a ladder change shows up
 * as a schema diff.
 */

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

export interface DecayEdge {
  readonly source: number
  readonly target: number
  readonly retainSeconds: number
}

/** Delta buckets compact only after the complete target window has aged past this boundary. */
export const TELEMETRY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 60, target: 300, retainSeconds: 6 * 3_600 },
  { source: 300, target: 900, retainSeconds: 24 * 3_600 },
  { source: 900, target: 3_600, retainSeconds: 7 * 86_400 },
  { source: 3_600, target: 21_600, retainSeconds: 30 * 86_400 },
]

/** Target groups processed per tier and write touch. Backlogs drain over later saves. */
export const DECAY_FOLD_GROUP_LIMIT = 20

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
    if (reason !== null) throw new Error(`appendBuckets rejected ${bucket.templateId}: ${reason}`)
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
    const targetStart = Math.floor(occurredAt / edge.target) * edge.target
    if (targetStart + edge.target > now - edge.retainSeconds) break
    resolution = edge.target
  }
  return resolution
}

/** Bucket widths `tile_history` folds to. 0 is raw. */
export const TILE_HISTORY_RESOLUTIONS: readonly number[] = [0, 3_600, 21_600, 86_400]

export const TILE_HISTORY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 0, target: 3_600, retainSeconds: 86_400 },
  { source: 3_600, target: 21_600, retainSeconds: 7 * 86_400 },
  { source: 21_600, target: 86_400, retainSeconds: 30 * 86_400 },
]

/** One physical reporter row carried between tile-history tiers. */
export interface TileHistoryReporterRow {
  readonly season: number
  readonly tile: TileCoord
  readonly resolution: number
  readonly bucketStart: Seconds
  readonly hash: string
  readonly reportedWithToken: string
  readonly reportedByUserId: number
}

/** Latest source bucket wins; quorum chooses its hash; every winning reporter row survives. */
export const foldTileReporterRows = (
  rows: readonly TileHistoryReporterRow[],
  targetResolution: number,
): readonly TileHistoryReporterRow[] => {
  const targetGroups = new Map<number, TileHistoryReporterRow[]>()
  for (const row of rows) {
    const targetStart = Math.floor(row.bucketStart / targetResolution) * targetResolution
    const held = targetGroups.get(targetStart)
    if (held === undefined) targetGroups.set(targetStart, [row])
    else held.push(row)
  }

  const folded: TileHistoryReporterRow[] = []
  for (const [targetStart, group] of targetGroups) {
    const reporters = new Map<string, Set<number>>()
    for (const row of group) {
      const key = `${row.bucketStart}\u0000${row.hash}`
      const held = reporters.get(key)
      if (held === undefined) reporters.set(key, new Set([row.reportedByUserId]))
      else held.add(row.reportedByUserId)
    }
    const frames = foldTileFrames(
      [...reporters].map(([key, accounts]) => {
        const separator = key.indexOf('\u0000')
        return {
          bucketStart: seconds(Number(key.slice(0, separator))),
          hash: key.slice(separator + 1),
          reporters: accounts.size,
        }
      }),
    )
    const latest = frames.at(-1)
    if (latest === undefined) continue
    folded.push(
      ...group
        .filter((row) => row.bucketStart === latest.bucketStart && row.hash === latest.hash)
        .map((row) => ({
          ...row,
          resolution: targetResolution,
          bucketStart: seconds(targetStart),
        })),
    )
  }
  return folded
}

/** One grouped `tile_history` row: a hash and how many distinct accounts reported it. */
export interface TileFrameCandidate {
  readonly bucketStart: Seconds
  readonly hash: string
  readonly reporters: number
}

/**
 * Collapse grouped tile-history rows to one frame per bucket, sorted by bucket start ascending.
 *
 * The tie rules are the contract: the hash with the most distinct reporters wins, and an even
 * split goes to the lexically smaller hash — `<`, not `localeCompare`, for the reason
 * `compareBuckets` states. A timelapse must not flicker between competing hashes depending on map
 * iteration order.
 */
export const foldTileFrames = (
  candidates: readonly TileFrameCandidate[],
): readonly TileHistoryFrame[] => {
  const best = new Map<number, TileFrameCandidate>()
  for (const candidate of candidates) {
    const held = best.get(candidate.bucketStart)
    if (
      held === undefined ||
      candidate.reporters > held.reporters ||
      (candidate.reporters === held.reporters && candidate.hash < held.hash)
    ) {
      best.set(candidate.bucketStart, candidate)
    }
  }
  return [...best.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .map(({ bucketStart, hash, reporters }) => ({ bucketStart, hash, reporters }))
}
