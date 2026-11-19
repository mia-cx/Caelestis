import {
  parseTileKey,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  tileKey,
} from '@caelestis/shared'
import { count, warn } from './debug.js'
import type { PixelRect } from './geometry.js'
import { getMap } from './map-handle.js'
import { UNPAINTED } from './native-pixels.js'
import { applyPixels, invalidateOnTilePixels, notifyPixelBatch } from './pixel-changes.js'
import { measureProfile } from './profile.js'
import { paletteRgbIndex, rgbaPaletteIndex } from './rgb-index.js'
import { draftedPixelsIn } from './templates/drafted.js'
import {
  captureGeneration,
  capturesTile,
  forgetTileDigest,
  isCapturing,
  onTilePixelsEvicted,
  pendingAcceptedPaint,
  pendingAcceptedPixelAt,
  reusableCaptureContext,
} from './tile-pixels.js'
import { isDraftLayer } from './wplace-raster.js'

/**
 * The draft layer, per tile: what has been placed but not submitted.
 *
 * Kept *beside* the server's pixels rather than merged into them, and that separation is the whole
 * design. There are three states for any pixel and a comparison needs all three:
 *
 *     server  — what Wplace will serve; the tile PNG
 *     draft   — what has been placed locally, or `UNPAINTED` where nothing has
 *     wanted  — what the template asks for
 *
 * and the question is `(draft is a colour ? draft : server) === wanted`. A re-fetch replaces the
 * server copy and cannot touch the draft, and a draft canvas that is empty is simply a tile with
 * nothing drafted on it.
 *
 * Wplace draws drafts into one canvas per tile, which it uploads as a MapLibre image source. Writes
 * to those canvases are patched in here from the canvas taps; a canvas changed some other way is
 * read back when MapLibre next draws it.
 */

type CanvasSource = CanvasImageSource & { width: number; height: number }

const draftOfTile = new Map<string, Uint8Array>()
/** Active draft truth survives eviction of the dense arrays used by pixel consumers. */
const draftedOffsets = new Map<string, Map<number, number>>()
const KEEP_DRAFT_TILES = 64

/**
 * Pixels drafted as Transparent, per tile, as tile-local offsets.
 *
 * These are the ones the canvas cannot report. Alpha zero is what a drafted-transparent pixel and an
 * undrafted one both look like, so the draft array holds `UNPAINTED` for the pair of them until this
 * says otherwise — and holds `TRANSPARENT_INDEX` for the ones it does, which is a value the canvas
 * can never produce (their palette stops at 62, and alpha zero short-circuits before the table).
 *
 * Kept so the reverse is cheap too. Undrafting one is only visible as a crosshair that has gone, and
 * checking what we last set beats scanning a million pixels for the ones that used to be set.
 */
const transparentOfTile = new Map<string, Set<number>>()

/**
 * Canvases whose pixels have changed since they were last read.
 *
 * Wplace redraws a paint-preview tile only when a pixel changes, but MapLibre *draws* it every
 * frame. Without this the capture would run on every frame of every tile on screen.
 */
const dirtyCanvases = new WeakMap<object, PixelRect | null>()

/** Which tile a paint-preview canvas belongs to, once its style layer has named it. */
const tileOfPaintCanvas = new WeakMap<object, TileCoord>()
const paintCanvasOfTile = new Map<string, object>()

/**
 * Writes that arrived before we knew which tile the canvas was, as flat `x, y, index` in tile-local
 * coordinates. A write is cheap to hold and impossible to reconstruct.
 */
const queuedWrites = new WeakMap<object, number[]>()

/** Drafts plus accepted paint, cached per tile until its pixels change. */
const comparisonDrafts = new Map<string, Uint8Array>()
invalidateOnTilePixels((tile) => comparisonDrafts.delete(tileKey(tile)))
onTilePixelsEvicted((tile) => comparisonDrafts.delete(tileKey(tile)))

