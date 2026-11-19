import { parseTileKey, TILE_SIZE, type TileCoord, tileKey, WPLACE_PALETTE } from '@caelestis/shared'
import { count, log, warn } from './debug.js'
import { notifyEach } from './listeners.js'
import { applyPixels, notifyPixelBatch } from './pixel-changes.js'
import { nextPixelObservation, recordPixelObservation } from './pixel-observation.js'
import { measureProfile } from './profile.js'
import { canvasRgbIndex, paletteRgbIndex } from './rgb-index.js'
import { consumeBySize, decodeTileOnPage, digestOfBlob, onTileRequest } from './tile-attribution.js'
import {
  fetchTileInWorker,
  readTilePixels,
  type TileBody,
  type TilePixelsRead,
  type TileReading,
} from './tile-reader.js'
import { tileFromUrl } from './wplace-raster.js'
import { isWplacePatchEnabled } from './wplace-switches.js'
import { reloadVisibleWplaceTiles } from './wplace-tile-refresh.js'

/**
 * Placed pixels per world tile, as palette indices, for the tiles something asks about.
 *
 * Off unless something wants it. Converting a tile is a 1000x1000 read and a million-entry walk,
 * which is cheap enough once per tile and absurd if nothing reads the result — so capture is
 * switched on only while a feature needs exact base pixels: mismatch markers or the paint drawer's
 * source-only colour picker.
 *
 * Paint Wplace accepted is kept beside the tiles until a newer read of the tile shows it, so
 * progress does not flicker back between a paint and the next download.
 */

let capturePixels = false
let captureInterest: ((tile: TileCoord) => boolean) | null = null

/**
 * Bumped every time capture is switched on, so everything already on screen is read again: the
 * preview canvases already hold the answer, and only tiles decoded afterwards would be caught
 * otherwise.
 */
let generation = 0

/**
 * Turn tile pixel capture on or off.
 *
 * Switching off keeps what was captured: toggling the setting is the one thing anyone does
 * repeatedly while deciding whether they want the markers on, and switching back on re-reads
 * everything visible anyway. The kept copy is what shows instantly while that happens.
 */
export const captureTilePixels = (
  on: boolean,
  interest: ((tile: TileCoord) => boolean) | null = null,
): void => {
  captureInterest = interest
  if (capturePixels === on) return
  capturePixels = on
  if (on) generation++
  log(`tile pixel capture ${on ? 'on' : 'off'}`)
}

/** Whether capture is on at all. */
export const isCapturing = (): boolean => capturePixels

/** Whether capture is on and wants this tile. */
export const capturesTile = (tile: TileCoord): boolean =>
  capturePixels && (captureInterest === null || captureInterest(tile))

/** Changes each time capture switches on; a read older than this is stale. */
export const captureGeneration = (): number => generation

/**
 * How many captured tiles to keep, from the browser's coarse device-memory signal. Each is one MiB,
 * and visible misses can be fetched again, so low-memory machines gain more from less pressure than
 * from a long pan history.
 */
const tilePixelCacheLimit = (deviceMemoryGiB: number | undefined): number => {
  if (deviceMemoryGiB === undefined || deviceMemoryGiB > 8) return 64
  if (deviceMemoryGiB > 4) return 48
  if (deviceMemoryGiB > 2) return 32
  return 24
}

