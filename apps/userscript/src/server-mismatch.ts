import { decodeMismatchMask, type MismatchMask, TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { nextPixelObservation, recordPixelObservation } from './pixel-observation.js'
import {
  deleteCachedServerMismatch,
  deleteCachedServerMismatches,
  readCachedServerMismatch,
  writeCachedServerMismatch,
} from './server-mismatch-cache.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
} from './state.js'

const REQUEST_TIMEOUT_MS = 15_000
const RETRY_AFTER_MS = 5_000
const MAX_RESPONSE_BYTES = 12 + Math.ceil((TILE_SIZE * TILE_SIZE) / 4)

interface ServerTemplateRef {
  readonly serverUrl?: string
  readonly serverTemplateId?: string
  readonly serverVersion?: string
  /** A draft's masks stay in memory: the page can read Cache Storage. */
  readonly serverUnpublished?: boolean
}

interface HeldMask {
  readonly server: ConnectedServer
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
  readonly at: number
}

const masks = new Map<string, HeldMask>()
const misses = new Map<string, HeldMiss>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let requestedThisFrame: Set<string> | null = null
let useGeneration = 0
const tileInvalidations = new Map<string, number>()
const serverInvalidations = new Map<string, number>()

const MAX_HELD_MASKS = 512
const MAX_HELD_MASK_BYTES = 16 * 1024 * 1024
const MAX_TILE_INVALIDATIONS = 512

/** Memory one held mask keeps alive, including unsaved bytes that no longer share its buffer. */
const heldBytes = (held: HeldMask): number =>
  held.mask.packed.byteLength +
  12 +
  (held.unsaved === null || held.unsaved.buffer === held.mask.packed.buffer
    ? 0
    : held.unsaved.byteLength)

export const serverMismatchMemoryBytes = (): number => {
  let bytes = 0
  for (const held of masks.values()) bytes += heldBytes(held)
  return bytes
}

const keyFor = (
  server: ConnectedServer,
  templateId: string,
  version: string,
  tile: TileCoord,
): string =>
  `${server.url}\u0000${server.info?.id ?? ''}\u0000${server.season}\u0000${templateId}\u0000${version}\u0000${tile.x}/${tile.y}`

const invalidationKeyFor = (serverUrl: string, tile: TileCoord): string =>
  `${serverUrl}\u0000${tile.x}/${tile.y}`

