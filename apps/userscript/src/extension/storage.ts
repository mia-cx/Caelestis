/**
 * The slice of `chrome.storage.local` the extension's bridge and popup use, as plain strings: the only values
 * Caelestis stores.
 */

interface StorageChange {
  readonly newValue?: unknown
}

interface StorageArea {
  get(keys: null): Promise<Record<string, unknown>>
  set(items: Record<string, string>): Promise<void>
  remove(key: string): Promise<void>
}

declare const chrome: {
  readonly storage: {
    readonly local: StorageArea
    readonly onChanged: {
      addListener(listener: (changes: Record<string, StorageChange>, area: string) => void): void
    }
  }
}

const storage = (): StorageArea => chrome.storage.local

/** Every stored string. */
export const loadStoredStrings = async (): Promise<Record<string, string>> => {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(await storage().get(null))) {
    if (typeof value === 'string') values[key] = value
  }
  return values
}

/** Store `value` under `key`, or delete it for `null`. Resolves `false` when that failed. */
export const writeStoredString = async (key: string, value: string | null): Promise<boolean> => {
  try {
    await (value === null ? storage().remove(key) : storage().set({ [key]: value }))
    return true
  } catch (error) {
    console.warn(`[caelestis] could not store ${key}`, error)
    return false
  }
}

/** Run `listener` with every change to stored strings, from any context; `null` for a delete. */
export const onStoredStringsChange = (
  listener: (changes: Record<string, string | null>) => void,
): void => {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const strings: Record<string, string | null> = {}
    for (const [key, { newValue }] of Object.entries(changes)) {
      strings[key] = typeof newValue === 'string' ? newValue : null
    }
    listener(strings)
  })
}