const KEEP_TILE_PIXELS = tilePixelCacheLimit(
  (navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory,
)

/**
 * Tiles we have already gone and asked for, so a miss is chased once and not every frame. A tile
 * that answers 404 or 429 answers that way to the next request too, and nothing is lost by giving
 * up: this only front-runs Wplace's own refetch.
 */
const CHASE_LIMIT = 4

const pixelsOfTile = new Map<string, Uint8Array>()
/** Only the digest of a completed tile capture may skip a later read of retained pixels. */
const capturedTileDigests = new Map<string, ArrayBuffer>()
/** Bumped whenever a digest stops vouching for its tile, so a read already in flight records none. */
let digestsForgotten = 0
const tilePixelAvailabilityListeners = new Set<(tile: TileCoord) => void>()
const tilePixelEvictionListeners = new Set<(tile: TileCoord) => void>()
let heldTilePixels = new Set<string>()
const requestedTilePixels = new Map<string, number>()

/** A write that does not come from the tile body: its digest no longer describes the tile. */
export const forgetTileDigest = (key: string): void => {
  capturedTileDigests.delete(key)
  digestsForgotten++
}

// Object identity carries request order through the buffer/blob/bitmap attribution taps.
const submissionOrder = new WeakMap<object, number>()
const pendingSubmissions = new Set<number>()
const tileRequestOrder = new WeakMap<TileCoord, number>()
const observedTileOrder = new Map<string, number>()
interface AcceptedPixel {
  readonly colour: number
  readonly submitted: number
  readonly accepted: number
  pending: boolean
}
// Observed entries also fence late responses from older, overlapping submissions.
const acceptedPixels = new Map<string, { pixels: Map<number, AcceptedPixel>; pending: number }>()

const pruneSubmissionFences = (): void => {
  const oldestPending = Math.min(...pendingSubmissions)
  for (const [key, held] of acceptedPixels) {
    for (const [offset, pixel] of held.pixels) {
      if (!pixel.pending && pixel.submitted < oldestPending) held.pixels.delete(offset)
    }
    if (held.pixels.size === 0) acceptedPixels.delete(key)
  }
}

/** Order a paint submission against tile reads; `identity` names it until it finishes. */
export const beginSubmission = (identity: object): void => {
  const submitted = nextPixelObservation()
  submissionOrder.set(identity, submitted)
  pendingSubmissions.add(submitted)
}

/** A submission answered, failed or was refused; it no longer fences older accepted paint. */
export const finishSubmission = (identity: object | null): void => {
  if (identity === null) return
  const submitted = submissionOrder.get(identity)
  if (submitted !== undefined) pendingSubmissions.delete(submitted)
  pruneSubmissionFences()
}

/** One tile of a paint submission, as Wplace's `/paint` body names its pixels. */
export interface PaintedTile {
  readonly x: number
  readonly y: number
  readonly pixels: {
    readonly x: readonly number[]
    readonly y: readonly number[]
    readonly colors: readonly number[]
  }
}

/**
 * Keep the pixels of a fully accepted submission until a tile read newer than `accepted` shows
 * them. A count alone cannot identify which pixels succeeded in a partial submission.
 */
export const retainAcceptedPaint = (
  identity: object,
  tiles: readonly PaintedTile[],
  painted: number,
  accepted: number,
): void => {
  const submitted = submissionOrder.get(identity)
  if (submitted === undefined) return
  let total = 0
  for (const tile of tiles) {
    const { x, y, colors } = tile.pixels
    if (x.length !== y.length || x.length !== colors.length) return
    if (x.some((value) => value < 0 || value >= TILE_SIZE)) return
    if (y.some((value) => value < 0 || value >= TILE_SIZE)) return
    if (colors.some((value) => value < 0 || value >= WPLACE_PALETTE.length)) return
    total += x.length
  }
  if (total === 0 || painted !== total) return
  for (const tile of tiles) {
    const key = tileKey(tile)
    forgetTileDigest(key)
    let held = acceptedPixels.get(key)
    if (held === undefined) {
      held = { pixels: new Map(), pending: 0 }
      acceptedPixels.set(key, held)
    }
    const triples: number[] = []
    for (let i = 0; i < tile.pixels.x.length; i++) {
      const x = tile.pixels.x[i] as number
      const y = tile.pixels.y[i] as number
      const offset = y * TILE_SIZE + x
      const previous = held.pixels.get(offset)
      if ((previous?.submitted ?? -1) >= submitted) continue
      const colour = tile.pixels.colors[i] as number
      const pending = (observedTileOrder.get(key) ?? 0) <= accepted
      held.pending += Number(pending) - Number(previous?.pending === true)
      held.pixels.set(offset, { colour, submitted, accepted, pending })
      triples.push(x, y, colour)
    }
    notifyPixelBatch(
      tile,
      triples,
      (observedTileOrder.get(key) ?? 0) > accepted ? 'observed' : 'accepted',
    )
  }
}

/**
 * Accepted paint no tile read has shown yet, by tile-local offset, or null when there is none.
 * `observed` excludes paint accepted before an observation.
 */
export const pendingAcceptedPaint = (
  tile: TileCoord,
  observed = 0,
): ReadonlyMap<number, number> | null => {
  const held = acceptedPixels.get(tileKey(tile))
  if (held === undefined || held.pending === 0) return null
  let pending: Map<number, number> | null = null
  for (const [offset, pixel] of held.pixels) {
    if (!pixel.pending || pixel.accepted <= observed) continue
    pending ??= new Map()
    pending.set(offset, pixel.colour)
  }
  return pending
}

/** One pixel of `pendingAcceptedPaint`, without collecting the tile's. */
export const pendingAcceptedPixelAt = (
  tile: TileCoord,
  offset: number,
  observed = 0,
): number | null => {
  const pixel = acceptedPixels.get(tileKey(tile))?.pixels.get(offset)
  return pixel?.pending === true && pixel.accepted > observed ? pixel.colour : null
}

/** Observe bounded-cache eviction so derived state cannot outlive the exact pixels it describes. */
export const onTilePixelsEvicted = (listener: (tile: TileCoord) => void): (() => void) => {
  tilePixelEvictionListeners.add(listener)
  return () => tilePixelEvictionListeners.delete(listener)
}

/** Observe the first successful capture after a tile was unavailable. */
export const onTilePixelsAvailable = (listener: (tile: TileCoord) => void): (() => void) => {
  tilePixelAvailabilityListeners.add(listener)
  return () => tilePixelAvailabilityListeners.delete(listener)
}

/**
 * Declare the tiles the current marker frame reads, which eviction passes over. Replaces the
 * previous frame's.
 *
 * A view wider than the cache would otherwise evict a tile it was still drawing, and the next frame
 * would chase it again, forever. Held tiles may push the cache past its limit, with room for one
 * round of chases beyond them; the excess goes once they leave the frame.
 */
export const holdTilePixels = (tiles: Iterable<TileCoord>): void => {
  heldTilePixels = new Set(Array.from(tiles, tileKey))
  trimTilePixels()
}

/** Evict the least recently used tiles that no frame or load holds, down to the cache's limit. */
const trimTilePixels = (): void => {
  const keep = Math.max(KEEP_TILE_PIXELS, heldTilePixels.size + CHASE_LIMIT)
  let excess = pixelsOfTile.size - keep
  for (const key of pixelsOfTile.keys()) {
    if (excess <= 0) return
    if (heldTilePixels.has(key) || requestedTilePixels.has(key)) continue
    excess--
    pixelsOfTile.delete(key)
    capturedTileDigests.delete(key)
    observedTileOrder.delete(key)
    const evicted = parseTileKey(key)
    if (evicted !== null) {
      for (const listener of tilePixelEvictionListeners) listener(evicted)
    }
    // An evicted tile is fetchable again when it next enters the viewport.
    chased.delete(key)
  }
}

const rememberTilePixels = (key: string, pixels: Uint8Array): void => {
  const becameAvailable = !pixelsOfTile.has(key)
  pixelsOfTile.delete(key)
  pixelsOfTile.set(key, pixels)
  if (!becameAvailable) return
  wakeTileLoaders()
  const available = parseTileKey(key)
  if (available !== null) {
    for (const listener of tilePixelAvailabilityListeners) listener(available)
  }
  trimTilePixels()
}

/** The kept pixels of a tile, as Wplace last served it; null when none are kept. */
export const tilePixels = (tile: TileCoord): Uint8Array | null => {
  const key = tileKey(tile)
  const pixels = pixelsOfTile.get(key)
  if (pixels === undefined) return null
  rememberTilePixels(key, pixels)
  return pixels
}

/** What the kept tiles hold in memory. */
export const tilePixelMemoryBytes = (): number => {
  let bytes = 0
  for (const pixels of pixelsOfTile.values()) bytes += pixels.byteLength
  return bytes
}

/** Whatever tile URL Wplace last used, with the coordinates blanked out. */
let tileUrlShape: string | null = null
let captureRealm: (Window & typeof globalThis) | null = null

/** Chases already made, so a miss is chased once and not every frame. */
const chased = new Set<string>()
/** Active chase per tile, separate from the one-shot history so another reader can join it. */
const activeChases = new Map<string, Promise<void>>()
let chasing = 0
const tileLoadWaiters = new Set<() => void>()
const tileLoadListeners = new Set<() => void>()
/** Wake explicit readers when a URL, captured tile, or fetch slot becomes available. */
const wakeTileLoaders = (): void => {
  for (const resolve of tileLoadWaiters) resolve()
  notifyEach(tileLoadListeners, (listener) => listener(), 'pixels:load listener failed')
}

/** Observe when a refused or deferred tile read may now succeed: a URL, tile or fetch slot freed. */
export const onTileLoadsChange = (listener: () => void): void => {
  tileLoadListeners.add(listener)
}

const rememberTileUrl = (url: string, tile: TileCoord): void => {
  tileUrlShape = url.replace(`/${tile.x}/${tile.y}.png`, '/{x}/{y}.png')
  wakeTileLoaders()
}

const noteTileRequest = (tile: TileCoord, url: string): void => {
  tileRequestOrder.set(tile, nextPixelObservation())
  rememberTileUrl(url, tile)
}

/**
 * Read tiles in `realm` from the URL Wplace uses for them, ordering each against the paint it
 * submits. Wplace may have shown its tiles before this ran, so the URL is recovered from resource
 * timing rather than waiting for another map fetch.
 */
export const observeTileRequests = (realm: Window & typeof globalThis): void => {
  captureRealm = realm
  onTileRequest(noteTileRequest)
  if (tileUrlShape !== null) return
  const resources = realm.performance?.getEntriesByType('resource') ?? []
  for (let i = resources.length - 1; i >= 0; i--) {
    const url = resources[i]?.name
    if (url === undefined) continue
    const tile = tileFromUrl(url)
    if (tile === null) continue
    rememberTileUrl(url, tile)
    break
  }
}

/**
 * The page-side fetch, for when no worker can be started. Another script may rewrite it. It builds
 * the Blob as Wplace does, so the Blob tap hashes it for capture-dedupe. Nothing decodes it through
 * the bitmap tap, so the size entry the response tap queued for it is consumed here; left behind,
 * it would answer for a later untagged tile of the same size.
 */
const readTileOnPage = async (
  realm: Window & typeof globalThis,
  tile: TileCoord,
  url: string,
): Promise<TileBody | undefined> => {
  const response = await realm.fetch.call(realm, url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) return undefined
  const bytes = await response.arrayBuffer()
  consumeBySize(bytes.byteLength, tile)
  const body = new realm.Blob([bytes])
  return { body, digest: await (digestOfBlob(body) ?? null) }
}

/**
 * Read one tile from the server and capture it, fetched in the worker when there is one. False when
 * there is no tile URL or page yet, or the tile did not answer.
 */
const readTile = async (tile: TileCoord): Promise<boolean> => {
  const realm = captureRealm
  if (realm === null || tileUrlShape === null) return false
  const url = tileUrlShape.replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
  // Fences this read against newer captures and accepted paint, as Wplace's own requests are.
  tileRequestOrder.set(tile, nextPixelObservation())
  const fetched = await fetchTileInWorker(url)
  const read = fetched === null ? await readTileOnPage(realm, tile, url) : fetched
  if (read === undefined) return false
  await captureTile(tile, read.body, read.digest)
  return true
}

/**
 * Fetch a tile we never saw decoded, rather than waiting for Wplace to fetch it again.
 *
 * Capture can only catch a tile as it is decoded, so anything already on screen when capture
 * switches on was missed, and would wait about ten seconds for Wplace's own refetch. One request per
 * tile, at most a few at a time, and only for tiles something is asking about.
 */
export const ensureTilePixels = (tile: TileCoord): boolean => {
  const key = tileKey(tile)
  if ((!capturePixels && !requestedTilePixels.has(key)) || tileUrlShape === null) return false
  // A tile Wplace already fetched is on its way; chasing it too would download it twice.
  if (pixelsOfTile.has(key) || tileCaptures.has(key)) return true
  if (chased.has(key) || chasing >= CHASE_LIMIT) return false
  chased.add(key)
  chasing++
  const chase = (async () => {
    // Publish the promise before a page-provided fetch implementation gets a chance to throw.
    await Promise.resolve()
    try {
      if (await readTile(tile)) count('pixels:chased a tile we missed')
    } catch (error) {
      warn(`could not chase tile ${tile.x}/${tile.y}`, String(error))
    } finally {
      chasing--
      activeChases.delete(key)
      wakeTileLoaders()
    }
  })()
  activeChases.set(key, chase)
  void chase
  return true
}

/** Wait for an explicit tile read, allowing one attempt even if background capture failed earlier. */
export const loadTilePixels = async (
  tile: TileCoord,
  timeoutMs = 15_000,
): Promise<Uint8Array | null> => {
  const existing = tilePixels(tile)
  if (existing !== null) return existing
  const key = tileKey(tile)
  requestedTilePixels.set(key, (requestedTilePixels.get(key) ?? 0) + 1)
  let timeout: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let expired = false
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(
      () => {
        expired = true
        resolve()
      },
      Math.max(0, timeoutMs),
    )
  })
  try {
    while (!expired) {
      const pixels = tilePixels(tile)
      if (pixels !== null) return pixels
      const capture = tileCaptures.get(key)
      if (capture !== undefined && !activeChases.has(key)) {
        // Wplace's own download is on its way; if its capture fails, the next pass chases once.
        await Promise.race([capture, deadline])
        continue
      }
      let chase = activeChases.get(key)
      if (chase === undefined && tileUrlShape !== null && chasing < CHASE_LIMIT) {
        // The one-shot history throttles frame-driven capture, not a fresh user action.
        chased.delete(key)
        ensureTilePixels(tile)
        chase = activeChases.get(key)
      }
      if (chase !== undefined) {
        await Promise.race([chase, deadline])
        return tilePixels(tile)
      }
      const changed = new Promise<void>((resolve) => {
        wake = resolve
        tileLoadWaiters.add(resolve)
      })
      await Promise.race([changed, deadline])
      if (wake !== undefined) tileLoadWaiters.delete(wake)
    }
    return tilePixels(tile)
  } finally {
    if (wake !== undefined) tileLoadWaiters.delete(wake)
    if (timeout !== undefined) clearTimeout(timeout)
    const requests = (requestedTilePixels.get(key) ?? 1) - 1
    if (requests === 0) requestedTilePixels.delete(key)
    else requestedTilePixels.set(key, requests)
  }
}

