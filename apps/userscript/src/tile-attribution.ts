import { TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { count, logRender, warn } from './debug.js'
import { notifyListeners } from './listeners.js'
import { type InstalledValueHook, installValueHook } from './page-hooks.js'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { isPageInstance } from './page-world.js'
import { normalizeMissingTileResponse, tileFromUrl } from './wplace-raster.js'

/**
 * Which tile a decoded bitmap is.
 *
 * The chain from URL to texture is `fetch → bytes → Blob → ImageBitmap → texImage2D`, and object
 * identity does not survive the first step on its own. Wplace reads a tile with `arrayBuffer()` and
 * builds its own `Blob` from the bytes, so the *buffer* is tagged, and the `Blob` constructor is
 * wrapped to carry the tag onto whatever `Blob` gets built from it. Byte length stays only as a
 * fallback for anything reaching `createImageBitmap` by another path.
 */

/**
 * Tiles whose bytes have been seen but whose `ImageBitmap` has not been built yet, keyed by
 * response byte length. A queue per length, because two tiles can compress to the same size — every
 * empty tile is 73 bytes — so same-size tiles are matched first-in, first-out.
 */
interface QueuedTile {
  readonly tile: TileCoord
  readonly at: number
}

const tilesByByteLength = new Map<number, QueuedTile[]>()

/**
 * How many unattributed tiles of one size to remember. Unbounded, a long pan would fill the queue
 * with tiles attributed by identity and never consumed, and the oldest would answer for a different
 * tile.
 */
const MAX_QUEUED_PER_SIZE = 8

/**
 * How long an unattributed tile stays in the size queue. A tile's fetch-to-decode gap is
 * milliseconds; anything older was dropped from the viewport mid-pan, and keeping it would only
 * mislabel an unrelated tile of the same size.
 */
const MAX_QUEUE_AGE_MS = 30_000

const expireQueues = (now: number): void => {
  for (const [bytes, queue] of tilesByByteLength) {
    const live = queue.filter((entry) => now - entry.at < MAX_QUEUE_AGE_MS)
    if (live.length === 0) tilesByByteLength.delete(bytes)
    else if (live.length !== queue.length) tilesByByteLength.set(bytes, live)
  }
}

/** Retire a tile's size entry once it has been decoded or read some other way. */
export const consumeBySize = (bytes: number, tile: TileCoord): void => {
  const queue = tilesByByteLength.get(bytes)
  if (queue === undefined) return
  const remaining = queue.filter((entry) => entry.tile.x !== tile.x || entry.tile.y !== tile.y)
  if (remaining.length === 0) tilesByByteLength.delete(bytes)
  else if (remaining.length !== queue.length) tilesByByteLength.set(bytes, remaining)
}

const enqueueBySize = (bytes: number, tile: TileCoord, now = Date.now()): void => {
  expireQueues(now)
  const queue = tilesByByteLength.get(bytes) ?? []
  queue.push({ tile, at: now })
  if (queue.length > MAX_QUEUED_PER_SIZE) queue.shift()
  tilesByByteLength.set(bytes, queue)
}

/** The tile a decoded bitmap of this size must be, if exactly one is waiting at that size. */
const takeBySizeForBitmap = (
  bytes: number,
  width: number,
  height: number,
  now = Date.now(),
): TileCoord | undefined => {
  if (width !== TILE_SIZE || height !== TILE_SIZE) return undefined
  expireQueues(now)
  // Same-size decodes can resolve out of order. Missing an overlay tile is visible and
  // self-correcting; confidently swapping two coordinates is not.
  const queue = tilesByByteLength.get(bytes)
  if (queue?.length !== 1) return undefined
  tilesByByteLength.delete(bytes)
  return queue[0]?.tile
}

const tileOfBlobs = new WeakMap<Blob, TileCoord>()
const tileOfBuffers = new WeakMap<ArrayBufferLike, TileCoord>()
const tileOfBitmaps = new WeakMap<ImageBitmap, TileCoord>()
const digestOfBlobs = new WeakMap<Blob, Promise<ArrayBuffer | null>>()

/** The tile a decoded bitmap was attributed to, if any. */
export const tileOfBitmap = (bitmap: ImageBitmap): TileCoord | undefined =>
  tileOfBitmaps.get(bitmap)

/** The SHA-256 the Blob tap started for a tile body, when capture-dedupe wanted one. */
export const digestOfBlob = (blob: Blob): Promise<ArrayBuffer | null> | undefined =>
  digestOfBlobs.get(blob)

type FetchedTileListener = (tile: TileCoord, bytes: Uint8Array, observedAt: number) => void
type FetchedTileInterest = (tile: TileCoord) => boolean
const fetchedTileListeners = new Map<FetchedTileListener, FetchedTileInterest | null>()

/** Observe exact PNG bytes only after Wplace itself consumes a canvas tile response. */
export const onFetchedTile = (
  listener: FetchedTileListener,
  interest: FetchedTileInterest | null = null,
): (() => void) => {
  fetchedTileListeners.set(listener, interest)
  return () => fetchedTileListeners.delete(listener)
}

const interestedTileListeners = (tile: TileCoord): readonly FetchedTileListener[] => {
  const interested: FetchedTileListener[] = []
  for (const [listener, wants] of fetchedTileListeners) {
    try {
      if (wants === null || wants(tile)) interested.push(listener)
    } catch {
      count('telemetry:tile-interest-failed')
    }
  }
  return interested
}

const notifyFetchedTile = (tile: TileCoord, bytes: Uint8Array): void => {
  const listeners = interestedTileListeners(tile)
  if (listeners.length === 0) return
  const held = bytes.slice()
  const observedAt = Math.floor(Date.now() / 1_000)
  notifyListeners(listeners, 'fetched tile listener failed', tile, held, observedAt)
}

/**
 * Tag the body Wplace reads from a tile response.
 *
 * Real tile pixels are only tapped, never composited with ours. The native response is handed
 * back with only its two read methods shadowed by own properties, so Wplace calls these and
 * receives the objects tagged here; replacing the response would lose `url`, `redirected`, `type`
 * and `bodyUsed` semantics. The one rewrite is an absent tile: with no controlling service worker
 * the origin answers 404, which becomes the transparent PNG the service worker ordinarily gives,
 * so first visits still give MapLibre a texture and the overlay a quad to align against.
 */
const tagTileResponse = (
  response: Response,
  tile: TileCoord,
  realm: Window & typeof globalThis,
  normalizeMissing: boolean,
): Response => {
  try {
    if (normalizeMissing) response = normalizeMissingTileResponse(response, realm)
    if (!response.ok) return response
    const tappedResponse = response
    const nativeArrayBuffer = response.arrayBuffer
    const nativeBlob = response.blob
    const recordRead = (bytes: number): void => {
      // The size queue is only a last resort. Queue when the page actually consumes the body,
      // rather than delaying fetch to duplicate every response pre-emptively.
      enqueueBySize(bytes, tile)
      logRender('fetch', `tile ${tile.x}/${tile.y}`, {
        bytes,
        status: tappedResponse.status,
        sizesWaiting: tilesByByteLength.size,
      })
    }
    const wrappedArrayBuffer = {
      arrayBuffer(this: Response): Promise<ArrayBuffer> {
        return nativeArrayBuffer.call(this).then((own) => {
          try {
            if (this === tappedResponse) {
              tileOfBuffers.set(own, tile)
              recordRead(own.byteLength)
              notifyFetchedTile(tile, new Uint8Array(own))
            }
          } catch {
            // The native read already consumed the body successfully; observation cannot reject it.
          }
          return own
        })
      },
    }.arrayBuffer
    const wrappedBlob = {
      blob(this: Response): Promise<Blob> {
        return nativeBlob.call(this).then((blob) => {
          try {
            if (this === tappedResponse) {
              tileOfBlobs.set(blob, tile)
              recordRead(blob.size)
              if (interestedTileListeners(tile).length > 0) {
                void blob
                  .arrayBuffer()
                  .then((bytes) => notifyFetchedTile(tile, new Uint8Array(bytes)))
                  .catch(() => {})
              }
            }
          } catch {
            // The native read already consumed the body successfully; observation cannot reject it.
          }
          return blob
        })
      },
    }.blob
    const arrayBufferHook = installValueHook(response, 'arrayBuffer', wrappedArrayBuffer)
    if (arrayBufferHook === null) return response
    if (installValueHook(response, 'blob', wrappedBlob) === null) arrayBufferHook.restore()
    return response
  } catch (error) {
    // A body we cannot read is a tile we cannot attribute; it simply goes undrawn.
    warn(`could not read body for ${tile.x}/${tile.y}`, String(error))
    return response
  }
}

type TileRequestListener = (tile: TileCoord, url: string) => void
const tileRequestListeners = new Set<TileRequestListener>()

/**
 * Hear of each tile request as Wplace sends it. The tile object is the one its body, Blob and
 * bitmap will be attributed to, so its identity can carry the request through to the decode.
 */
export const onTileRequest = (listener: TileRequestListener): void => {
  tileRequestListeners.add(listener)
}

const tileRoute: RequestRoute = (request) => {
  const tile = tileFromUrl(request.raw)
  if (tile === null) return undefined
  for (const listener of tileRequestListeners) listener(tile, request.raw)
  const normalizeMissing = request.isGet()
  return {
    response: (response) => tagTileResponse(response, tile, request.realm, normalizeMissing),
  }
}

/** Tag tile responses as Wplace fetches them. */
export const observeTileResponses = (): void => {
  observePageRequests(tileRoute)
}

/**
 * Blob parts worth inspecting for tagged buffers. Kept separate because the Blob constructor has
 * already consumed the input once before attribution gets a look at it.
 */
const blobPartsForAttribution = (parts: unknown): readonly unknown[] => {
  if (!Array.isArray(parts)) return []
  try {
    const descriptors = Object.getOwnPropertyDescriptors(parts)
    const values: unknown[] = []
    for (const [property, descriptor] of Object.entries(descriptors)) {
      if (!/^\d+$/.test(property)) continue
      // Do not invoke accessors a second time. Native Blob already observed them once.
      if ('value' in descriptor) values.push(descriptor.value)
    }
    return values
  } catch {
    // Proxies can trap descriptor reads. Attribution is not worth another observable failure.
    return []
  }
}

/**
 * Carry a tagged buffer's tile onto the Blob built from it. `wantsDigest` says whether to hash the
 * body as well, so an unchanged tile can skip its read.
 */
export const installBlobTap = (
  realm: Window & typeof globalThis,
  wantsDigest: (tile: TileCoord) => boolean,
): InstalledValueHook | null => {
  const NativeBlob = realm.Blob
  // Built through `Reflect.construct` with the caller's `new.target`, so `Blob()` without `new`
  // still throws and `class X extends Blob {}` still produces an `X`.
  //
  // `blob.constructor` still answers `NativeBlob` rather than this wrapper, because the wrapper
  // borrows the native prototype rather than building its own. Replacing the prototype to fix that
  // would put an object in the chain that no page-realm Blob has, which is the worse trade.
  // biome-ignore lint/suspicious/noExplicitAny: standing in for the Blob constructor overloads
  const Wrapped = function (this: unknown, ...args: any[]) {
    if (new.target === undefined) {
      // Delegate the invalid call too: the browser supplies both the native message and a page-realm
      // TypeError, while throwing here would manufacture the error in the userscript sandbox.
      return Reflect.apply(NativeBlob, this, args)
    }
    // A direct `new Blob(...)` targets the wrapper, which has no native slots — hand the native
    // constructor to `Reflect.construct` in that case, and the subclass otherwise.
    const target = new.target as unknown as typeof Blob
    // Arguments forwarded exactly as given, arity included: `new Blob(null)` must still be refused.
    const blob = Reflect.construct(
      NativeBlob,
      args,
      (target as unknown) === (Wrapped as unknown) ? NativeBlob : target,
    ) as Blob
    try {
      const parts = blobPartsForAttribution(args[0])
      for (const part of parts) {
        const buffer = isPageInstance(
          part,
          'ArrayBuffer',
          realm as unknown as Record<string, unknown>,
        )
          ? (part as ArrayBuffer)
          : realm.ArrayBuffer.isView(part)
            ? part.buffer
            : undefined
        const tile = buffer === undefined ? undefined : tileOfBuffers.get(buffer)
        if (tile !== undefined) {
          tileOfBlobs.set(blob, tile)
          // Blob copies its parts at construction. Hash that exact single part after the copy,
          // without holding up Wplace's constructor or its response body read.
          if (
            parts.length === 1 &&
            blob.size === (realm.ArrayBuffer.isView(part) ? part.byteLength : buffer?.byteLength) &&
            wantsDigest(tile)
          ) {
            try {
              const digest = realm.crypto.subtle.digest('SHA-256', part as BufferSource)
              digestOfBlobs.set(
                blob,
                digest.catch(() => null),
              )
            } catch {
              // A missing or failing page crypto leaves the normal capture path intact.
            }
          }
          logRender('bitmap', `blob built from tagged buffer ${tile.x}/${tile.y}`, {
            bytes: blob.size,
          })
          break
        }
      }
    } catch {
      // Native construction already succeeded. Attribution must not change that observable result.
    }
    return blob
  } as unknown as typeof Blob
  const nativePrototype = Object.getOwnPropertyDescriptor(NativeBlob, 'prototype')
  if (nativePrototype === undefined) return null
  Object.defineProperty(Wrapped, 'prototype', nativePrototype)
  Object.defineProperty(Wrapped, 'name', { value: NativeBlob.name, configurable: true })
  return installValueHook(realm, 'Blob', Wrapped)
}

/** A tile Wplace decoded, with the body it decoded and the hash the Blob tap started, if any. */
export type DecodedTileListener = (
  tile: TileCoord,
  bitmap: ImageBitmap,
  body: Blob,
  digest: Promise<ArrayBuffer | null> | undefined,
) => void

/** The page's own decoder, behind our tap, for tile reads when there is no worker. */
let decodeOnPage: (body: Blob) => Promise<ImageBitmap> = (body) => createImageBitmap(body)

/** Decode a tile body with the page's native decoder, past the bitmap tap. */
export const decodeTileOnPage = (body: Blob): Promise<ImageBitmap> => decodeOnPage(body)

/** Attribute each tile bitmap Wplace decodes, and report it to `decoded`. */
export const installBitmapTap = (
  realm: Window & typeof globalThis,
  decoded: DecodedTileListener,
): InstalledValueHook | null => {
  const nativeCreateImageBitmap = realm.createImageBitmap
  decodeOnPage = (body) => Reflect.apply(nativeCreateImageBitmap, realm, [body])
  const wrappedCreateImageBitmap = {
    // biome-ignore lint/suspicious/noExplicitAny: createImageBitmap has two overload shapes
    createImageBitmap(this: unknown, ...args: any[]): Promise<ImageBitmap> {
      const pendingBitmap = Reflect.apply(
        nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>,
        this,
        args,
      )
      let sourceBlob: Blob | undefined
      let sourceBytes: number | undefined
      let exact: TileCoord | undefined
      let sourceIsPageBlob = false
      try {
        const source = args[0]
        if (isPageInstance(source, 'Blob', realm as unknown as Record<string, unknown>)) {
          sourceIsPageBlob = true
          sourceBlob = source as Blob
          sourceBytes = sourceBlob.size
          exact = tileOfBlobs.get(sourceBlob)
          if (exact !== undefined) {
            // Reserve exact attribution before decode yields. Otherwise an untagged same-size bitmap
            // can settle first and steal this tile's sole byte-length fallback entry.
            consumeBySize(sourceBytes, exact)
          }
        }
      } catch {
        // Native decoding has started. Attribution must not change its eventual result.
      }
      if (!sourceIsPageBlob) return pendingBitmap
      return pendingBitmap.then((bitmap) => {
        try {
          if (sourceBlob !== undefined && sourceBytes !== undefined) {
            if (exact !== undefined) {
              tileOfBitmaps.set(bitmap, exact)
              logRender('bitmap', `matched ${exact.x}/${exact.y} by identity`, {
                bytes: sourceBytes,
              })
              // Decode and hash ran together. A failed digest resolves to null and reads in full.
              decoded(exact, bitmap, sourceBlob, digestOfBlobs.get(sourceBlob))
              return bitmap
            }
            count('bitmap:fell-back-to-byte-length')
            const tile = takeBySizeForBitmap(sourceBytes, bitmap.width, bitmap.height)
            if (tile !== undefined) {
              tileOfBitmaps.set(bitmap, tile)
              decoded(tile, bitmap, sourceBlob, undefined)
              logRender('bitmap', `matched ${tile.x}/${tile.y}`, { bytes: sourceBytes })
            } else if (bitmap.width === TILE_SIZE && bitmap.height === TILE_SIZE) {
              // A tile-shaped image we cannot name: it will overwrite a texture's identity.
              logRender(
                'bitmap',
                'unmatched 1000x1000 bitmap — no tile queued at this byte length',
                {
                  bytes: sourceBytes,
                  sizesWaiting: [...tilesByByteLength.keys()].slice(0, 8).join(' '),
                },
              )
            }
          }
        } catch {
          // Native decoding already succeeded. A diagnostic or hostile object cannot reject its promise.
        }
        return bitmap
      })
    },
  }.createImageBitmap as typeof globalThis.createImageBitmap
  return installValueHook(realm, 'createImageBitmap', wrappedCreateImageBitmap)
}
