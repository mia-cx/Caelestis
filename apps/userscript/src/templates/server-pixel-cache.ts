import { warn } from '../debug.js'
import { isStoredBlob } from '../page-world.js'
import { openTemplateDatabase, SERVER_PIXELS_STORE } from './persist.js'
import { cutPixels, packPixels, type SparsePixels, unpackPixels } from './sparse-pixels.js'

/**
 * Server template pixels kept on disk, so an evicted copy reloads without downloading it again.
 *
 * One entry per template, tagged with the version it holds: any other version is a miss. The cache
 * is best effort. A failed read or write only means downloading the template again.
 */

interface CachedServerPixels {
  /** The template's store id, which already names its server and surface. */
  readonly key: string
  readonly version: string
  readonly opaque: number
  /** Painted chunks packed back to back; the whole image in entries written before chunks. */
  readonly indices: Blob
  /** Which chunks `indices` holds; absent in entries written before chunks. */
  readonly chunks?: readonly number[]
}

/** What a cached version costs and holds, known without reading its pixels. */
export interface CachedServerCopy {
  readonly opaque: number
  /** Painted chunk area, or the whole box for an entry written before chunks. */
  readonly area: number
}

/** Run one transaction; `run` queues its requests and returns how to read the result once committed. */
const transact = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => () => T,
): Promise<T> => {
  const db = await openTemplateDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(SERVER_PIXELS_STORE, mode)
      const result = run(transaction.objectStore(SERVER_PIXELS_STORE))
      transaction.oncomplete = () => resolve(result())
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('indexedDB transaction failed'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('indexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

const cachedEntry = async (key: string, version: string): Promise<CachedServerPixels | null> => {
  const value: unknown = await transact('readonly', (store) => {
    const read = store.get(key)
    return () => read.result
  })
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Partial<CachedServerPixels>
  return entry.version === version &&
    Number.isSafeInteger(entry.opaque) &&
    isStoredBlob(entry.indices) &&
    (entry.chunks === undefined || Array.isArray(entry.chunks))
    ? (entry as CachedServerPixels)
    : null
}

/** Keep a server template's pixels for this version, replacing any other version. */
export const saveServerPixels = async (
  key: string,
  version: string,
  pixels: SparsePixels,
  opaque: number,
): Promise<void> => {
  try {
    const packed = packPixels(pixels)
    const entry: CachedServerPixels = {
      key,
      version,
      opaque,
      indices: new Blob([packed.bytes.buffer as ArrayBuffer]),
      chunks: packed.chunks,
    }
    await transact('readwrite', (store) => {
      store.put(entry)
      return () => undefined
    })
  } catch (error) {
    warn('install', `could not cache server template ${key}`, String(error))
  }
}

/** A cached version's opaque count and stored area, without reading its pixels. Null on a miss. */
export const cachedServerCopy = async (
  key: string,
  version: string,
): Promise<CachedServerCopy | null> => {
  try {
    const entry = await cachedEntry(key, version)
    return entry === null ? null : { opaque: entry.opaque, area: entry.indices.size }
  } catch (error) {
    warn('install', `could not read cached server template ${key}`, String(error))
    return null
  }
}

/** The cached pixels of this version, or null on a miss or an entry that does not fit its size. */
export const readServerPixels = async (
  key: string,
  version: string,
  width: number,
  height: number,
): Promise<SparsePixels | null> => {
  try {
    const entry = await cachedEntry(key, version)
    if (entry === null) return null
    const bytes = new Uint8Array(await entry.indices.arrayBuffer())
    if (entry.chunks !== undefined)
      return unpackPixels(width, height, { bytes, chunks: entry.chunks })
    return bytes.length === width * height ? cutPixels(width, height, bytes) : null
  } catch (error) {
    warn('install', `could not read cached server template ${key}`, String(error))
    return null
  }
}

/** Drop cached pixels for templates the server no longer publishes. */
export const forgetServerPixels = async (keys: readonly string[]): Promise<void> => {
  if (keys.length === 0) return
  try {
    await transact('readwrite', (store) => {
      for (const key of keys) store.delete(key)
      return () => undefined
    })
  } catch (error) {
    warn('install', 'could not drop cached server templates', String(error))
  }
}

/** Among cached entries whose key starts with `prefix` (one server's), drop those `keep` rejects. */
export const retainServerPixels = async (
  prefix: string,
  keep: (key: string) => boolean,
): Promise<void> => {
  try {
    const range = IDBKeyRange.bound(prefix, `${prefix}${String.fromCharCode(0xffff)}`)
    const keys = await transact('readonly', (store) => {
      const read = store.getAllKeys(range)
      return () => read.result
    })
    const stale = keys.filter((key): key is string => typeof key === 'string' && !keep(key))
    await forgetServerPixels(stale)
  } catch (error) {
    warn('install', 'could not prune cached server templates', String(error))
  }
}