let rereading: Promise<void> | null = null

/**
 * Fetch every kept tile that capture still wants again, except those in `skip`.
 *
 * Kept pixels describe a tile as it was when it was last on screen. Wplace only re-downloads what is
 * visible, so progress and markers for a template out of view go on counting those old pixels until
 * somebody pans back to it. An unchanged tile costs no canvas read; capture-dedupe recognises it. A
 * call while a re-read is running joins it.
 */
export const rereadKeptTiles = (skip: Iterable<TileCoord>): Promise<void> => {
  if (rereading !== null) return rereading
  const skipped = new Set<string>([...skip].map(tileKey))
  const queue = [...pixelsOfTile.keys()].flatMap((key) => {
    const tile = skipped.has(key) ? null : parseTileKey(key)
    return tile !== null && capturePixels && (captureInterest?.(tile) ?? true) ? [tile] : []
  })
  count('pixels:kept tiles re-read on request', queue.length)
  const worker = async (): Promise<void> => {
    for (let tile = queue.shift(); tile !== undefined; tile = queue.shift()) {
      try {
        await readTile(tile)
      } catch (error) {
        warn(`could not re-read tile ${tile.x}/${tile.y}`, String(error))
      }
    }
  }
  rereading = Promise.all(Array.from({ length: CHASE_LIMIT }, worker)).then(() => {
    rereading = null
  })
  return rereading
}