/** What the dense draft arrays hold in memory. */
export const draftPixelMemoryBytes = (): number => {
  let bytes = 0
  for (const pixels of draftOfTile.values()) bytes += pixels.byteLength
  return bytes
}

/** Note that a tile-sized canvas has been written to, so the next draw re-reads it. */
export const markCanvasDirty = (canvas: object, rect: PixelRect | null = null): void => {
  const held = dirtyCanvases.get(canvas)
  if (held === null) return
  if (held === undefined || rect === null) {
    dirtyCanvases.set(canvas, rect)
    return
  }
  const x = Math.min(held.x, rect.x)
  const y = Math.min(held.y, rect.y)
  dirtyCanvases.set(canvas, {
    x,
    y,
    width: Math.max(held.x + held.width, rect.x + rect.width) - x,
    height: Math.max(held.y + held.height, rect.y + rect.height) - y,
  })
}

const rememberDraft = (key: string, draft: Uint8Array): void => {
  draftOfTile.delete(key)
  draftOfTile.set(key, draft)
  while (draftOfTile.size > KEEP_DRAFT_TILES) {
    const oldest = draftOfTile.keys().next()
    if (oldest.done) break
    draftOfTile.delete(oldest.value)
  }
}

const rememberDraftedOffset = (key: string, offset: number, index: number): void => {
  const held = draftedOffsets.get(key)
  if (index === UNPAINTED) {
    held?.delete(offset)
    if (held?.size === 0) draftedOffsets.delete(key)
    return
  }
  if (held === undefined) draftedOffsets.set(key, new Map([[offset, index]]))
  else held.set(offset, index)
}

/** Sparse native Wplace draft offsets for one tile, without exposing the mutable retained set. */
export function* draftedPixelOffsets(tile: TileCoord): IterableIterator<number> {
  yield* draftedOffsets.get(tileKey(tile))?.keys() ?? []
}

/** Every tile that currently holds at least one drafted pixel, on screen or not. */
export const draftedTiles = (): readonly TileCoord[] => {
  const tiles: TileCoord[] = []
  for (const [key, offsets] of draftedOffsets) {
    if (offsets.size === 0) continue
    const tile = parseTileKey(key)
    if (tile !== null) tiles.push(tile)
  }
  return tiles
}

/** The draft layer for a tile, or null if nothing has been drafted on it. */
export const draftPixels = (tile: TileCoord): Uint8Array | null => {
  const key = tileKey(tile)
  let draft = draftOfTile.get(key)
  if (draft === undefined) {
    const sparse = draftedOffsets.get(key)
    if (sparse === undefined) return null
    draft = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)
    for (const [offset, index] of sparse) draft[offset] = index
  }
  rememberDraft(key, draft)
  return draft
}

/** Native drafts override retained paint; an observation excludes paint confirmed before its request. */
export const comparisonDraftPixels = (tile: TileCoord, observed = 0): Uint8Array | null => {
  const key = tileKey(tile)
  const native = draftPixels(tile)
  const accepted = pendingAcceptedPaint(tile, observed)
  if (accepted === null) return native
  const cached = comparisonDrafts.get(key)
  if (observed === 0 && cached !== undefined) return cached
  const combined = native?.slice() ?? new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)
  for (const [offset, colour] of accepted) {
    if (combined[offset] === UNPAINTED) combined[offset] = colour
  }
  if (observed === 0) comparisonDrafts.set(key, combined)
  return combined
}

/** One pixel of `comparisonDraftPixels`, without building the tile. */
export const comparisonDraftPixelAt = (tile: TileCoord, offset: number, observed = 0): number => {
  const key = tileKey(tile)
  const native = draftOfTile.get(key)?.[offset] ?? draftedOffsets.get(key)?.get(offset) ?? UNPAINTED
  if (native !== UNPAINTED) return native
  return pendingAcceptedPixelAt(tile, offset, observed) ?? UNPAINTED
}

