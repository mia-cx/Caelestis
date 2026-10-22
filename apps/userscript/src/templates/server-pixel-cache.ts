import { warn } from '../debug.js'
import { isStoredBlob } from '../page-world.js'
import { openTemplateDatabase, SERVER_PIXELS_STORE } from './persist.js'

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
  readonly indices: Blob
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
    isStoredBlob(entry.indices)
    ? (entry as CachedServerPixels)
    : null
}

/** Keep a server template's pixels for this version, replacing any other version. */
export const saveServerPixels = async (
  key: string,
  version: string,
  indices: Uint8Array,
  opaque: number,
): Promise<void> => {
  try {
    const entry: CachedServerPixels = {
      key,
      version,
      opaque,
      indices: new Blob([indices.slice().buffer]),
    }
    await transact('readwrite', (store) => {
      store.put(entry)
      return () => undefined
    })
  } catch (error) {
    warn('install', `could not cache server template ${key}`, String(error))
  }
}

/** The opaque pixel count of a cached version, without reading its pixels. Null on a miss. */
export const cachedServerOpaque = async (key: string, version: string): Promise<number | null> => {
  try {
    return (await cachedEntry(key, version))?.opaque ?? null
  } catch (error) {
    warn('install', `could not read cached server template ${key}`, String(error))
    return null
  }
}

/** The cached pixels of this version, or null on a miss or a wrong-sized entry. */
export const readServerPixels = async (
  key: string,
  version: string,
  area: number,
): Promise<Uint8Array | null> => {
  try {
    const entry = await cachedEntry(key, version)
    if (entry === null || entry.indices.size !== area) return null
    return new Uint8Array(await entry.indices.arrayBuffer())
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