/**
 * Reload the tiles that may have changed since the painter last looked at them: every visible tile
 * through Wplace's map, so the map redraws too, and every kept tile off screen, so progress and
 * markers stop counting old pixels.
 */
export const reloadTiles = (): Promise<void> => rereadKeptTiles(reloadVisibleWplaceTiles())

/** The base tile plus fully accepted paint awaiting a newer tile, excluding native drafts. */
export const loadCommittedTilePixels = async (tile: TileCoord): Promise<Uint8Array | null> => {
  const base = await loadTilePixels(tile)
  if (base === null) return null
  const pending = pendingAcceptedPaint(tile)
  if (pending === null) return base
  const committed = base.slice()
  for (const [offset, colour] of pending) committed[offset] = colour
  return committed
}

let captureContext: OffscreenCanvasRenderingContext2D | null = null

/** One tile-sized 2D context, reused by every page-side tile and draft read. */
export const reusableCaptureContext = (): OffscreenCanvasRenderingContext2D | null => {
  if (captureContext !== null) return captureContext
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  captureContext = canvas.getContext('2d', { willReadFrequently: true })
  return captureContext
}

const sameDigest = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** Whether anything wants this tile's pixels: capture, an explicit read, or accepted paint. */
const wantsTilePixels = (tile: TileCoord): boolean => {
  const key = tileKey(tile)
  return (
    (acceptedPixels.get(key)?.pending ?? 0) > 0 ||
    requestedTilePixels.has(key) ||
    capturesTile(tile)
  )
}

