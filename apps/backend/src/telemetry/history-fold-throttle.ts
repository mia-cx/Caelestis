import type { Seconds, TileCoord } from '@caelestis/shared'
import { BoundedCache } from './bounded-cache.js'
import type { TileStore } from './tiles/store.js'

/** Folds only move rows older than a day, so a fold every half minute per tile loses nothing. */
export const HISTORY_FOLD_INTERVAL_MS = 30_000
const TRACKED_TILES_LIMIT = 4_096

interface StoreFolds {
  /** When each tile last folded successfully. */
  readonly last: BoundedCache<number>
  /** Folds still running; a tile has at most one regardless of how long it takes. */
  readonly inFlight: Map<string, Promise<void>>
}

/** Keyed by store instance so separate runtimes and tests never share throttles. */
const foldsByStore = new WeakMap<object, StoreFolds>()

export type HistoryFoldOutcome = 'folded' | 'skipped'

/**
 * Fold one tile's history at most once per interval on this runtime.
 *
 * The fold walks every decay edge with its own queries, the largest database cost of a live reply.
 * Its only job is to move raw rows older than a day into coarser tiers, so folding on a tile's
 * first observation and then at most every interval changes nothing a reader can see. A fold that
 * throws is not remembered, so the next observation retries it.
 */
export const foldTileHistoryThrottled = async (
  sql: TileStore,
  season: number,
  tile: TileCoord,
  now: Seconds,
  options: { readonly intervalMs?: number; readonly clock?: () => number } = {},
): Promise<HistoryFoldOutcome> => {
  const intervalMs = options.intervalMs ?? HISTORY_FOLD_INTERVAL_MS
  const at = (options.clock ?? Date.now)()
  let folds = foldsByStore.get(sql)
  if (folds === undefined) {
    folds = { last: new BoundedCache({ maxEntries: TRACKED_TILES_LIMIT }), inFlight: new Map() }
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
  } finally {
    folds.inFlight.delete(key)
  }
  folds.last.set(key, at)
  return 'folded'
}
