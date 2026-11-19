import { TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { count } from './debug.js'
import { notifyEach } from './page-hooks.js'

/** Where a change of a world tile's captured pixels came from. */
export type PixelChangeSource = 'draft' | 'server' | 'accepted' | 'observed'

/** Tile-local `x, y, index` triples changed by one operation, flat. */
type PixelBatchListener = (
  tile: TileCoord,
  triples: readonly number[],
  source: PixelChangeSource,
) => void

const listeners: PixelBatchListener[] = []
const invalidators: ((tile: TileCoord) => void)[] = []

/** Notified once for a group of tile-local x/y/index triples changed by the same operation. */
export const onTilePixels = (listener: PixelBatchListener): void => {
  listeners.push(listener)
}

/**
 * Drop something derived from a tile's pixels whenever they may have changed, before any listener
 * hears of it, so a listener reading it back sees the change.
 */
export const invalidateOnTilePixels = (invalidate: (tile: TileCoord) => void): void => {
  invalidators.push(invalidate)
}

/** Announce one operation's changed pixels. An empty batch still invalidates derived state. */
export const notifyPixelBatch = (
  tile: TileCoord,
  triples: readonly number[],
  source: PixelChangeSource,
): void => {
  for (const invalidate of invalidators) invalidate(tile)
  if (triples.length === 0) return
  count(`pixels:${source} notification batches`)
  count(`pixels:${source} notified pixels`, triples.length / 3)
  notifyEach(listeners, (listener) => listener(tile, triples, source), 'pixels:listener-failed')
}

/**
 * Move `into` to match `from`, announcing each pixel that moves as one batch.
 *
 * The array itself is kept. Anything holding an answer derived from this tile keys it on the array's
 * identity, so replacing it says "all of this is stale" — and recomputing a tile because one pixel
 * moved is what made every marker in it disappear and come back.
 *
 * `only` limits a full `from` to the offsets already known to differ, such as a tile reader's diff.
 * `moved` sees each offset that changed, with its new index.
 */
export const applyPixels = (
  tile: TileCoord,
  into: Uint8Array,
  from: Uint8Array | Map<number, number>,
  source: PixelChangeSource,
  only: Uint32Array | null = null,
  moved?: (offset: number, index: number) => void,
): number => {
  const changedTriples: number[] = []
  const at = (p: number, index: number): void => {
    if (into[p] === index) return
    into[p] = index
    moved?.(p, index)
    const x = p % TILE_SIZE
    changedTriples.push(x, (p - x) / TILE_SIZE, index)
  }
  if (from instanceof Map) for (const [p, index] of from) at(p, index)
  else if (only !== null) for (const p of only) at(p, from[p] as number)
  else for (let p = 0; p < from.length; p++) at(p, from[p] as number)
  notifyPixelBatch(tile, changedTriples, source)
  const changed = changedTriples.length / 3
  if (changed > 0) count('pixels:changed', changed)
  return changed
}
