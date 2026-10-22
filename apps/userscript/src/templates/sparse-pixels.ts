import { TRANSPARENT_INDEX } from '@caelestis/shared'

/**
 * Template pixels cut into square chunks, keeping only chunks with something painted.
 *
 * A sparse alliance template is mostly transparent, and a dense array costs its whole bounding box
 * in memory, on disk and on the GPU. Chunks sit on the template's own grid rather than the world's,
 * so moving a template never re-cuts its pixels.
 */

/** Chunk edge in pixels, matching a world tile so a chunk overlaps at most four of them. */
export const PIXEL_CHUNK_SIZE = 1000

/** One painted chunk: a rectangle in template coordinates and its palette indices, row-major. */
export interface PixelChunk {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly indices: Uint8Array
}

export interface SparsePixels {
  readonly width: number
  readonly height: number
  /** Painted chunks by grid key (`row * columns + column`), in grid order. */
  readonly chunks: ReadonlyMap<number, PixelChunk>
}

const columnsOf = (width: number): number => Math.ceil(width / PIXEL_CHUNK_SIZE)

const chunkRect = (width: number, height: number, key: number) => {
  const columns = columnsOf(width)
  const x = (key % columns) * PIXEL_CHUNK_SIZE
  const y = Math.floor(key / columns) * PIXEL_CHUNK_SIZE
  return {
    x,
    y,
    width: Math.min(PIXEL_CHUNK_SIZE, width - x),
    height: Math.min(PIXEL_CHUNK_SIZE, height - y),
  }
}

/** Cut a dense row-major image into chunks, dropping those with nothing painted. */
export const cutPixels = (width: number, height: number, dense: Uint8Array): SparsePixels => {
  const chunks = new Map<number, PixelChunk>()
  const keys = columnsOf(width) * Math.ceil(height / PIXEL_CHUNK_SIZE)
  for (let key = 0; key < keys; key++) {
    const rect = chunkRect(width, height, key)
    const indices = new Uint8Array(rect.width * rect.height)
    let painted = false
    for (let row = 0; row < rect.height; row++) {
      const start = (rect.y + row) * width + rect.x
      const line = dense.subarray(start, start + rect.width)
      indices.set(line, row * rect.width)
      if (!painted) painted = line.some((index) => index !== TRANSPARENT_INDEX)
    }
    if (painted) chunks.set(key, { ...rect, indices })
  }
  return { width, height, chunks }
}

/**
 * A dense copy of a rectangle in template coordinates; anything outside a painted chunk or the
 * template reads as transparent.
 */
export const pixelRect = (
  pixels: SparsePixels,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array => {
  const out = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  for (const chunk of pixels.chunks.values()) {
    const fromX = Math.max(left, chunk.x)
    const toX = Math.min(left + width, chunk.x + chunk.width)
    const fromY = Math.max(top, chunk.y)
    const toY = Math.min(top + height, chunk.y + chunk.height)
    if (toX <= fromX || toY <= fromY) continue
    for (let y = fromY; y < toY; y++) {
      const start = (y - chunk.y) * chunk.width + (fromX - chunk.x)
      out.set(chunk.indices.subarray(start, start + toX - fromX), (y - top) * width + fromX - left)
    }
  }
  return out
}

/** The whole image as one dense row-major array, for work that needs it all at once. */
export const joinPixels = (pixels: SparsePixels): Uint8Array =>
  pixelRect(pixels, 0, 0, pixels.width, pixels.height)

/** The palette index at a template coordinate; transparent outside every painted chunk. */
export const pixelAt = (pixels: SparsePixels, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return TRANSPARENT_INDEX
  const key =
    Math.floor(y / PIXEL_CHUNK_SIZE) * columnsOf(pixels.width) + Math.floor(x / PIXEL_CHUNK_SIZE)
  const chunk = pixels.chunks.get(key)
  if (chunk === undefined) return TRANSPARENT_INDEX
  return chunk.indices[(y - chunk.y) * chunk.width + (x - chunk.x)] ?? TRANSPARENT_INDEX
}

/** Pixels held in memory, which is what the resident budget counts. */
export const storedArea = (pixels: SparsePixels): number => {
  let area = 0
  for (const chunk of pixels.chunks.values()) area += chunk.indices.length
  return area
}

/** Pixels as stored on disk: every painted chunk's bytes back to back, and which chunks they are. */
export interface PackedPixels {
  readonly bytes: Uint8Array
  readonly chunks: readonly number[]
}

export const packPixels = (pixels: SparsePixels): PackedPixels => {
  const bytes = new Uint8Array(storedArea(pixels))
  let offset = 0
  for (const chunk of pixels.chunks.values()) {
    bytes.set(chunk.indices, offset)
    offset += chunk.indices.length
  }
  return { bytes, chunks: [...pixels.chunks.keys()] }
}

/** Read packed bytes back without copying them; null when they do not fit the layout. */
export const unpackPixels = (
  width: number,
  height: number,
  { bytes, chunks: keys }: PackedPixels,
): SparsePixels | null => {
  const chunks = new Map<number, PixelChunk>()
  const limit = columnsOf(width) * Math.ceil(height / PIXEL_CHUNK_SIZE)
  let offset = 0
  for (const key of keys) {
    if (!Number.isInteger(key) || key < 0 || key >= limit || chunks.has(key)) return null
    const rect = chunkRect(width, height, key)
    const area = rect.width * rect.height
    chunks.set(key, { ...rect, indices: bytes.subarray(offset, offset + area) })
    offset += area
  }
  return offset === bytes.length ? { width, height, chunks } : null
}