/**
 * Bring a tile's drafted-transparent pixels in line with Wplace's crosshairs.
 *
 * Drafting Transparent changes nothing we can see: the canvas write lands alpha zero on a pixel our
 * draft already holds as `UNPAINTED`, so the write is a no-op, nothing is announced, and no marker
 * moves. The crosshair is the only evidence it happened. Reconciling in both directions here is what
 * turns it into a change like any other, announced through the same listener as a placed pixel.
 */
const reconcileDraftedTile = (tile: TileCoord, before?: Map<number, number>): void => {
  const key = tileKey(tile)
  const draft = draftOfTile.get(key)
  if (draft === undefined && !draftedOffsets.has(key) && before === undefined) return

  const held = transparentOfTile.get(key)
  const now = new Set<number>()
  const changed: number[] = []
  for (const p of draftedPixelsIn(tile, TILE_SIZE)) {
    const index = draft?.[p] ?? draftedOffsets.get(key)?.get(p) ?? UNPAINTED
    // A drafted pixel the canvas gave us no colour for was drafted transparent.
    if (index === UNPAINTED) {
      if (before !== undefined && !before.has(p)) before.set(p, UNPAINTED)
      if (draft !== undefined) draft[p] = TRANSPARENT_INDEX
      rememberDraftedOffset(key, p, TRANSPARENT_INDEX)
      if (before === undefined)
        changed.push(p % TILE_SIZE, Math.floor(p / TILE_SIZE), TRANSPARENT_INDEX)
      count('pixels:drafted transparent')
    }
    if (index === UNPAINTED || index === TRANSPARENT_INDEX) now.add(p)
  }
  if (held !== undefined) {
    for (const p of held) {
      const index = draft?.[p] ?? draftedOffsets.get(key)?.get(p) ?? UNPAINTED
      if (now.has(p) || index !== TRANSPARENT_INDEX) continue
      // The crosshair is gone, so the pixel is undrafted — back to whatever the server has.
      if (before !== undefined && !before.has(p)) before.set(p, TRANSPARENT_INDEX)
      if (draft !== undefined) draft[p] = UNPAINTED
      rememberDraftedOffset(key, p, UNPAINTED)
      if (before === undefined) changed.push(p % TILE_SIZE, Math.floor(p / TILE_SIZE), UNPAINTED)
      count('pixels:undrafted a transparent pixel')
    }
  }
  if (now.size > 0) transparentOfTile.set(key, now)
  else transparentOfTile.delete(key)
  notifyPixelBatch(tile, changed, 'draft')
}

/**
 * Re-check every tile with a draft on it, at most this often. Called per frame, because the write
 * that would otherwise prompt it is exactly the write that does not happen. Cheap in the case that
 * runs constantly: with nothing drafted there are no crosshair patches to read and no arrays to walk.
 */
const RECONCILE_INTERVAL_MS = 150
let lastReconcile = 0

export const reconcileDrafts = (): void => {
  const now = performance.now()
  if (now - lastReconcile < RECONCILE_INTERVAL_MS) return
  lastReconcile = now
  // Sparse active state outlives the dense cache. Reconciliation must not rehydrate cold arrays.
  for (const key of new Set([...draftOfTile.keys(), ...draftedOffsets.keys()])) {
    const [x, y] = key.split('/').map(Number)
    if (x === undefined || y === undefined) continue
    reconcileDraftedTile({ x, y })
  }
}

/** Register the tile identity that Wplace exposes in a draft layer's style id. */
export const registerDraftCanvas = (canvas: object, tile: TileCoord): void => {
  const known = tileOfPaintCanvas.get(canvas)
  if (known !== undefined && known.x === tile.x && known.y === tile.y) return
  if (known !== undefined) retireDraftCanvas(canvas, known)
  const key = tileKey(tile)
  const previous = paintCanvasOfTile.get(key)
  if (previous !== undefined) retireDraftCanvas(previous, tile)
  paintCanvasOfTile.set(key, canvas)
  tileOfPaintCanvas.set(canvas, tile)
  markCanvasDirty(canvas)
  count('paint:named a draft canvas')
  const held = queuedWrites.get(canvas)
  if (held !== undefined && applyWrite(tile, held)) queuedWrites.delete(canvas)
}

