import { MAX_MISMATCH_MASK_BYTES, type TileCoord } from '@caelestis/shared'
import { SerialQueue } from './concurrency.js'

const CACHE_NAME = 'caelestis-server-mismatches-v1'
const CACHE_PATH = '/__caelestis-cache/server-mismatch/'
const MAX_ENTRIES = 512
const PRUNE_EVERY_WRITES = 16
const SEPARATOR = '\u0000'

/** Everything that identifies one server mismatch mask: whose, which version, which tile. */
export interface MismatchKey {
  readonly serverUrl: string
  readonly serverId: string
  readonly season: number
  readonly templateId: string
  readonly version: string
  readonly tile: TileCoord
}

/** The key's one string form, used for in-memory maps and as the saved entry's name. */
export const mismatchKeyString = (key: MismatchKey): string =>
  [
    key.serverUrl,
    key.serverId,
    key.season,
    key.templateId,
    key.version,
    `${key.tile.x}/${key.tile.y}`,
  ].join(SEPARATOR)

const parseMismatchKey = (value: string): Pick<MismatchKey, 'serverUrl' | 'templateId'> | null => {
  const parts = value.split(SEPARATOR)
  const [serverUrl, , , templateId] = parts
  return parts.length === 6 && serverUrl !== undefined && templateId !== undefined
    ? { serverUrl, templateId }
    : null
}

/** Within one server's queue, the tile: the unit saved work is serialized on. */
const tileOperationKey = (key: MismatchKey): string => `${key.tile.x}/${key.tile.y}`

let writesUntilPrune = PRUNE_EVERY_WRITES
/** Per server URL, so a server-wide purge waits for exactly that server's tile work. */
const tileOperations = new Map<string, SerialQueue<string>>()
const serverOperations = new SerialQueue<string>()

const tileQueue = (serverUrl: string): SerialQueue<string> => {
  let queue = tileOperations.get(serverUrl)
  if (queue === undefined) {
    queue = new SerialQueue()
    tileOperations.set(serverUrl, queue)
  }
  return queue
}

/** Serialize saved work for one server tile, after any older server-wide purge. */
const serializeTile = async (key: MismatchKey, operation: () => Promise<void>): Promise<void> => {
  await serverOperations.idle(key.serverUrl)
  await tileQueue(key.serverUrl).run(tileOperationKey(key), operation)
}

// Cache Storage can be absent (insecure contexts, some privacy modes) or throw on quota. A saved
// mask is only a head start on the network read, so each failure here means "not saved".
const open = async (): Promise<Cache | null> => {
  try {
    return globalThis.caches === undefined ? null : await globalThis.caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

const requestFor = (key: MismatchKey): Request =>
  new Request(`${location.origin}${CACHE_PATH}${encodeURIComponent(mismatchKeyString(key))}`)

const savedKeyOf = (request: Request): ReturnType<typeof parseMismatchKey> => {
  try {
    const path = new URL(request.url).pathname
    if (!path.startsWith(CACHE_PATH)) return null
    return parseMismatchKey(decodeURIComponent(path.slice(CACHE_PATH.length)))
  } catch {
    return null
  }
}

const prune = async (cache: Cache): Promise<void> => {
  const requests = await cache.keys()
  const remove = Math.max(0, requests.length - MAX_ENTRIES)
  await Promise.all(requests.slice(0, remove).map((request) => cache.delete(request)))
}

/**
 * A saved mask and the server's validator for it; the validator is null for entries saved without
 * one. Enough to draw immediately; the caller still revalidates it with the server.
 */
export const readCachedServerMismatch = async (
  key: MismatchKey,
): Promise<{ readonly bytes: Uint8Array; readonly etag: string | null } | null> => {
  // Reads stay concurrent across tiles. They wait only for an older server-wide purge or work on
  // their tile, so a read started after invalidation cannot overtake its deletion barrier.
  await serverOperations.idle(key.serverUrl)
  await tileQueue(key.serverUrl).idle(tileOperationKey(key))
  const cache = await open()
  if (cache === null) return null
  try {
    const response = await cache.match(requestFor(key))
    if (response === undefined) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_MISMATCH_MASK_BYTES) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length > 0 && bytes.length <= MAX_MISMATCH_MASK_BYTES
      ? { bytes, etag: response.headers.get('etag') }
      : null
  } catch {
    return null
  }
}

export const writeCachedServerMismatch = async (
  key: MismatchKey,
  bytes: Uint8Array,
  etag: string | null,
): Promise<void> => {
  if (bytes.length === 0 || bytes.length > MAX_MISMATCH_MASK_BYTES) return
  await serializeTile(key, async () => {
    const cache = await open()
    if (cache === null) return
    try {
      const request = requestFor(key)
      // Refresh insertion order so the bounded cache behaves as an LRU across page loads.
      await cache.delete(request)
      await cache.put(
        request,
        new Response(bytes.slice().buffer as ArrayBuffer, {
          headers: {
            'content-type': 'application/vnd.caelestis.mismatch-mask',
            ...(etag === null ? {} : { etag }),
          },
        }),
      )
      writesUntilPrune--
      if (writesUntilPrune <= 0) {
        writesUntilPrune = PRUNE_EVERY_WRITES
        await prune(cache)
      }
    } catch {}
  })
}

export const deleteCachedServerMismatch = (key: MismatchKey): Promise<void> =>
  serializeTile(key, async () => {
    const cache = await open()
    if (cache === null) return
    try {
      await cache.delete(requestFor(key))
    } catch {}
  })

/** Delete a server's saved masks, or only one template's when `templateId` is given. */
export const deleteCachedServerMismatches = (serverUrl: string, templateId?: string) =>
  serverOperations.run(serverUrl, async () => {
    await tileQueue(serverUrl).idleAll()
    const cache = await open()
    if (cache === null) return
    try {
      const requests = await cache.keys()
      await Promise.all(
        requests.map((request) => {
          const saved = savedKeyOf(request)
          return saved !== null &&
            saved.serverUrl === serverUrl &&
            (templateId === undefined || saved.templateId === templateId)
            ? cache.delete(request)
            : false
        }),
      )
    } catch {}
  })