/** Whether hashing this tile's body could let its next read be skipped. */
export const wantsTileDigest = (tile: TileCoord): boolean => {
  const key = tileKey(tile)
  return (
    isWplacePatchEnabled('capture-dedupe') &&
    capturesTile(tile) &&
    !acceptedPixels.has(key) &&
    !requestedTilePixels.has(key)
  )
}

/** Whether a read requested at `observation` lost to a newer one of the same tile. */
const supersededRead = (key: string, observation: number | undefined): boolean =>
  observation !== undefined && observation < (observedTileOrder.get(key) ?? 0)

/**
 * Settle a refetch whose body is byte-identical to the completed capture it would replace. A new
 * request still fences older responses and refreshes the cache's LRU position. Empty notifications
 * have no listeners; only changed pixels are announced.
 */
const skipUnchangedTile = (
  tile: TileCoord,
  digest: ArrayBuffer | null,
  observation: number | undefined,
): boolean => {
  const key = tileKey(tile)
  const existing = pixelsOfTile.get(key)
  const previousDigest = capturedTileDigests.get(key)
  if (
    !isWplacePatchEnabled('capture-dedupe') ||
    digest === null ||
    previousDigest === undefined ||
    existing === undefined ||
    acceptedPixels.has(key) ||
    requestedTilePixels.has(key) ||
    observation === undefined ||
    !sameDigest(digest, previousDigest)
  )
    return false
  observedTileOrder.set(key, observation)
  recordPixelObservation(existing, observation)
  rememberTilePixels(key, existing)
  notifyPixelBatch(tile, [], 'observed')
  pruneSubmissionFences()
  count('pixels:tile captures skipped')
  return true
}