const retireDraftCanvas = (canvas: object, tile: TileCoord): void => {
  tileOfPaintCanvas.delete(canvas)
  paintCanvasOfTile.delete(tileKey(tile))
  queuedWrites.delete(canvas)
  dirtyCanvases.delete(canvas)
  clearDraftPixels(tile)
}

/** Discard draft sources removed from Wplace's style, independently of its drawer animation. */
const retainDraftCanvases = (canvases: ReadonlySet<object>): void => {
  for (const canvas of paintCanvasOfTile.values()) {
    if (canvases.has(canvas)) continue
    const tile = tileOfPaintCanvas.get(canvas)
    if (tile !== undefined) retireDraftCanvas(canvas, tile)
  }
}

/** A draft layer's id ends with its tile: `paint-preview-0.9268…-325,1783`. */
const DRAFT_TILE = /-(\d+),(\d+)$/

/** The canvas behind a MapLibre canvas or image source, if it is one. */
const sourceCanvas = (source: unknown): object | undefined => {
  const getCanvas = (source as { getCanvas?: unknown } | undefined)?.getCanvas
  return typeof getCanvas === 'function'
    ? (getCanvas.call(source) as object | undefined)
    : undefined
}

/**
 * Name each draft canvas by the tile its style layer is for, and retire those whose layer is gone.
 *
 * Wplace name the layer and its image source for the tile, and the source hands back the canvas a
 * placed-but-unsubmitted pixel is drawn into. Working it out from where the texture landed instead
 * does not work: those quads measure 0.125x and 0.063x of a tile. Run on every frame, so the first
 * native writes are attributed at once, including when Paint closes and reopens between frames.
 */
export const syncDraftCanvases = (): void => {
  const map = getMap()
  const order = map?.style?._order
  if (map === null || order === undefined) {
    count('paint:no layer order to read')
    return
  }
  const canvases = new Set<object>()
  for (const id of order) {
    if (!isDraftLayer(id)) continue
    count('paint:saw a draft layer')
    const match = DRAFT_TILE.exec(id)
    if (match === null) {
      count('paint:draft layer id had no tile in it')
      continue
    }
    const canvas = sourceCanvas(map.getSource(id))
    if (canvas === undefined) {
      count('paint:draft source gave no canvas')
      continue
    }
    canvases.add(canvas)
    registerDraftCanvas(canvas, { x: Number(match[1]), y: Number(match[2]) })
  }
  retainDraftCanvases(canvases)
}

/**
 * The largest write that is worth patching a pixel at a time.
 *
 * A pending paint is a 1x1, so this is really "is this a pixel or a repaint". Anything bigger falls
 * back to re-reading the tile, which is the right trade at that size and the wrong one at this.
 */
export const PATCH_LIMIT = 32

/**
 * The draft canvas is stored upside down relative to its tile.
 *
 * Wplace place it as an image source whose `coordinates` run the other way round — the corner
 * MapLibre treats as top-left is the tile's *bottom* edge, which is what the source's
 * `flippedWindingOrder` is about. Measured on the live style: the layer named for tile 325,1781 has
 * `coordinates[0]` at tile y 1782 and `coordinates[3]` at 1781. Horizontally nothing is reversed.
 */
export const flipRow = (y: number): number => TILE_SIZE - 1 - y

const pendingDraftWrites = new Map<string, { tile: TileCoord; before: Map<number, number> }>()

