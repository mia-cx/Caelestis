import { bridgedResource } from '../storage-bridge/connect.js'
import { managerResource, readsManagerResources } from '../storage-bridge/manager-store.js'

/**
 * The release userscript's Ditherette binary in the `@resource` called `name`, rejected unless its
 * SHA-256 is `sha256` (base64). `ditherette-plugin.mjs` binds both to `ditherette:wasm`. Only the
 * manager's world can read resources, so the page-world copy asks for them over the storage
 * bridge. Violentmonkey ignores the hash in the `@resource` URL, so the bytes are checked here.
 */
export default async (name: string, sha256: string): Promise<ArrayBuffer> => {
  const url = readsManagerResources() ? await managerResource(name) : await bridgedResource(name)
  const bytes = await (await fetch(url)).arrayBuffer()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if (btoa(String.fromCharCode(...digest)) !== sha256)
    throw new Error(`resource ${name} does not match its pinned hash`)
  return bytes
}
