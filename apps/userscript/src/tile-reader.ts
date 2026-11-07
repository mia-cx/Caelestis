import { WPLACE_PALETTE } from '@caelestis/shared'
import { warn } from './debug.js'
import { recordProfileDuration } from './profile.js'
import { buildExactRgbIndex, canvasRgbIndex } from './rgb-index.js'

/**
 * Tile reads, on a thread of their own.
 *
 * Capturing a tile decodes a 1000x1000 PNG, reads its 4 MB back from a canvas, matches a million
 * pixels to the palette, and diffs them against the pixels it replaces. On the page that ran inside
 * Wplace's own `createImageBitmap` promise, so Wplace could not draw a tile until Caelestis had read
 * it. The worker does all of it from the tile's body; the page only applies the pixels that changed.
 *
 * The worker also fetches the tiles capture missed, where no page script can rewrite them. Blue Marble
 * hands Wplace every tile under its templates upscaled 3x, with its template drawn in; a worker's
 * `fetch` belongs to no page script.
 *
 * **The worker is built from `readTileBody`'s source**, as the mismatch worker is from `scanTile`,
 * so the page-side fallback runs the same conversion. Everything here may fail: a page whose CSP
 * refuses `blob:` workers, or a worker that dies, sends every read to the page instead.
 */

/** A tile body as the server sent it; null for a tile with nothing painted. */
export interface TileBody {
  readonly body: Blob | null
  /** SHA-256 of the body, for capture-dedupe; null when it could not be hashed. */
  readonly digest: ArrayBuffer | null
}

/** A tile read into palette indices. */
export interface TilePixelsRead {
  readonly indices: Uint8Array
  /** Ascending offsets where `indices` differs from the base it was read against; null without one. */
  readonly changed: Uint32Array | null
  /** Whether a canvas was read back. An empty tile needs none. */
  readonly readBack: boolean
}

/** What `readTileBody` decodes and reads back with, in the worker or on the page. */
export interface TileReading {
  readonly table: Uint32Array
  readonly decode: (body: Blob) => Promise<ImageBitmap>
  readonly context: () => OffscreenCanvasRenderingContext2D | null
  readonly rgbIndex: typeof canvasRgbIndex
}

/**
 * Read a tile body into palette indices, and diff it against `base`. A null body, or the 1x1 image
 * Wplace serves for an absent tile, reads as all unpainted. Null for any other size, such as another
 * script's 3x rewrite.
 *
 * Self-contained, because the worker is built from its source: `size` is `TILE_SIZE` and
 * `unpainted` is `UNPAINTED`.
 */
export const readTileBody = async (
  body: Blob | null,
  base: Uint8Array | null,
  reading: TileReading,
): Promise<TilePixelsRead | null> => {
  const size = 1000
  const unpainted = 255
  const indices = new Uint8Array(size * size)
  let readBack = false
  if (body === null) {
    indices.fill(unpainted)
  } else {
    const bitmap = await reading.decode(body)
    try {
      if (bitmap.width < size && bitmap.height < size) {
        indices.fill(unpainted)
      } else {
        if (bitmap.width !== size || bitmap.height !== size) return null
        const context = reading.context()
        if (context === null) return null
        // The context is reused, and source-over leaves old RGB behind wherever the new bitmap is
        // transparent. Clear first so transparent pixels stay unpainted.
        context.clearRect(0, 0, size, size)
        context.drawImage(bitmap, 0, 0)
        const { data } = context.getImageData(0, 0, size, size)
        readBack = true
        for (let i = 0, p = 0; p < indices.length; i += 4, p++) {
          // Fully transparent is unpainted. Opaque pixels are palette colours, allowing for bounded
          // privacy noise added by browsers such as Helium during canvas readback.
          indices[p] =
            data[i + 3] === 0
              ? unpainted
              : reading.rgbIndex(
                  reading.table,
                  data[i] ?? 0,
                  data[i + 1] ?? 0,
                  data[i + 2] ?? 0,
                  unpainted,
                )
        }
      }
    } finally {
      bitmap.close()
    }
  }
  if (base === null || base.length !== indices.length) return { indices, changed: null, readBack }
  const changed: number[] = []
  for (let p = 0; p < indices.length; p++) if (indices[p] !== base[p]) changed.push(p)
  return { indices, changed: Uint32Array.from(changed), readBack }
}

