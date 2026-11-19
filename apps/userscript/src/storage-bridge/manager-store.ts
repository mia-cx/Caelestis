import { managerValues, watchManagerValue } from '../stored-values.js'
import type { StringStore } from './serve.js'

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
    if (watched.has(key)) return
    watched.add(key)
    watchManagerValue(key, (value) => changed?.({ [key]: value }))
  }
  return {
    async load() {
      try {
        const values: Record<string, string> = {}
        for (const key of managerValues.keys()) {
          const value = managerValues.get(key)
          if (value !== null) values[key] = value
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
        if (value === null) managerValues.delete(key)
        else managerValues.set(key, value)
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
      return managerValues.get(key)
    },
  }
}