/** Publish the final native colour/occupancy transaction before rendering or submitting it. */
export const flushDraftWrites = (): void => {
  const pending = [...pendingDraftWrites.values()]
  pendingDraftWrites.clear()
  for (const { tile, before } of pending) {
    reconcileDraftedTile(tile, before)
    const draft = draftPixels(tile)
    const triples: number[] = []
    for (const [p, previous] of before) {
      const index = draft?.[p] ?? UNPAINTED
      if (index === previous) continue
      triples.push(p % TILE_SIZE, Math.floor(p / TILE_SIZE), index)
    }
    notifyPixelBatch(tile, triples, 'draft')
  }
}

/**
 * The pixels of a small canvas write, as tile-local `x, y, index` triples. The write says exactly
 * which pixels moved and to what; re-reading the whole tile to learn it is a million bytes on the
 * one path where the map has to stay responsive.
 */
export const readWrite = (
  image: ImageData,
  dx: number,
  dy: number,
  rect: PixelRect = { x: dx, y: dy, width: image.width, height: image.height },
): number[] => {
  const table = paletteRgbIndex()
  const { data, width } = image
  const triples: number[] = []
  for (let j = rect.y - dy; j < rect.y - dy + rect.height; j++) {
    const y = flipRow(dy + j)
    if (y < 0 || y >= TILE_SIZE) continue
    for (let i = rect.x - dx; i < rect.x - dx + rect.width; i++) {
      const x = dx + i
      if (x < 0 || x >= TILE_SIZE) continue
      triples.push(x, y, rgbaPaletteIndex(table, data, (j * width + i) * 4, UNPAINTED))
    }
  }
  return triples
}

/**
 * A write into the draft layer. Never touches the server copy.
 *
 * Unlike the tile itself, a draft array can be made on demand: an empty one means nothing has been
 * drafted here, which is exactly what a tile with no draft layer means. So this cannot fail for want
 * of having read the tile first.
 */
const applyWrite = (tile: TileCoord, triples: readonly number[]): boolean => {
  const key = tileKey(tile)
  forgetTileDigest(key)
  let draft = draftPixels(tile)
  if (draft === null) {
    draft = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)
  }
  rememberDraft(key, draft)
  // Wplace updates crosshair occupancy after the canvas write. Reconcile once at the end of that
  // task so undo cannot momentarily turn a removed opaque draft into a transparent draft.
  let pending = pendingDraftWrites.get(key)
  if (pending === undefined) {
    if (pendingDraftWrites.size === 0) queueMicrotask(flushDraftWrites)
    pending = { tile, before: new Map() }
    pendingDraftWrites.set(key, pending)
  }
  let changed = 0
  for (let i = 0; i < triples.length; i += 3) {
    const x = triples[i] as number
    const y = triples[i + 1] as number
    const index = triples[i + 2] as number
    const p = y * TILE_SIZE + x
    if (draft[p] === index) continue
    if (!pending.before.has(p)) pending.before.set(p, draft[p] ?? UNPAINTED)
    draft[p] = index
    rememberDraftedOffset(key, p, index)
    changed++
  }
  if (changed > 0) count('pixels:patched a draft write')
  return true
}

/** Patch a draft canvas write into its tile, or hold it until the canvas is named. */
export const writeDraftPixels = (canvas: object, triples: number[]): void => {
  const tile = tileOfPaintCanvas.get(canvas)
  if (tile !== undefined && applyWrite(tile, triples)) return
  const queue = queuedWrites.get(canvas)
  if (queue === undefined) queuedWrites.set(canvas, triples)
  else queue.push(...triples)
}