interface QueuedCapture {
  readonly tile: TileCoord
  readonly body: Blob | null
  readonly digest: ArrayBuffer | null
  readonly observation: number | undefined
  /** `digestsForgotten` when this read was admitted. */
  readonly forgotten: number
  readonly done: readonly (() => void)[]
}

/**
 * Tile reads waiting for the reader, one per tile, oldest first.
 *
 * They are read one at a time, so the reader holds one tile's pixels at once, and no tile's pixels
 * change under a read of them: only a read's own commit writes them. A newer read of a waiting tile
 * takes its place, because the older answer would lose to it anyway.
 *
 * No more first reads wait than the pixel cache keeps, since past that each one read would evict
 * another: a long pan's oldest, by now mostly off screen, give way to the newest. A re-read of a
 * kept tile never does, because Wplace already has its new bytes and will not fetch them again for
 * us. Nor does a read an explicit `loadTilePixels` waits on, or one of a tile the marker frame
 * holds, which would only be chased again. Each is bounded by the cache, the loads, or the view.
 */
const queuedCaptures = new Map<string, QueuedCapture>()
let readingCaptures = false
/** Every tile capture between Wplace's decode and its commit, so a chase can join it. */
const tileCaptures = new Map<string, Promise<void>>()

const queueCapture = (capture: QueuedCapture): void => {
  const key = tileKey(capture.tile)
  const waiting = queuedCaptures.get(key)
  // Re-inserted, so the queue's order is each tile's latest arrival.
  queuedCaptures.delete(key)
  if (
    waiting?.observation !== undefined &&
    capture.observation !== undefined &&
    waiting.observation > capture.observation
  ) {
    queuedCaptures.set(key, { ...waiting, done: [...waiting.done, ...capture.done] })
  } else {
    queuedCaptures.set(key, { ...capture, done: [...(waiting?.done ?? []), ...capture.done] })
  }
  for (const [oldest, dropped] of queuedCaptures) {
    if (queuedCaptures.size <= KEEP_TILE_PIXELS) break
    if (pixelsOfTile.has(oldest) || requestedTilePixels.has(oldest) || heldTilePixels.has(oldest))
      continue
    queuedCaptures.delete(oldest)
    // Still on screen, it is chased again; off screen, nothing asks for it until Wplace does.
    chased.delete(oldest)
    for (const done of dropped.done) done()
    count('pixels:tile captures dropped')
  }
  if (!readingCaptures) void readCaptures()
}

