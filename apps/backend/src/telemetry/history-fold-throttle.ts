import type { Seconds, TileCoord } from '@caelestis/shared'
import type { SqlStore } from '../ports/index.js'

/** Folds only move rows older than a day, so a fold every half minute per tile loses nothing. */
export const HISTORY_FOLD_INTERVAL_MS = 30_000
const TRACKED_TILES_LIMIT = 4_096

const lastFoldsByStore = new WeakMap<object, Map<string, number>>()

export type HistoryFoldOutcome = 'folded' | 'skipped'

/**
 * Fold one tile's history at most once per interval on this runtime.
 *
 * The fold walks every decay edge with its own queries, and it used to run after every accepted
 * observation, which made it the largest single database cost of a live reply. Its only job is to
 * move raw rows older than a day into coarser tiers, so running it on the first observation of a
 * tile and then no more than every thirty seconds changes nothing a reader can see. A fold that
 * throws is not recorded, so the next observation retries it, as before. Throttles are keyed by
 * store instance so separate runtimes and tests never share state.
 */
export const foldTileHistoryThrottled = async (
  sql: SqlStore,
  season: number,
  tile: TileCoord,
  now: Seconds,
  options: { readonly intervalMs?: number; readonly clock?: () => number } = {},
): Promise<HistoryFoldOutcome> => {
  const intervalMs = options.intervalMs ?? HISTORY_FOLD_INTERVAL_MS
  const at = (options.clock ?? Date.now)()
  let lastFolds = lastFoldsByStore.get(sql)
  if (lastFolds === undefined) {
    lastFolds = new Map()
    lastFoldsByStore.set(sql, lastFolds)
  }
  const key = `${season}:${tile.x}/${tile.y}`
  const last = lastFolds.get(key)
  if (last !== undefined && at - last < intervalMs) return 'skipped'
  // Reserve the key before awaiting, so a burst of same-tile observations joins this fold
  // instead of each starting its own. A failure gives the key back for the next observation.
  lastFolds.delete(key)
  lastFolds.set(key, at)
  if (lastFolds.size > TRACKED_TILES_LIMIT) {
    const oldest = lastFolds.keys().next().value
    if (oldest !== undefined) lastFolds.delete(oldest)
  }
  try {
    await sql.foldTileHistory(season, tile, now)
  } catch (error) {
    if (lastFolds.get(key) === at) lastFolds.delete(key)
    throw error
  }
  return 'folded'
}