/** Accept one complete read of Wplace's draft canvas and announce its first visible pixels. */
export const captureDraftPixels = (
  tile: TileCoord,
  indices: Uint8Array,
  firstChanges?: readonly number[],
): void => {
  flushDraftWrites()
  const key = tileKey(tile)
  // A preview may change while the PNG stays the same; make the next tile observation do a full read.
  forgetTileDigest(key)
  // Resolve zero-alpha occupancy before diffing. Otherwise an unchanged transparent draft emits
  // a removal followed by a replacement on every fallback readback.
  const transparent = new Set<number>()
  const transparentChanges: number[] = []
  for (const p of draftedPixelsIn(tile, TILE_SIZE)) {
    if (indices[p] !== UNPAINTED) continue
    indices[p] = TRANSPARENT_INDEX
    transparent.add(p)
    transparentChanges.push(p % TILE_SIZE, Math.floor(p / TILE_SIZE), TRANSPARENT_INDEX)
  }
  if (transparent.size > 0) transparentOfTile.set(key, transparent)
  else transparentOfTile.delete(key)
  const existing = draftPixels(tile)
  if (existing !== null && existing.length === indices.length) {
    rememberDraft(key, existing)
    applyPixels(tile, existing, indices, 'draft', null, (p, index) =>
      rememberDraftedOffset(key, p, index),
    )
    count('pixels:draft re-read')
    return
  }

  rememberDraft(key, indices)
  let changedTriples =
    firstChanges === undefined ? undefined : [...firstChanges, ...transparentChanges]
  if (changedTriples === undefined) {
    const discovered: number[] = []
    for (let p = 0; p < indices.length; p++) {
      const index = indices[p] as number
      if (index !== UNPAINTED) discovered.push(p % TILE_SIZE, Math.floor(p / TILE_SIZE), index)
    }
    changedTriples = discovered
  }
  for (let i = 0; i < changedTriples.length; i += 3) {
    const x = changedTriples[i] as number
    const y = changedTriples[i + 1] as number
    rememberDraftedOffset(key, y * TILE_SIZE + x, changedTriples[i + 2] as number)
  }
  notifyPixelBatch(tile, changedTriples, 'draft')
  count('pixels:draft captured')
}

/** Discard all local drafts, or one tile whose native draft canvas was removed or replaced. */
export const clearDraftPixels = (tile?: TileCoord): void => {
  // Native clears remove sparse offsets immediately but publish their changes in a microtask.
  // Cancellation must retain those coordinates too, before discarding the pending transaction.
  const affected = new Map<string, Set<number>>()
  const keys =
    tile === undefined
      ? new Set([...draftedOffsets.keys(), ...pendingDraftWrites.keys()])
      : [tileKey(tile)]
  for (const key of keys) {
    const offsets = new Set(draftedOffsets.get(key)?.keys())
    for (const offset of pendingDraftWrites.get(key)?.before.keys() ?? []) offsets.add(offset)
    affected.set(key, offsets)
  }
  if (tile !== undefined) pendingDraftWrites.delete(tileKey(tile))
  else pendingDraftWrites.clear()
  const changed: Array<{ tile: TileCoord; triples: number[] }> = []
  for (const [key, offsets] of affected) {
    const [x, y] = key.split('/').map(Number)
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue
    const triples: number[] = []
    for (const offset of offsets) {
      const localX = offset % TILE_SIZE
      triples.push(localX, (offset - localX) / TILE_SIZE, UNPAINTED)
    }
    if (triples.length > 0) changed.push({ tile: { x, y }, triples })
  }
  // Delete first: every accounting listener now observes the canonical fallback to server pixels.
  if (tile !== undefined) {
    const key = tileKey(tile)
    draftOfTile.delete(key)
    transparentOfTile.delete(key)
    draftedOffsets.delete(key)
  } else {
    draftOfTile.clear()
    transparentOfTile.clear()
    draftedOffsets.clear()
  }
  for (const one of changed) notifyPixelBatch(one.tile, one.triples, 'draft')
  if (changed.length > 0) count('pixels:drafts cleared')
}

