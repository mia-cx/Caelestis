/**
 * Caelestis's stored values: the small string records that outlive a page load, such as settings,
 * connected servers and their tokens.
 *
 * Every module reads and writes them here, under the same key names in every build, so a value
 * written by one build is found by another. The userscript keeps them in the manager's `GM_*`
 * storage, which wplace's own scripts cannot read. Without a userscript manager (tests, a page-world
 * dev harness) they fall back to `localStorage`.
 *
 * Each call can throw where the underlying storage does, such as `localStorage` in a private
 * window, so callers keep their own fallback for a failed read or write.
 */

const manager = globalThis as typeof globalThis & {
  GM_getValue?: (key: string, fallback: null) => unknown
  GM_setValue?: (key: string, value: string) => void
  GM_deleteValue?: (key: string) => void
}

/** The stored string for `key`, or `null` when nothing is stored. */
export const storedValue = (key: string): string | null => {
  if (typeof manager.GM_getValue !== 'function') return localStorage.getItem(key)
  const value = manager.GM_getValue(key, null)
  return typeof value === 'string' ? value : null
}

export const storeValue = (key: string, value: string): void => {
  if (typeof manager.GM_setValue === 'function') manager.GM_setValue(key, value)
  else localStorage.setItem(key, value)
}

export const deleteStoredValue = (key: string): void => {
  if (typeof manager.GM_deleteValue === 'function') manager.GM_deleteValue(key)
  else localStorage.removeItem(key)
}
