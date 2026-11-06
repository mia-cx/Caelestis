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

/**
 * Serve stored values from `values` and report each change to `persist` (`null` for a delete).
 *
 * The extension calls this before anything reads a value, with a map that stays empty until its
 * storage has loaded, so an early read returns the default rather than a page-readable fallback.
 */
export const useStoredValues = (
  values: Map<string, string>,
  persist: (key: string, value: string | null) => void,
): void => {
  backing = {
    get: (key) => values.get(key) ?? null,
    set(key, value) {
      values.set(key, value)
      persist(key, value)
    },
    delete(key) {
      values.delete(key)
      persist(key, null)
    },
  }
}

/** The stored string for `key`, or `null` when nothing is stored. */
export const storedValue = (key: string): string | null => backing.get(key)

export const storeValue = (key: string, value: string): void => backing.set(key, value)

export const deleteStoredValue = (key: string): void => backing.delete(key)