/** Read a draft canvas into palette indices. Tiles are read from their bodies; see `tile-pixels`. */
const capture = (tile: TileCoord, bitmap: CanvasSource, dirty: PixelRect | null = null): boolean =>
  measureProfile('Draft pixel capture', () => {
    const key = tileKey(tile)
    if (!capturesTile(tile)) return false
    if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) return false
    try {
      if (dirty !== null && draftOfTile.has(key)) {
        const context = reusableCaptureContext()
        if (context === null) return false
        // Copy only the region read. Clearing it first keeps transparent pixels unpainted.
        const { x, y, width, height } = dirty
        context.clearRect(x, y, width, height)
        context.drawImage(bitmap, x, y, width, height, x, y, width, height)
        const image = context.getImageData(x, y, width, height)
        count('pixels:draft readback bytes', image.data.byteLength)
        count('pixels:draft readback pixels', dirty.width * dirty.height)
        applyWrite(tile, readWrite(image, dirty.x, dirty.y))
        count('pixels:draft region read')
        return true
      }
      const indices = new Uint8Array(TILE_SIZE * TILE_SIZE)
      const firstDraftChanges: number[] | null = draftOfTile.has(key) ? null : []
      const context = reusableCaptureContext()
      if (context === null) return false
      // The context is reused, and source-over leaves old RGB behind wherever the new bitmap is
      // transparent. Clear first so transparent pixels stay unpainted instead of inheriting the
      // previous draft.
      context.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
      context.drawImage(bitmap, 0, 0)
      const { data } = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE)
      count('pixels:draft readback bytes', data.byteLength)
      count('pixels:draft full reads')
      count('pixels:draft readback pixels', TILE_SIZE * TILE_SIZE)
      const table = paletteRgbIndex()
      for (let i = 0, p = 0; p < indices.length; i += 4, p++) {
        const index = rgbaPaletteIndex(table, data, i, UNPAINTED)
        // A draft canvas is upside down relative to its tile — see `flipRow`. The tile PNG is not.
        const x = p % TILE_SIZE
        const y = flipRow((p - x) / TILE_SIZE)
        indices[y * TILE_SIZE + x] = index
        if (index !== UNPAINTED) firstDraftChanges?.push(x, y, index)
      }
      captureDraftPixels(tile, indices, firstDraftChanges ?? [])
      return true
    } catch (error) {
      count('pixels:draft readback failures')
      warn('could not read tile pixels', String(error))
      return false
    }
  })

/** Which draft canvases one WebGL context has read, and when, so each is read once per change. */
export interface DraftCaptureStamps {
  readonly capturedAt: WeakMap<object, number>
  readonly failed: WeakSet<object>
}

export const createDraftCaptureStamps = (): DraftCaptureStamps => ({
  capturedAt: new WeakMap(),
  failed: new WeakSet(),
})

/**
 * Read a draft canvas MapLibre is drawing, if it changed since `stamps` last saw it or capture was
 * switched on since. `source` is the canvas the drawn texture was uploaded from, if known.
 */
export const refreshDraftCanvas = (
  source: CanvasSource | undefined,
  stamps: DraftCaptureStamps,
): void => {
  if (!isCapturing()) return
  if (source === undefined) {
    count('paint:draw of a texture with no canvas')
    return
  }
  const tile = tileOfPaintCanvas.get(source)
  if (tile === undefined) {
    count('paint:draw of an unnamed draft canvas')
    return
  }
  // Do not stamp a preview that capture() will reject. Interest can expand while capture stays
  // enabled; leaving this texture unstamped makes that unchanged preview eligible then.
  if (!capturesTile(tile)) return
  const stale = stamps.capturedAt.get(source) !== captureGeneration()
  if (!stale && !dirtyCanvases.has(source)) return
  const dirty = stale ? null : dirtyCanvases.get(source)
  count(
    stale
      ? 'pixels:draft baseline captures'
      : dirty
        ? 'pixels:draft dirty-region captures'
        : 'pixels:draft dirty-full captures',
  )
  if (stamps.failed.has(source)) count('pixels:draft capture retries')
  if (!capture(tile, source, dirty)) {
    stamps.failed.add(source)
    return
  }
  stamps.failed.delete(source)
  dirtyCanvases.delete(source)
  stamps.capturedAt.set(source, captureGeneration())
  queuedWrites.delete(source)
}
