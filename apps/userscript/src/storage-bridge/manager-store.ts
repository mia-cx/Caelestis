import { managerValues, watchManagerValue } from '../stored-values.js'
import type { StringStore } from './serve.js'

const manager = globalThis as typeof globalThis & {
  GM_getResourceURL?: (name: string, isBlobUrl?: boolean) => string
}

/** Whether this world can read the userscript's `@resource`s itself. */
export const readsManagerResources = (): boolean => manager.GM_getResourceURL !== undefined

/**
 * The userscript's `@resource` called `name`, as a `data:` URL any world can fetch. Violentmonkey
 * returns one when asked; a manager that returns a `blob:` URL owns it in its own world, so this
 * one reads it here.
 */
export const managerResource = async (name: string): Promise<string> => {
  if (manager.GM_getResourceURL === undefined) throw new Error('no userscript resources here')
  const url = manager.GM_getResourceURL(name, false)
  if (url.startsWith('data:')) return url
  const blob = await (await fetch(url)).blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

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
      const values: Record<string, string> = {}
      for (const key of managerValues.keys()) {
        const value = managerValues.get(key)
        if (value !== null) values[key] = value
        watch(key)
      }
      return values
    },
    async write(key, value) {
      if (value === null) managerValues.delete(key)
      else managerValues.set(key, value)
      watch(key)
    },
    onChange(listener) {
      changed = listener
    },
    watch(key) {
      watch(key)
      return managerValues.get(key)
    },
    resource: managerResource,
  }
}
