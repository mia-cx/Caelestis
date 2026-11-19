import {
  BLANK,
  type ChunkRect,
  chunkRect,
  decodePng,
  decodeWplaceIndexedPng,
  encodeMismatchMask,
  type IndexedImage,
  MATCH,
  PALETTE_RGB,
  PngError,
  pngSize,
  quantiseToPalette,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WRONG,
} from '@caelestis/shared'
import { ingestTimings } from '../metrics/ingest-timing.js'
import type { BlobStore } from '../ports/index.js'
import { BoundedCache, memoize } from '../runtime/bounded-cache.js'
import { PortError } from '../runtime/errors.js'
import type { TileBlobStore } from './blobs/store.js'
import { type ClassificationKey, mismatchArtifactKey } from './derived-artifacts.js'
import { readTileBlob } from './tile-blobs.js'
import type { TelemetryTarget, TileStore } from './tiles/store.js'

export interface ColourClassification {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
}

export interface ChunkClassification {
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  /** Ascending palette index, one entry per colour the chunk wants. */
  readonly colours: readonly ColourClassification[]
  /** One MATCH/WRONG/BLANK byte per chunk pixel; transparent template pixels stay MATCH. */
  readonly classifications: Uint8Array
}

const CLASSES = 3
const INDEX_SPACE = 256

/**
 * Classify one template chunk against the canvas pixels under its rectangle.
 *
 * This is the hottest loop in tile ingestion: a full chunk is one million pixels. It runs on the
 * event loop, so it must not allocate or hash per pixel. Per-colour counts live in one typed array
 * indexed by palette index and class; the colour list is built once at the end.
 */
export const classifyChunk = (
  chunk: Uint8Array,
  canvas: Uint8Array,
  rect: ChunkRect,
): ChunkClassification => {
  const { left, top, width, height } = rect
  if (
    left < 0 ||
    top < 0 ||
    width <= 0 ||
    height <= 0 ||
    left + width > TILE_SIZE ||
    top + height > TILE_SIZE
  ) {
    throw new RangeError('chunk rectangle must fit one canvas tile')
  }
  if (chunk.length !== width * height || canvas.length !== TILE_SIZE * TILE_SIZE) {
    throw new RangeError('chunk and canvas must cover their rectangles')
  }
  const classifications = new Uint8Array(width * height)
  const counts = new Uint32Array(INDEX_SPACE * CLASSES)
  // Locals keep the inner loop free of module-binding reads under every module transform.
  const transparent = TRANSPARENT_INDEX
  const match = MATCH
  const wrongClass = WRONG
  const blankClass = BLANK
  const tileSize = TILE_SIZE
  for (let y = 0; y < height; y += 1) {
    const chunkRow = y * width
    const canvasRow = (top + y) * tileSize + left
    for (let x = 0; x < width; x += 1) {
      const wanted = chunk[chunkRow + x] as number
      if (wanted === transparent) continue
      const actual = canvas[canvasRow + x] as number
      const classification =
        actual === transparent ? blankClass : actual === wanted ? match : wrongClass
      classifications[chunkRow + x] = classification
      const slot = wanted * CLASSES + classification
      counts[slot] = (counts[slot] as number) + 1
    }
  }
  let correct = 0
  let wrong = 0
  let blank = 0
  const colours: ColourClassification[] = []
  for (let index = 0; index < INDEX_SPACE; index += 1) {
    const matched = counts[index * CLASSES + MATCH] ?? 0
    const mismatched = counts[index * CLASSES + WRONG] ?? 0
    const missing = counts[index * CLASSES + BLANK] ?? 0
    const total = matched + mismatched + missing
    if (total === 0) continue
    correct += matched
    wrong += mismatched
    blank += missing
    colours.push({ index, correct: matched, wrong: mismatched, blank: missing, total })
  }
  return { correct, wrong, blank, colours, classifications }
}

export type ClassificationTarget = Pick<
  TelemetryTarget,
  'templateId' | 'versionId' | 'bbox' | 'tileX' | 'tileY' | 'hash'
>

/** A classification without anything observation-specific: no reporter, no timestamp. */
export interface Classification {
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly colours: readonly ColourClassification[]
  readonly mask: Uint8Array
}

const MINUTES = 60 * 1_000

// Module scope, because concurrent requests in one Worker isolate share nothing else. Both caches
// hold only what immutable, content-addressed inputs rebuild.

/** Decoded canvases and template chunks; a pending decode is shared by every target that needs it. */
const decodedImages = new BoundedCache<Promise<IndexedImage | null>>({
  maxBytes: 24 * 1024 * 1024,
  maxEntries: 96,
  ttlMs: 3 * MINUTES,
})

/**
 * Classifications shared across reporters. Several routinely observe the same canvas bytes for the
 * same chunk within seconds; the first computes the counts and mask and the rest reuse them.
 * Bounded by mask bytes: one full canvas tile packs to about 250 KiB.
 */
