import { warn } from '../debug.js'
import { storedValue, storeValue } from '../stored-values.js'

export type TemplateDisplayMode = 'tree' | 'grid'

// Keep presentation outside the catalog record, which other open tabs also write.
const STORAGE_KEY = 'caelestis.template-display-mode'

/** Read the local display preference; missing or invalid preferences use the tree. */
export const templateDisplayMode = (): TemplateDisplayMode => {
  try {
    return storedValue(STORAGE_KEY) === 'grid' ? 'grid' : 'tree'
  } catch (error) {
    warn('install', 'could not read template display preference', String(error))
    return 'tree'
  }
}

/** Persist a presentation change without writing catalog, ordering, or visibility state. */
export const setTemplateDisplayMode = (mode: TemplateDisplayMode): boolean => {
  try {
    storeValue(STORAGE_KEY, mode)
    return true
  } catch (error) {
    warn('install', 'could not save template display preference', String(error))
    return false
  }
}