const serverFor = (template: ServerTemplateRef): ConnectedServer | null => {
  if (
    template.serverUrl === undefined ||
    template.serverTemplateId === undefined ||
    template.serverVersion === undefined
  )
    return null
  const server = getState().servers.find((candidate) => candidate.url === template.serverUrl)
  return server?.status === 'connected' && server.season !== null ? server : null
}

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
  templateId: string,
  version: string,
  tile: TileCoord,
  key: string,
  persist: boolean,
): Promise<void> => {
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
    const cached = await readCachedServerMismatch(key)
    if (cached !== null && serverCurrent()) {
      const mask = decodeMismatchMask(cached.bytes)
      if (mask === null) void deleteCachedServerMismatch(key)
      else {
        // A saved mask is enough to draw immediately; the request below still refreshes it.
        validator = {
          server,
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
    if (serverCurrent()) misses.set(key, { server, at: Date.now() })
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
      void writeCachedServerMismatch(key, validator.unsaved, validator.etag)
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
    void deleteCachedServerMismatch(key)
    misses.set(key, { server, at: Date.now() })
    if (changed) notify()
    return
  }
  const declaredHeader = response.headers.get('content-length')
  const declared = declaredHeader === null ? null : Number(declaredHeader)
  if (
    response.status !== 200 ||
    (declared !== null &&
      Number.isFinite(declared) &&
      (declared < 1 || declared > MAX_RESPONSE_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined)
    misses.set(key, { server, at: Date.now() })
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A missed revision or an unpublish can land while a large body is being consumed. That check
  // belongs to the old world; reject the body before it can repopulate memory or the disk.
  if (!serverCurrent()) return
  if (bytes.length > MAX_RESPONSE_BYTES) {
    misses.set(key, { server, at: Date.now() })
    return
  }
  const mask = decodeMismatchMask(bytes)
  if (mask === null) {
    misses.set(key, { server, at: Date.now() })
    return
  }
  const fresh = tileCurrent()
  const etag = response.headers.get('etag')
  misses.delete(key)
  recordPixelObservation(mask.packed, requested)
  // Only a fresh answer is saved: one older than a paint must not outlive this page as current.
  // An overtaken one waits for the 304 that confirms it.
  if (persist && fresh) void writeCachedServerMismatch(key, bytes, etag)
  masks.set(key, {
    server,
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
  const server = serverFor(template)
  if (
    server === null ||
    template.serverTemplateId === undefined ||
    template.serverVersion === undefined
  )
    return null
  const key = keyFor(server, template.serverTemplateId, template.serverVersion, tile)
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
  const request = readMask(
    server,
    template.serverTemplateId,
    template.serverVersion,
    tile,
    key,
    template.serverUnpublished !== true,
  ).finally(() => {
    if (pending.get(key) !== request) return
    pending.delete(key)
    // Paints that landed during the request left its answer stale; one redraw reads it again.
    if (
      (tileInvalidations.get(invalidationKey) ?? 0) !== tileInvalidation ||
      (serverInvalidations.get(server.url) ?? 0) !== serverInvalidation
    )
      notify()
  })
  pending.set(key, request)
  return shown
}

/** Advance one server tile's invalidation generation, keeping the map bounded. */
const advanceTileInvalidation = (invalidationKey: string): void => {
  const generation = (tileInvalidations.get(invalidationKey) ?? 0) + 1
  tileInvalidations.delete(invalidationKey)
  tileInvalidations.set(invalidationKey, generation)
  while (tileInvalidations.size > MAX_TILE_INVALIDATIONS) {
    let removed = false
    for (const candidate of tileInvalidations.keys()) {
      const separator = candidate.lastIndexOf('\u0000')
      const pendingPrefix = `${candidate.slice(0, separator)}\u0000`
      const pendingSuffix = `\u0000${candidate.slice(separator + 1)}`
      let hasPending = false
      for (const key of pending.keys()) {
        if (!key.startsWith(pendingPrefix) || !key.endsWith(pendingSuffix)) continue
        hasPending = true
        break
      }
      if (hasPending) continue
      tileInvalidations.delete(candidate)
      removed = true
      break
    }
    if (!removed) break
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
    invalidated.add(`${tile.x}/${tile.y}`)
  }
  if (invalidated.size === 0) return
  const prefix = `${serverUrl}\u0000`
  const covers = (key: string): boolean =>
    key.startsWith(prefix) && invalidated.has(key.slice(key.lastIndexOf('\u0000') + 1))
  let changed = false
  for (const [key, held] of masks) {
    if (held.stale || !covers(key)) continue
    held.stale = true
    changed = true
  }
  for (const key of [...misses.keys()]) {
    if (!covers(key)) continue
    misses.delete(key)
    changed = true
  }
  if (changed) notify()
}

/** A missed status revision can cover any tile, so discard every derived mask for that server. */
export const invalidateServerMismatches = (serverUrl: string): void => {
  serverInvalidations.set(serverUrl, (serverInvalidations.get(serverUrl) ?? 0) + 1)
  const prefix = `${serverUrl}\u0000`
  let changed = false
  for (const key of [...masks.keys()]) {
    if (!key.startsWith(prefix)) continue
    masks.delete(key)
    changed = true
  }
  for (const key of [...misses.keys()]) {
    if (!key.startsWith(prefix)) continue
    misses.delete(key)
    changed = true
  }
  void deleteCachedServerMismatches(serverUrl)
  if (changed) notify()
}

export const onServerMismatchesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
