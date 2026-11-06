import { BRIDGE_HANDOFF, type StoredSnapshot, type StoredWrite } from './bridge-protocol.js'

/**
 * The extension's isolated-world content script: the page world's only way to `chrome.storage`.
 * See `bridge-protocol.ts` for the handshake.
 *
 * The manifest lists this script before the page-world one, so its listener is the first on
 * `window` and can stop the handoff event before any page listener runs.
 */

interface StorageArea {
  get(keys: null): Promise<Record<string, unknown>>
  set(items: Record<string, string>): Promise<void>
  remove(key: string): Promise<void>
}

declare const chrome: { readonly storage: { readonly local: StorageArea } }

const storage = chrome.storage.local
const loaded = storage.get(null)

const snapshot = async (): Promise<StoredSnapshot> => {
  const values: Record<string, string> = {}
  try {
    for (const [key, value] of Object.entries(await loaded)) {
      if (typeof value === 'string') values[key] = value
    }
  } catch (error) {
    // Caelestis then starts on its defaults, as a fresh install would.
    console.warn('[caelestis] could not load stored values', error)
  }
  return { values }
}

const write = ({ key, value }: StoredWrite): void => {
  const done = value === null ? storage.remove(key) : storage.set({ [key]: value })
  done.catch((error: unknown) => console.warn(`[caelestis] could not store ${key}`, error))
}

const onHandoff = (event: MessageEvent): void => {
  const port = event.ports[0]
  if (event.source !== window || event.data?.type !== BRIDGE_HANDOFF || port === undefined) return
  event.stopImmediatePropagation()
  window.removeEventListener('message', onHandoff, true)
  port.onmessage = ({ data }) => write(JSON.parse(String(data)) as StoredWrite)
  void snapshot().then((values) => port.postMessage(JSON.stringify(values)))
}

window.addEventListener('message', onHandoff, true)