const pageTileReading = (): TileReading => ({
  table: paletteRgbIndex(),
  decode: decodeTileOnPage,
  context: reusableCaptureContext,
  rgbIndex: canvasRgbIndex,
})

const readCaptures = async (): Promise<void> => {
  readingCaptures = true
  for (
    let next = queuedCaptures.values().next().value;
    next !== undefined;
    next = queuedCaptures.values().next().value
  ) {
    const key = tileKey(next.tile)
    queuedCaptures.delete(key)
    try {
      if (supersededRead(key, next.observation)) continue
      const base = pixelsOfTile.get(key) ?? null
      const read = await readTilePixels(next.body, base, pageTileReading)
      if (read !== null) commitTile(next, read, base)
    } catch (error) {
      count('pixels:tile readback failures')
      warn('could not read tile pixels', String(error))
    } finally {
      for (const done of next.done) done()
    }
  }
  readingCaptures = false
}

/** Apply a tile read: retire the accepted paint it observed, and diff it into the kept pixels. */
const commitTile = (capture: QueuedCapture, read: TilePixelsRead, base: Uint8Array | null): void =>
  measureProfile('Tile pixel capture', () => {
    const { tile, observation } = capture
    const key = tileKey(tile)
    // A newer read may have landed while this one was in the reader.
    if (supersededRead(key, observation)) return
    const { indices } = read
    if (read.readBack) {
      count('pixels:tile readback bytes', indices.length * 4)
      count('pixels:tile full reads')
      count('pixels:tile readback pixels', indices.length)
    }
    const retained = acceptedPixels.get(key)
    const retired: number[] = []
    if (observation !== undefined) {
      observedTileOrder.set(key, observation)
      for (const [offset, pixel] of retained?.pixels ?? []) {
        if (observation <= pixel.accepted) continue
        if (pixel.pending && retained !== undefined) retained.pending--
        pixel.pending = false
        const x = offset % TILE_SIZE
        retired.push(x, (offset - x) / TILE_SIZE, indices[offset] as number)
      }
    }
    // A digest forgotten while this was read no longer vouches for the pixels it would describe.
    const digest = capture.forgotten === digestsForgotten ? capture.digest : null
    if (digest === null) capturedTileDigests.delete(key)
    else capturedTileDigests.set(key, digest)

    /**
     * A re-read of a tile we already hold becomes a diff, not a replacement: anything holding a
     * result for this tile keys it on the array's identity, so a new array would say everything
     * about the tile changed when one painted pixel had.
     */
    const existing = pixelsOfTile.get(key)
    if (existing === undefined || existing.length !== indices.length) {
      if (observation !== undefined) recordPixelObservation(indices, observation)
      rememberTilePixels(key, indices)
      notifyPixelBatch(tile, retired, 'observed')
      pruneSubmissionFences()
      count('pixels:tile captures')
      count('pixels:captured')
      return
    }
    rememberTilePixels(key, existing)
    if (observation !== undefined) recordPixelObservation(existing, observation)
    // The reader diffed against `existing` unless it was evicted and read again meanwhile.
    applyPixels(tile, existing, indices, 'server', existing === base ? read.changed : null)
    notifyPixelBatch(tile, retired, 'observed')
    pruneSubmissionFences()
    count('pixels:tile captures')
    count('pixels:re-read as a diff')
  })

