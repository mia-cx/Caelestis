import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './bridge-protocol.js'
import { loadStoredStrings, onStoredStringsChange, writeStoredString } from './storage.js'

/**
 * The extension's isolated-world content script: the page world's only way to `chrome.storage`.
 * See `bridge-protocol.ts` for the handshake.
 *
 * The manifest lists this script before the page-world one, so its listener is the first on
 * `window` and can stop the handoff event before any page listener runs.
 */

const load = (): Promise<Record<string, string>> =>
  loadStoredStrings().catch((error: unknown) => {
    // Caelestis then starts on its defaults, as a fresh install would.
    console.warn('[caelestis] could not load stored values', error)
    return {}
  })

const loaded = load()

const onHandoff = (event: MessageEvent): void => {
  if (event.source !== window || event.data?.type !== BRIDGE_HANDOFF) return
  event.stopImmediatePropagation()
  window.removeEventListener('message', onHandoff, true)
  // No port: the userscript runs this page, so the bridge stays closed.
  const port = event.ports[0]
  if (port === undefined) return
  const send = (message: BridgeMessage): void => port.postMessage(JSON.stringify(message))
  // Writes and syncs settle in the order they were sent, so a sync answers after every earlier
  // write is stored: what lets a tab hand shared values to the next under a Web Lock.
  let queue: Promise<unknown> = loaded
  port.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as PageMessage
    queue = queue.then(async () => {
      if (message.type === 'write') await writeStoredString(message.key, message.value)
      else send({ type: 'synced', id: message.id, values: await load() })
    })
  }
  void loaded.then((values) => {
    send({ type: 'snapshot', values })
    onStoredStringsChange((changes) => send({ type: 'changes', changes }))
  })
}

window.addEventListener('message', onHandoff, true)
