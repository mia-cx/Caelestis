import type { TileCoord } from '@caelestis/shared'
import type { ColourClassification } from './classify-chunk.js'
import { DecodedPixelCache } from './decoded-pixel-cache.js'

/** Every input that can change a classification result. */
export interface SharedClassificationKey {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  /** Content hash of the template chunk under this tile. */
  readonly chunkHash: string
  /** Content hash of the observed canvas tile. */
  readonly canvasHash: string
}

/** A classification without anything observation-specific: no reporter, no timestamp. */
export interface SharedClassification {
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly colours: readonly ColourClassification[]
  readonly mask: Uint8Array
}

export interface SharedClassifier {
  /**
   * Classify once per distinct key while the result is cached, sharing the pending promise with
   * every concurrent caller. A `null` result (missing chunk, shape mismatch) is never retained.
   */
  readonly classify: (
    key: SharedClassificationKey,
    load: () => Promise<SharedClassification | null>,
  ) => Promise<SharedClassification | null>
}

const COLOUR_ENTRY_BYTES = 40
const STATUS_BYTES = 64

/** Bound by mask bytes: one full canvas tile packs to about 250 KiB. */
export const DEFAULT_SHARED_CLASSIFICATION_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_SHARED_CLASSIFICATION_MAX_ENTRIES = 128
export const DEFAULT_SHARED_CLASSIFICATION_TTL_MS = 3 * 60 * 1_000

export const sharedClassificationKey = (key: SharedClassificationKey): string =>
  `classified:${key.templateId}:${key.versionId}:${key.tile.x}/${key.tile.y}:${key.chunkHash}:${key.canvasHash}`

const sizeOf = (value: SharedClassification | null): number =>
  value === null
    ? 0
    : value.mask.byteLength + STATUS_BYTES + value.colours.length * COLOUR_ENTRY_BYTES

/**
 * Share identical classification work across reporters.
 *
 * Several reporters routinely observe the same canvas bytes for the same template chunk within
 * seconds of each other. The counts and mask depend only on those two inputs, so the first caller
 * computes them and the rest reuse the pending or finished result. Each caller still records its
 * own observation with its own reporter and timestamp; only the reusable computation is shared.
 * The cache owns no canonical state: eviction, expiry, or restart only causes recomputation.
 */
export const createSharedClassifier = (
  options: { readonly cache?: DecodedPixelCache } = {},
): SharedClassifier => {
  const cache =
    options.cache ??
    new DecodedPixelCache({
      maxBytes: DEFAULT_SHARED_CLASSIFICATION_MAX_BYTES,
      maxEntries: DEFAULT_SHARED_CLASSIFICATION_MAX_ENTRIES,
      ttlMs: DEFAULT_SHARED_CLASSIFICATION_TTL_MS,
    })
  return {
    classify: (key, load) => cache.get(sharedClassificationKey(key), load, sizeOf),
  }
}

export const sharedClassifier = createSharedClassifier()