const sharedClassifications = new BoundedCache<Promise<Classification | null>>({
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 128,
  ttlMs: 3 * MINUTES,
})

const COLOUR_ENTRY_BYTES = 40
const STATUS_BYTES = 64

/** Reporter tile bytes the server refuses: answered as the reporter's mistake, not a 500. */
export class InvalidTileError extends PortError {
  override readonly name = 'InvalidTileError'
  readonly kind = 'invalid'
}

const decodeCanvas = async (bytes: Uint8Array): Promise<IndexedImage> => {
  try {
    // Reporters upload these. Check the header before decoding allocates the size it declares.
    const { width, height } = pngSize(bytes)
    if (width !== TILE_SIZE || height !== TILE_SIZE) {
      throw new InvalidTileError(
        `canvas tile is ${width}x${height}, expected ${TILE_SIZE}x${TILE_SIZE}`,
      )
    }
    const { indices } = quantiseToPalette((await decodePng(bytes)).pixels, PALETTE_RGB)
    return { width, height, indices }
  } catch (cause) {
    // A reporter's file that does not decode is their bad input, not a server fault to retry.
    if (cause instanceof PngError) throw new InvalidTileError(cause.message, { cause })
    throw cause
  }
}

const imageBytes = (image: IndexedImage | null): number => image?.indices.byteLength ?? 0

/** Decode uploaded canvas bytes to palette indices. A wrong-sized or undecodable tile rejects as invalid. */
export const decodeCanvasBytes = async (hash: string, bytes: Uint8Array): Promise<Uint8Array> => {
  const image = await memoize(
    decodedImages,
    `canvas:${hash}`,
    () => decodeCanvas(bytes),
    imageBytes,
  )
  // A concurrent read of a missing stored blob resolves null; these bytes are still decodable.
  return (image ?? (await decodeCanvas(bytes))).indices
}

export const readDecodedCanvas = async (
  ports: { readonly blobs: BlobStore; readonly sql: TileStore & TileBlobStore },
  hash: string,
): Promise<Uint8Array | null> => {
  try {
    const image = await memoize(
      decodedImages,
      `canvas:${hash}`,
      async () => {
        const bytes = await readTileBlob(ports, hash)
        return bytes === null ? null : decodeCanvas(bytes)
      },
      imageBytes,
    )
    return image?.indices ?? null
  } catch (error) {
    // A corrupt stored canvas reads as unobserved, so one bad blob cannot fail a whole replay.
    console.error(`stored canvas ${hash} is unreadable`, error)
    return null
  }
}

export const readDecodedChunk = (
  ports: { readonly blobs: BlobStore },
  hash: string,
): Promise<IndexedImage | null> =>
  memoize(
    decodedImages,
    `chunk:${hash}`,
    async () => {
      const bytes = await ports.blobs.get('chunks', hash)
      return bytes === null ? null : decodeWplaceIndexedPng(bytes)
    },
    imageBytes,
  )

/** The chunk's rectangle on its tile and its pixels, or null when they disagree with the bounds. */
export const readTargetChunk = async (
  ports: { readonly blobs: BlobStore },
  target: ClassificationTarget,
): Promise<{ readonly rect: ChunkRect; readonly indices: Uint8Array } | null> => {
  const rect = chunkRect(target.bbox, { x: target.tileX, y: target.tileY })
  if (rect === null) return null
  const chunk = await readDecodedChunk(ports, target.hash)
  if (chunk === null || chunk.width !== rect.width || chunk.height !== rect.height) return null
  return { rect, indices: chunk.indices }
}

export const classificationKey = (
  target: ClassificationTarget,
  canvasHash: string,
): ClassificationKey => ({
  templateId: target.templateId,
  versionId: target.versionId,
  tile: { x: target.tileX, y: target.tileY },
  canvasHash,
})

/** Classify one target against a decoded canvas, sharing identical work across callers. */
export const classifyTarget = async (
  ports: { readonly blobs: BlobStore },
  target: ClassificationTarget,
  canvas: Uint8Array,
  canvasHash: string,
): Promise<Classification | null> => {
  let computed = false
  const classified = await memoize(
    sharedClassifications,
    mismatchArtifactKey(classificationKey(target, canvasHash)),
    async () => {
      computed = true
      const chunk = await readTargetChunk(ports, target)
      if (chunk === null) return null
      const { correct, wrong, blank, colours, classifications } = classifyChunk(
        chunk.indices,
        canvas,
        chunk.rect,
      )
      return {
        correct,
        wrong,
        blank,
        colours,
        mask: encodeMismatchMask(chunk.rect, classifications),
      }
    },
    (value) =>
      value === null
        ? 0
        : value.mask.byteLength + STATUS_BYTES + value.colours.length * COLOUR_ENTRY_BYTES,
  )
  ingestTimings.count(computed ? 'classification.computed' : 'classification.shared')
  return classified
}
