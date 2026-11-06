import { installFeatures, installPageHooks } from '../main.js'
import { claimPage } from '../page-claim.js'
import { useStoredValues } from '../stored-values.js'
import { BRIDGE_HANDOFF, type StoredSnapshot, type StoredWrite } from './bridge-protocol.js'

/**
 * The extension's page-world content script, run at document start.
 *
 * The page hooks install at once, before Wplace's modules evaluate. Everything that reads stored
 * values waits for the isolated world's snapshot of `chrome.storage.local`.
 */
const start = (): void => {
  const values = new Map<string, string>()
  const channel = new MessageChannel()
  const port = channel.port1
  useStoredValues(values, (key, value) => {
    const write: StoredWrite = { key, value }
    port.postMessage(JSON.stringify(write))
  })
  port.onmessage = ({ data }) => {
    port.onmessage = null
    const snapshot = JSON.parse(String(data)) as StoredSnapshot
    for (const [key, value] of Object.entries(snapshot.values)) values.set(key, value)
    installFeatures()
  }
  window.postMessage({ type: BRIDGE_HANDOFF }, location.origin, [channel.port2])
  installPageHooks()
}

if (claimPage('extension')) start()
