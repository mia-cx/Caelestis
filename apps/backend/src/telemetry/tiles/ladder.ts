import { type Seconds, seconds, type TileCoord, type TileHistoryFrame } from '@caelestis/shared'

/** Bucket widths `tile_history` folds to. 0 is raw. */
export const TILE_HISTORY_RESOLUTIONS: readonly number[] = [0, 3_600, 21_600, 86_400]

export const tileCaptureTime = (bucketStart: Seconds, resolution: number): Seconds =>
  seconds(bucketStart + Math.max(0, resolution - 1))

export { TILE_HISTORY_DECAY_EDGES } from '@caelestis/shared'

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
 * split goes to the lexically smaller hash — `<`, not `localeCompare`, so the order matches SQLite's
 * BINARY collation and is total. A timelapse must not flicker between competing hashes depending on
 * map iteration order. `bucketWinners` in `relational.ts` casts the same vote in SQL.
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
