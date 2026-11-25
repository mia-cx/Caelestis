import { bridgedResource } from '../storage-bridge/connect.js'
import { managerResource, readsManagerResources } from '../storage-bridge/manager-store.js'

/**
 * `ditherette:wasm` in the release userscript, which carries Ditherette's binaries as `@resource`s
 * rather than inline (see `ditherette-plugin.mjs`). Only the manager's world can read them, so the
 * page-world copy asks for them over the storage bridge. Nothing loads until a recipe first runs.
 */
export default async (variant: 'scalar' | 'gpu'): Promise<ArrayBuffer> => {
  const name = `ditherette-${variant}`
  const url = readsManagerResources() ? await managerResource(name) : await bridgedResource(name)
  return (await fetch(url)).arrayBuffer()
}
