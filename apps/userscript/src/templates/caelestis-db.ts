import { migrateTemplateStorePalette } from './palette-migration.js'

/**
 * The one IndexedDB database every Caelestis store lives in, and the only code that opens or
 * upgrades it.
 *
 * IndexedDB rather than `GM_setValue` or `localStorage`: a `.wplace` file's decoded index array runs
 * to megabytes, past what a string store holds, and IndexedDB takes a `Uint8Array` directly.
 */

const DB_NAME = 'caelestis'
// v8 packs template pixels into chunks; the bump closes older tabs out, since they read packed
// records as corrupt and would delete them.
const VERSION = 8

export const LOCAL_TEMPLATES_STORE = 'local-templates'
export const LOCAL_TEMPLATE_VERSIONS_STORE = 'local-template-versions'
export const LOCAL_TAGS_STORE = 'local-tags'
export const SERVER_CACHE_STORE = 'server-cache'
/** Server template pixels on disk, so an evicted copy reloads without downloading it again. */
export const SERVER_PIXELS_STORE = 'server-pixels'

const PALETTE_MIGRATION_DB_VERSION = 4

let blockedOpenRequest: IDBOpenDBRequest | null = null
let blockedOpenRecovery: Promise<void> | null = null
let settleBlockedOpen: (() => void) | null = null

const markOpenBlocked = (request: IDBOpenDBRequest): void => {
  blockedOpenRequest = request
  if (blockedOpenRecovery !== null) return
  blockedOpenRecovery = new Promise<void>((resolve) => {
    settleBlockedOpen = resolve
  })
}

const finishBlockedOpen = (request: IDBOpenDBRequest): void => {
  if (blockedOpenRequest !== request) return
  blockedOpenRequest = null
  const settle = settleBlockedOpen
  settleBlockedOpen = null
  blockedOpenRecovery = null
  settle?.()
}

/** Resolves once a blocked open has settled and one retry may be attempted; null when none is blocked. */
export const blockedOpenSettled = (): Promise<void> | null => blockedOpenRecovery

const upgrade = (request: IDBOpenDBRequest, oldVersion: number): void => {
  const db = request.result
  const create = (name: string, keyPath: string | string[]): void => {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath })
  }
  create(LOCAL_TEMPLATES_STORE, 'id')
  create(LOCAL_TEMPLATE_VERSIONS_STORE, ['id', 'revision'])
  create(LOCAL_TAGS_STORE, 'id')
  create(SERVER_CACHE_STORE, 'url')
  create(SERVER_PIXELS_STORE, 'key')
  if (oldVersion < PALETTE_MIGRATION_DB_VERSION) {
    const templates = request.transaction?.objectStore(LOCAL_TEMPLATES_STORE)
    if (templates !== undefined) migrateTemplateStorePalette(templates)
  }
}

/**
 * Open the database, upgrading it when needed. The caller closes the connection.
 *
 * Another tab on an older version blocks the upgrade. The blocked request is abandoned (its
 * connection is closed the moment it succeeds), and every open fails fast until it settles.
 */
export const openCaelestisDb = (): Promise<IDBDatabase> => {
  if (blockedOpenRequest !== null) {
    return Promise.reject(new Error('indexedDB.open is still blocked by another connection'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    let abandoned = false
    request.onupgradeneeded = (event) => upgrade(request, event.oldVersion)
    request.onblocked = () => {
      abandoned = true
      markOpenBlocked(request)
      reject(new Error('indexedDB.open blocked by another connection'))
    }
    request.onsuccess = () => {
      const db = request.result
      finishBlockedOpen(request)
      if (abandoned) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => {
      finishBlockedOpen(request)
      reject(request.error ?? new Error('indexedDB.open failed'))
    }
  })
}
