import {
  decodeMismatchMask,
  MAX_MISMATCH_MASK_BYTES,
  type MismatchMask,
  type TileCoord,
} from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { nextPixelObservation, recordPixelObservation } from './pixel-observation.js'
import { registerProfileMemorySource } from './profile.js'
import {
  activeServerToken,
  type ConnectedServer,
  connectedServerAt,
  isCurrentServerConnection,
} from './server-connections.js'
import {
  deleteCachedServerMismatch,
  deleteCachedServerMismatches,
  type MismatchKey,
  mismatchKeyString,
  readCachedServerMismatch,
  writeCachedServerMismatch,
} from './server-mismatch-cache.js'
import { serverEndpoint } from './server-url.js'

const REQUEST_TIMEOUT_MS = 15_000
/**
 * The renderer asks for a visible tile's mask every frame, so a failed read waits this long before
 * the next frame may ask the server again.
 */
const RETRY_AFTER_MS = 5_000
/** The mask's rectangle fields, counted alongside its packed bytes. */
const HELD_MASK_OVERHEAD_BYTES = 12

interface ServerTemplateRef {
  readonly serverUrl?: string
  readonly serverTemplateId?: string
  readonly serverVersion?: string
  /** A draft's masks stay in memory: the page can read Cache Storage. */
  readonly serverUnpublished?: boolean
}

interface HeldMask {
  readonly server: ConnectedServer
  readonly key: MismatchKey
  readonly mask: MismatchMask
  /** The server's validator for this mask, or null from a server that sends none. */
  readonly etag: string | null
  /**
   * A paint landed on this tile after the mask was read. It is still drawn, because draft pixels
   * newer than the read take precedence, and is revalidated the next time it is drawn.
   */
  stale: boolean
  /** A response that a paint overtook, kept so the 304 confirming it can save it. */
  readonly unsaved: Uint8Array | null
  lastUsed: number
}

interface HeldMiss {
  readonly server: ConnectedServer
  readonly key: MismatchKey
  readonly at: number
}

interface PendingRead {
  readonly key: MismatchKey
  readonly request: Promise<void>
}

/** Held masks, misses and reads in flight, by `mismatchKeyString`. */
const masks = new Map<string, HeldMask>()
const misses = new Map<string, HeldMiss>()
const pending = new Map<string, PendingRead>()
const listeners = new Set<() => void>()
let requestedThisFrame: Set<string> | null = null
let useGeneration = 0
/** Invalidation generation per server tile, by `invalidationKeyFor`. */
const tileInvalidations = new Map<string, number>()
const serverInvalidations = new Map<string, number>()

const MAX_HELD_MASKS = 512
const MAX_HELD_MASK_BYTES = 16 * 1024 * 1024
const MAX_TILE_INVALIDATIONS = 512

/** Memory one held mask keeps alive, including unsaved bytes that no longer share its buffer. */
const heldBytes = (held: HeldMask): number =>
  held.mask.packed.byteLength +
  HELD_MASK_OVERHEAD_BYTES +
  (held.unsaved === null || held.unsaved.buffer === held.mask.packed.buffer
    ? 0
    : held.unsaved.byteLength)

export const serverMismatchMemoryBytes = (): number => {
  let bytes = 0
  for (const held of masks.values()) bytes += heldBytes(held)
  return bytes
}
registerProfileMemorySource('Server mismatch masks', serverMismatchMemoryBytes)

const invalidationKeyFor = (serverUrl: string, tile: TileCoord): string =>
  `${serverUrl}\u0000${tile.x}/${tile.y}`

const tileName = (tile: TileCoord): string => `${tile.x}/${tile.y}`

const notify = (): void => {
  for (const listener of listeners) listener()
}

/**
 * Read one mask, revalidating the copy already held in memory or on disk.
 *
 * A paint on the tile while the request is in the air does not throw the answer away: it is at
 * least as new as what was drawn before, so it is drawn, marked stale, and read once more. Only a
 * server-wide invalidation discards it, because that one also fences drafts and missed revisions.
 */
