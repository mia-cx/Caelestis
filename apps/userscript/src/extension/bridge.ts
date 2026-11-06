import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './bridge-protocol.js'
import { loadStoredStrings, onStoredStringsChange, writeStoredString } from './storage.js'

/**
 * The extension's isolated-world content script: the page world's only way to `chrome.storage`.
 * See `bridge-protocol.ts` for the handshake.
 *
 * The manifest lists this script before the page-world one, so its listener is the first on
 * `window` and can stop the handoff event before any page listener runs.
 */

const load = (): Promise<Record<string, string> | null> =>
  loadStoredStrings().catch((error: unknown) => {
    console.warn('[caelestis] could not load stored values', error)
    return null
  })

const loaded = load()

const onHandoff = (event: MessageEvent): void => {
  if (event.source !== window || event.data?.type !== BRIDGE_HANDOFF) return
  event.stopImmediatePropagation()
  window.removeEventListener('message', onHandoff, true)
  // Only the first handoff counts; without a port, the bridge stays closed.
  const port = event.ports[0]
  if (port === undefined) return
  const send = (message: BridgeMessage): void => port.postMessage(JSON.stringify(message))
  // Writes and syncs settle in the order they were sent, so a sync answers after every earlier
  // write is stored: what lets a tab hand shared values to the next under a Web Lock.
  let queue: Promise<unknown> = loaded
  let writeFailed = false
  port.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as PageMessage
    queue = queue.then(async () => {
      if (message.type === 'write') {
        if (!(await writeStoredString(message.key, message.value))) writeFailed = true
        return
      }
      const values = writeFailed ? null : await load()
      writeFailed = false
      send({ type: 'synced', id: message.id, values })
    })
  }
  void loaded.then((values) => {
    // Unreadable storage at load: Caelestis starts on its defaults, as a fresh install would.
    send({ type: 'snapshot', values: values ?? {} })
    onStoredStringsChange((changes) => send({ type: 'changes', changes }))
  })
}

window.addEventListener('message', onHandoff, true)