/**
 * Capture a tile from its body, off the page's thread, after Wplace already has its bitmap. Resolves
 * once the pixels are applied, or the read was refused, superseded, or failed.
 */
const captureTile = (
  tile: TileCoord,
  body: Blob | null,
  digest: Promise<ArrayBuffer | null> | ArrayBuffer | null,
): Promise<void> => {
  if (!wantsTilePixels(tile)) return Promise.resolve()
  const key = tileKey(tile)
  const capture = (async () => {
    const hash = await digest
    const observation = tileRequestOrder.get(tile)
    if (supersededRead(key, observation) || skipUnchangedTile(tile, hash, observation)) return
    const forgotten = digestsForgotten
    await new Promise<void>((done) =>
      queueCapture({ tile, body, digest: hash, observation, forgotten, done: [done] }),
    )
  })()
  const joined = Promise.all([tileCaptures.get(key), capture]).then(() => {
    if (tileCaptures.get(key) === joined) tileCaptures.delete(key)
  })
  tileCaptures.set(key, joined)
  return capture
}

/** Resolves once every tile capture started so far has been applied or refused. */
export const settledTileCaptures = async (): Promise<void> => {
  while (tileCaptures.size > 0) await Promise.all(tileCaptures.values())
}

/**
 * Capture a tile Wplace just decoded, from the body it decoded. Wplace owns the bitmap and may close
 * it once drawn, so only its size is read here.
 *
 * An undersized bitmap is Wplace saying "nothing is painted here": its service worker substitutes a
 * 1x1 transparent PNG for an absent tile, as the tile response tap does for a 404. An empty tile is
 * a real answer and gets recorded as one; declining it would leave markers over it waiting forever.
 */
export const captureDecodedTile = (
  tile: TileCoord,
  bitmap: ImageBitmap,
  body: Blob,
  digest: Promise<ArrayBuffer | null> | undefined,
): void => {
  const empty = bitmap.width < TILE_SIZE && bitmap.height < TILE_SIZE
  if (!empty && (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE)) return
  void captureTile(tile, empty ? null : body, digest ?? null)
}
