import type { Seconds, TileCoord } from '@caelestis/shared'
import type { SqlStore } from '../ports/index.js'

/** Folds only move rows older than a day, so a fold every half minute per tile loses nothing. */
export const HISTORY_FOLD_INTERVAL_MS = 30_000
const TRACKED_TILES_LIMIT = 4_096

interface StoreFolds {
  /** When each tile last folded successfully, insertion-ordered for bounded eviction. */
  readonly last: Map<string, number>
  /** Folds still running; a tile has at most one regardless of how long it takes. */
  readonly inFlight: Map<string, Promise<void>>
}

const foldsByStore = new WeakMap<object, StoreFolds>()

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
  let folds = foldsByStore.get(sql)
  if (folds === undefined) {
    folds = { last: new Map(), inFlight: new Map() }
    foldsByStore.set(sql, folds)
  }
  const key = `${season}:${tile.x}/${tile.y}`
  // A fold already running covers this observation however long it takes; a burst of same-tile
  // observations joins it instead of each starting its own.
  if (folds.inFlight.has(key)) return 'skipped'
  const last = folds.last.get(key)
  if (last !== undefined && at - last < intervalMs) return 'skipped'
  const running = sql.foldTileHistory(season, tile, now)
  folds.inFlight.set(key, running)
  try {
    await running
  } catch (error) {
    // A failed fold is not remembered, so the next observation retries it.
    folds.inFlight.delete(key)
    throw error
  }
  folds.inFlight.delete(key)
  folds.last.delete(key)
  folds.last.set(key, at)
  if (folds.last.size > TRACKED_TILES_LIMIT) {
    const oldest = folds.last.keys().next().value
    if (oldest !== undefined) folds.last.delete(oldest)
  }
  return 'folded'
}
