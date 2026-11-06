import { installFeatures, installPageHooks } from '../main.js'
import { claimPage } from '../page-claim.js'
import { useStoredValues } from '../stored-values.js'
import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './bridge-protocol.js'

/**
 * The extension's page-world content script, run at document start.
 *
 * The page hooks install at once, before Wplace's modules evaluate. Everything that reads stored
 * values waits for the isolated world's snapshot of `chrome.storage.local`; changes made elsewhere
 * afterwards apply as they arrive.
 */
const start = (): void => {
  const values = new Map<string, string>()
  const channel = new MessageChannel()
  const port = channel.port1
  const send = (message: PageMessage): void => port.postMessage(JSON.stringify(message))
  const syncs = new Map<number, (values: Record<string, string>) => void>()
  let lastSync = 0
  const adopt = useStoredValues(values, {
    persist: (key, value) => send({ type: 'write', key, value }),
    fetch: () =>
      new Promise((resolve) => {
        const id = ++lastSync
        syncs.set(id, resolve)
        send({ type: 'sync', id })
      }),
  })
  port.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as BridgeMessage
    switch (message.type) {
      case 'snapshot':
        for (const [key, value] of Object.entries(message.values)) values.set(key, value)
        installFeatures()
        break
      case 'changes':
        adopt(message.changes)
        break
      case 'synced':
        syncs.get(message.id)?.(message.values)
        syncs.delete(message.id)
        break
    }
  }
  window.postMessage({ type: BRIDGE_HANDOFF }, location.origin, [channel.port2])
  installPageHooks()
}

// Whichever way it goes, the bridge hears from this script before any Wplace script can post.
if (claimPage('extension')) start()
else window.postMessage({ type: BRIDGE_HANDOFF }, location.origin)