const readMask = async (
  server: ConnectedServer,
  mismatch: MismatchKey,
  persist: boolean,
): Promise<void> => {
  const { templateId, version, tile } = mismatch
  const key = mismatchKeyString(mismatch)
  const miss = (): void => {
    misses.set(key, { server, key: mismatch, at: Date.now() })
  }
  const token = activeServerToken(server)
  const invalidationKey = invalidationKeyFor(server.url, tile)
  const invalidation = tileInvalidations.get(invalidationKey) ?? 0
  const serverInvalidation = serverInvalidations.get(server.url) ?? 0
  const serverCurrent = (): boolean =>
    isCurrentServerConnection(server) &&
    (serverInvalidations.get(server.url) ?? 0) === serverInvalidation
  const tileCurrent = (): boolean => (tileInvalidations.get(invalidationKey) ?? 0) === invalidation

  const held = masks.get(key)
  let validator = held !== undefined && isCurrentServerConnection(held.server) ? held : undefined
  if (validator === undefined) {
    const cached = await readCachedServerMismatch(mismatch)
    if (cached !== null && serverCurrent()) {
      const mask = decodeMismatchMask(cached.bytes)
      if (mask === null) void deleteCachedServerMismatch(mismatch)
      else {
        // A saved mask is enough to draw immediately; the request below still refreshes it.
        validator = {
          server,
          key: mismatch,
          mask,
          etag: cached.etag,
          stale: true,
          unsaved: null,
          lastUsed: ++useGeneration,
        }
        masks.set(key, validator)
        notify()
      }
    }
  }

  const requested = nextPixelObservation()
  const response = await fetch(
    serverEndpoint(
      server.url,
      `/telemetry/templates/${templateId}/versions/${version}/tiles/${tile.x}/${tile.y}/mismatches?season=${server.season}`,
    ),
    {
      headers: {
        ...userscriptClientHeaders(),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(validator?.etag == null ? {} : { 'if-none-match': validator.etag }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  ).catch(() => null)
  if (response === null) {
    if (serverCurrent()) miss()
    return
  }
  if (!serverCurrent()) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (response.status === 304 && validator !== undefined) {
    misses.delete(key)
    // Confirmed current as of this request, so draft pixels older than it no longer take precedence.
    // A new buffer, as every read gives: marker scans are cached by the buffer, and one computed
    // under the older observation must not answer for this one.
    const mask = { ...validator.mask, packed: validator.mask.packed.slice() }
    recordPixelObservation(mask.packed, requested)
    const fresh = tileCurrent()
    // The answer a paint overtook is now confirmed current, so it may replace the saved copy.
    if (fresh && validator.unsaved !== null)
      void writeCachedServerMismatch(mismatch, validator.unsaved, validator.etag)
    masks.set(key, {
      ...validator,
      mask,
      stale: !fresh,
      unsaved: fresh ? null : validator.unsaved,
      lastUsed: ++useGeneration,
    })
    notify()
    return
  }
  // Anything else that answers a request older than a paint on this tile says nothing current.
  // The stale mask stays drawn and the caller reads again.
  if (response.status !== 200 && !tileCurrent()) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (response.status === 204 || response.status === 404) {
    const changed = masks.delete(key)
    void deleteCachedServerMismatch(mismatch)
    miss()
    if (changed) notify()
    return
  }
  const declaredHeader = response.headers.get('content-length')
  const declared = declaredHeader === null ? null : Number(declaredHeader)
  if (
    response.status !== 200 ||
    (declared !== null &&
      Number.isFinite(declared) &&
      (declared < 1 || declared > MAX_MISMATCH_MASK_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined)
    miss()
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A missed revision or an unpublish can land while a large body is being consumed. That check
  // belongs to the old world; reject the body before it can repopulate memory or the disk.
  if (!serverCurrent()) return
  if (bytes.length > MAX_MISMATCH_MASK_BYTES) {
    miss()
    return
  }
  const mask = decodeMismatchMask(bytes)
  if (mask === null) {
    miss()
    return
  }
  const fresh = tileCurrent()
  const etag = response.headers.get('etag')
  misses.delete(key)
  recordPixelObservation(mask.packed, requested)
  // Only a fresh answer is saved: one older than a paint must not outlive this page as current.
  // An overtaken one waits for the 304 that confirms it.
  if (persist && fresh) void writeCachedServerMismatch(mismatch, bytes, etag)
  masks.set(key, {
    server,
    key: mismatch,
    mask,
    etag,
    stale: !fresh,
    unsaved: persist && !fresh ? bytes : null,
    lastUsed: ++useGeneration,
  })
  notify()
}

/** Called around one marker frame so the memory cache can retain a bounded offscreen working set. */
export const beginServerMismatchFrame = (): void => {
  requestedThisFrame = new Set()
}

export const endServerMismatchFrame = (): void => {
  const requested = requestedThisFrame
  requestedThisFrame = null
  if (requested === null) return
  let bytes = serverMismatchMemoryBytes()
  const offscreen = [...masks]
    .filter(([key]) => !requested.has(key))
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  for (const [key, held] of offscreen) {
    if (masks.size <= MAX_HELD_MASKS && bytes <= MAX_HELD_MASK_BYTES) break
    masks.delete(key)
    bytes -= heldBytes(held)
  }
  for (const key of [...misses.keys()]) if (!requested.has(key)) misses.delete(key)
}

/**
 * Latest server classification for one visible template tile. Null starts or awaits the first
 * read; a stale mask is returned while its revalidation runs.
 */
export const serverMismatchMaskFor = (
  template: ServerTemplateRef,
  tile: TileCoord,
): MismatchMask | null => {
  if (
    template.serverUrl === undefined ||
    template.serverTemplateId === undefined ||
    template.serverVersion === undefined
  )
    return null
  const server = connectedServerAt(template.serverUrl)
  if (server === undefined) return null
  const mismatch: MismatchKey = {
    serverUrl: server.url,
    serverId: server.info.id,
    season: server.season,
    templateId: template.serverTemplateId,
    version: template.serverVersion,
    tile,
  }
  const key = mismatchKeyString(mismatch)
  const invalidationKey = invalidationKeyFor(server.url, tile)
  requestedThisFrame?.add(key)
  const stored = masks.get(key)
  const held = stored !== undefined && isCurrentServerConnection(stored.server) ? stored : undefined
  if (held !== undefined) {
    held.lastUsed = ++useGeneration
    if (!held.stale) return held.mask
  }
  const shown = held?.mask ?? null
  const miss = misses.get(key)
  if (
    pending.has(key) ||
    (miss !== undefined &&
      isCurrentServerConnection(miss.server) &&
      Date.now() - miss.at < RETRY_AFTER_MS)
  )
    return shown
  const tileInvalidation = tileInvalidations.get(invalidationKey) ?? 0
  const serverInvalidation = serverInvalidations.get(server.url) ?? 0
  const request = readMask(server, mismatch, template.serverUnpublished !== true).finally(() => {
    if (pending.get(key)?.request !== request) return
    pending.delete(key)
    // Paints that landed during the request left its answer stale; one redraw reads it again.
    if (
      (tileInvalidations.get(invalidationKey) ?? 0) !== tileInvalidation ||
      (serverInvalidations.get(server.url) ?? 0) !== serverInvalidation
    )
      notify()
  })
  pending.set(key, { key: mismatch, request })
  return shown
}

/**
 * Advance one server tile's invalidation generation, keeping the map bounded. A tile with a read in
 * flight keeps its generation: that read compares against it when it lands.
 */
const advanceTileInvalidation = (invalidationKey: string): void => {
  const generation = (tileInvalidations.get(invalidationKey) ?? 0) + 1
  tileInvalidations.delete(invalidationKey)
  tileInvalidations.set(invalidationKey, generation)
  if (tileInvalidations.size <= MAX_TILE_INVALIDATIONS) return
  const reading = new Set(
    [...pending.values()].map(({ key }) => invalidationKeyFor(key.serverUrl, key.tile)),
  )
  for (const candidate of tileInvalidations.keys()) {
    if (tileInvalidations.size <= MAX_TILE_INVALIDATIONS) return
    if (!reading.has(candidate)) tileInvalidations.delete(candidate)
  }
}

/**
 * Paints landed on these server tiles: every mask held for them is stale.
 *
 * Stale masks stay drawn and saved; each is revalidated with its validator when next drawn, so a
 * burst of status deltas costs one conditional request per visible mask, not one download per delta.
 */
export const invalidateServerMismatchTiles = (
  serverUrl: string,
  tiles: Iterable<TileCoord>,
): void => {
  const invalidated = new Set<string>()
  for (const tile of tiles) {
    advanceTileInvalidation(invalidationKeyFor(serverUrl, tile))
    invalidated.add(tileName(tile))
  }
  if (invalidated.size === 0) return
  const covers = (key: MismatchKey): boolean =>
    key.serverUrl === serverUrl && invalidated.has(tileName(key.tile))
  let changed = false
  for (const held of masks.values()) {
    if (held.stale || !covers(held.key)) continue
    held.stale = true
    changed = true
  }
  for (const [key, held] of [...misses]) {
    if (!covers(held.key)) continue
    misses.delete(key)
    changed = true
  }
  if (changed) notify()
}

/** A missed status revision can cover any tile, so discard every derived mask for that server. */
export const invalidateServerMismatches = (serverUrl: string): void => {
  serverInvalidations.set(serverUrl, (serverInvalidations.get(serverUrl) ?? 0) + 1)
  let changed = false
  for (const held of [masks, misses]) {
    for (const [key, entry] of [...held]) {
      if (entry.key.serverUrl !== serverUrl) continue
      held.delete(key)
      changed = true
    }
  }
  void deleteCachedServerMismatches(serverUrl)
  if (changed) notify()
}

export const onServerMismatchesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
