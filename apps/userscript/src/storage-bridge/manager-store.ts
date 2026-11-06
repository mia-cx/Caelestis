import type { StringStore } from './serve.js'

const manager = globalThis as typeof globalThis & {
  GM_listValues?: () => string[]
  GM_getValue?: (key: string, fallback: null) => unknown
  GM_setValue?: (key: string, value: string) => void
  GM_deleteValue?: (key: string) => void
  GM_addValueChangeListener?: (
    key: string,
    listener: (key: string, before: unknown, after: unknown, remote: boolean) => void,
  ) => unknown
}

/**
 * Whether the userscript manager's storage can be served over the bridge: it needs listing for the
 * snapshot. Without any manager storage, as in a page-world dev harness, `localStorage` stands in.
 */
export const canServeManagerStorage = (): boolean =>
  manager.GM_getValue === undefined || manager.GM_listValues !== undefined

/**
 * The userscript manager's `GM_*` storage, as the userscript's storage bridge serves it.
 *
 * Read directly, every read of it was current, including another tab's writes. Served as a snapshot
 * it is not, so every key this tab has stored, loaded, or asked for is watched for writes from other
 * tabs. A key asked for reports the value it already has, in case another tab wrote it first.
 */
export const managerStore = (): StringStore => {
  let changed: ((changes: Record<string, string | null>) => void) | undefined
  const watched = new Set<string>()
  const watch = (key: string): void => {
    if (watched.has(key) || manager.GM_addValueChangeListener === undefined) return
    watched.add(key)
    manager.GM_addValueChangeListener(key, (_key, _before, after, remote) => {
      if (remote) changed?.({ [key]: typeof after === 'string' ? after : null })
    })
  }
  return {
    async load() {
      try {
        const { GM_listValues, GM_getValue } = manager
        const values: Record<string, string> = {}
        for (const key of GM_listValues ? GM_listValues() : Object.keys(localStorage)) {
          const value = GM_getValue ? GM_getValue(key, null) : localStorage.getItem(key)
          if (typeof value === 'string') values[key] = value
          watch(key)
        }
        return values
      } catch (error) {
        console.warn('[caelestis] could not load stored values', error)
        return null
      }
    },
    async write(key, value) {
      try {
        if (value === null) {
          if (manager.GM_deleteValue) manager.GM_deleteValue(key)
          else localStorage.removeItem(key)
        } else if (manager.GM_setValue) manager.GM_setValue(key, value)
        else localStorage.setItem(key, value)
        watch(key)
        return true
      } catch (error) {
        console.warn(`[caelestis] could not store ${key}`, error)
        return false
      }
    },
    onChange(listener) {
      changed = listener
    },
    watch(key) {
      watch(key)
      const value = manager.GM_getValue?.(key, null)
      if (typeof value === 'string') changed?.({ [key]: value })
    },
  }
}