/** The glue, which exists only inside the worker. An absent tile is `normalizeMissingTileResponse`'s. */
const WORKER_GLUE = `
let context = null
const reading = {
  table: buildExactRgbIndex(palette),
  decode: (body) => createImageBitmap(body),
  context: () => (context ??= new OffscreenCanvas(1000, 1000).getContext('2d', { willReadFrequently: true })),
  rgbIndex: canvasRgbIndex,
}
const fetchTile = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (response.status === 404) return { body: null, digest: null }
  if (!response.ok) return undefined
  const bytes = await response.arrayBuffer()
  // No hash outside a secure context; the tile is then read back in full.
  const digest = await (self.crypto?.subtle?.digest('SHA-256', bytes).catch(() => null) ?? null)
  return { body: new Blob([bytes]), digest }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.url !== undefined) {
      self.postMessage({ id: data.id, tile: await fetchTile(data.url) })
      return
    }
    const startedAt = performance.now()
    const read = await readTileBody(data.body, data.base, reading)
    const transfer = read === null ? [] : [read.indices.buffer, ...(read.changed === null ? [] : [read.changed.buffer])]
    self.postMessage({ id: data.id, read, durationMs: performance.now() - startedAt }, transfer)
  } catch {
    self.postMessage({ id: data.id })
  }
}
`

const workerSource = (): string =>
  [
    `const buildExactRgbIndex = ${buildExactRgbIndex}`,
    `const canvasRgbIndex = ${canvasRgbIndex}`,
    `const readTileBody = ${readTileBody}`,
    `const palette = ${JSON.stringify(WPLACE_PALETTE.map(({ rgb, index }) => ({ rgb, index })))}`,
    WORKER_GLUE,
  ].join('\n')

/** A worker answer. A missing `tile` or `read` means the worker failed it. */
interface Reply {
  readonly id: number
  readonly tile?: TileBody
  readonly read?: TilePixelsRead | null
  readonly durationMs?: number
}

/** Undefined until first asked for; null when no worker could be started. */
let reader: Worker | null | undefined
let nextRead = 0
const waiting = new Map<number, (reply: Reply | null) => void>()

/**
 * Give up on the worker. A worker the page's CSP rejects reports that only after it was constructed,
 * so reads already waiting on it settle null as well and move to the page like later ones.
 */
const abandon = (detail: unknown): void => {
  warn('fetch', 'tile reads moved to the page', String(detail))
  reader?.terminate()
  reader = null
  for (const settle of waiting.values()) settle(null)
  waiting.clear()
}

const start = (): Worker | null => {
  try {
    const source = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))
    const started = new Worker(source)
    URL.revokeObjectURL(source)
    started.addEventListener('message', (event: MessageEvent<Reply>) => {
      waiting.get(event.data.id)?.(event.data)
      waiting.delete(event.data.id)
    })
    started.addEventListener('error', (event) => abandon(event.message))
    reader = started
  } catch (error) {
    abandon(error)
  }
  return reader ?? null
}

/** Ask the worker; null when there is none. */
const ask = (message: { url: string } | { body: Blob | null; base: Uint8Array | null }) => {
  const active = reader === undefined ? start() : reader
  if (active === null) return Promise.resolve(null)
  const id = nextRead++
  return new Promise<Reply | null>((resolve) => {
    waiting.set(id, resolve)
    active.postMessage({ id, ...message })
  })
}

/** Fetch a tile past every page script. Undefined when it did not answer; null with no worker. */
export const fetchTileInWorker = async (url: string): Promise<TileBody | undefined | null> => {
  const reply = await ask({ url })
  return reply === null ? null : reply.tile
}

/**
 * Read a tile body into palette indices, diffed against `base`: in the worker, or with `page` when
 * there is none. Null for a body that is not a tile; throws when it could not be read.
 */
export const readTilePixels = async (
  body: Blob | null,
  base: Uint8Array | null,
  page: () => TileReading,
): Promise<TilePixelsRead | null> => {
  const reply = await ask({ body, base })
  if (reply === null) return readTileBody(body, base, page())
  if (reply.durationMs !== undefined)
    recordProfileDuration('Tile pixel read', reply.durationMs, 'worker')
  if (reply.read === undefined) throw new Error('the tile reader failed')
  return reply.read
}
