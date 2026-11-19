import { registerPixelLoader } from './residency.js'
import { loadLocalPixels } from './restore.js'
import { loadCopyPixels } from './template-copies.js'

/** Tell residency how to reload evicted Local templates and copies. Before any entry is admitted. */
export const installPixelLoaders = (): void => {
  registerPixelLoader('local', loadLocalPixels)
  registerPixelLoader('copy', loadCopyPixels)
}
