import {
  awaitingSettings,
  linkOtherBuild,
  meetOtherBuild,
  serveOtherBuild,
} from '../build-transfer.js'
import { installFeatures, installPageHooks } from '../main.js'
import { claimPage } from '../page-claim.js'
import { useStoredValues } from '../stored-values.js'
import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './bridge-protocol.js'

/**
 * The extension's page-world content script, run at document start.
 *
 * When this copy runs Caelestis, the page hooks install at once, before Wplace's modules evaluate.
 * Everything that reads stored values waits for the isolated world's snapshot of
 * `chrome.storage.local`; changes made elsewhere afterwards apply as they arrive. When the
 * userscript runs Caelestis instead, this copy only serves its storage to it.
 */

/** Serve stored values from the bridge; `loaded` runs once the snapshot is in. */
const connectBridge = (loaded: () => void): void => {
  const values = new Map<string, string>()
  const channel = new MessageChannel()
  const port = channel.port1
  const send = (message: PageMessage): void => port.postMessage(JSON.stringify(message))
  const syncs = new Map<number, (values: Record<string, string> | null) => void>()
  let lastSync = 0
  const adopt = useStoredValues(values, {
    persist: (key, value) => send({ type: 'write', key, value }),
    fetch: () =>
      new Promise((resolve, reject) => {
        const id = ++lastSync
        syncs.set(id, (values) =>
          values === null ? reject(new Error('stored values are out of reach')) : resolve(values),
        )
        send({ type: 'sync', id })
      }),
  })
  port.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as BridgeMessage
    switch (message.type) {
      case 'snapshot':
        for (const [key, value] of Object.entries(message.values)) values.set(key, value)
        loaded()
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
  // The bridge hears from this script before any Wplace script can post.
  window.postMessage({ type: BRIDGE_HANDOFF }, location.origin, [channel.port2])
}

const otherBuild = meetOtherBuild()

if (claimPage('extension')) {
  connectBridge(() => {
    const awaiting = awaitingSettings()
    installFeatures()
    if (otherBuild !== null) linkOtherBuild(otherBuild, 'extension', awaiting)
  })
  installPageHooks()
} else {
  connectBridge(() => {
    if (otherBuild !== null) serveOtherBuild(otherBuild, 'extension')
  })
}
