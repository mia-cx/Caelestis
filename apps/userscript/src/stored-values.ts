/**
 * Caelestis's stored values: the small string records that outlive a page load, such as settings,
 * connected servers and their tokens.
 *
 * Every module reads and writes them here, under the same key names in every build, so a value
 * written by one build is found by another. The userscript keeps them in the manager's `GM_*`
 * storage, which wplace's own scripts cannot read. The extension serves them from a snapshot of
 * `chrome.storage.local` (see `useStoredValues`). Without either (tests, a page-world dev harness)
 * they fall back to `localStorage`.
 *
 * Each call can throw where the underlying storage does, such as `localStorage` in a private
 * window, so callers keep their own fallback for a failed read or write.
 */

interface StoredValues {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

const manager = globalThis as typeof globalThis & {
  GM_getValue?: (key: string, fallback: null) => unknown
  GM_setValue?: (key: string, value: string) => void
  GM_deleteValue?: (key: string) => void
}

const managerValues: StoredValues = {
  get(key) {
    if (typeof manager.GM_getValue !== 'function') return localStorage.getItem(key)
    const value = manager.GM_getValue(key, null)
    return typeof value === 'string' ? value : null
  },
  set(key, value) {
    if (typeof manager.GM_setValue === 'function') manager.GM_setValue(key, value)
    else localStorage.setItem(key, value)
  },
  delete(key) {
    if (typeof manager.GM_deleteValue === 'function') manager.GM_deleteValue(key)
    else localStorage.removeItem(key)
  },
}

let backing = managerValues
/** Brings this context up to date with storage; the manager's storage always is. */
let sync = (): Promise<void> => Promise.resolve()
const changeListeners = new Set<(key: string) => void>()

/**
 * Run `listener` with the key of each value changed somewhere else, such as the extension's toolbar
 * popup or another tab. Only the extension reports these; this context's own writes never do. Returns a function that stops
 * listening.
 */
export const onStoredValueChange = (listener: (key: string) => void): (() => void) => {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

/**
 * Settle once this context's writes are stored and its values match storage. Rejects, leaving
 * values as they were, when storage could not be read or one of those writes failed.
 *
 * The manager's storage is shared and synchronous, so the userscript is always settled. The
 * extension's is not: a tab that reads values another tab shares under a Web Lock, such as the
 * claim journal, syncs after taking the lock and again before releasing it.
 */
export const syncStoredValues = (): Promise<void> => sync()

/**
 * Serve stored values from `values`, reporting each write to `persist` (`null` for a delete) and
 * reading all of storage again through `fetch`.
 *
 * The extension calls this before anything reads a value, with a map that stays empty until its
 * storage has loaded, so an early read returns the default rather than a page-readable fallback.
 * Returns the function that applies changes made elsewhere: it updates `values` and tells the
 * `onStoredValueChange` listeners about each key whose value actually changed.
 */
export const useStoredValues = (
  values: Map<string, string>,
  storage: {
    readonly persist: (key: string, value: string | null) => void
    /** Every stored value, read after this context's earlier writes were stored; rejects when not. */
    readonly fetch: () => Promise<Record<string, string>>
  },
): ((changes: Readonly<Record<string, string | null>>) => void) => {
  backing = {
    get: (key) => values.get(key) ?? null,
    set(key, value) {
      values.set(key, value)
      storage.persist(key, value)
    },
    delete(key) {
      values.delete(key)
      storage.persist(key, null)
    },
  }
  const adopt = (changes: Readonly<Record<string, string | null>>): void => {
    const changed = Object.entries(changes).filter(([key, value]) => {
      if ((values.get(key) ?? null) === value) return false
      if (value === null) values.delete(key)
      else values.set(key, value)
      return true
    })
    for (const [key] of changed) {
      for (const listener of changeListeners) listener(key)
    }
  }
  sync = async () => {
    const stored = await storage.fetch()
    const removed = [...values.keys()].filter((key) => !Object.hasOwn(stored, key))
    adopt({ ...Object.fromEntries(removed.map((key) => [key, null])), ...stored })
  }
  return adopt
}

/** The stored string for `key`, or `null` when nothing is stored. */
export const storedValue = (key: string): string | null => backing.get(key)

export const storeValue = (key: string, value: string): void => backing.set(key, value)

export const deleteStoredValue = (key: string): void => backing.delete(key)
