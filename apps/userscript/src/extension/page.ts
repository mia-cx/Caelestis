import {
  awaitingSettings,
  linkOtherBuild,
  meetOtherBuild,
  serveOtherBuild,
} from '../build-transfer.js'
import { installFeatures, installPageHooks } from '../main.js'
import { connectStorageBridge } from '../storage-bridge/connect.js'

/**
 * The extension's page-world content script, run at document start.
 *
 * When this copy runs Caelestis, the page hooks install at once, before Wplace's modules evaluate.
 * Everything that reads stored values waits for the isolated world's snapshot of
 * `chrome.storage.local`. When the userscript runs Caelestis instead, this copy only serves its
 * values to it.
 */
const other = meetOtherBuild()

const claimed = connectStorageBridge('extension', () => {
  if (!claimed) {
    if (other !== null) serveOtherBuild(other, 'extension')
    return
  }
  const awaiting = awaitingSettings()
  installFeatures()
  if (other !== null) linkOtherBuild(other, 'extension', awaiting)
})

if (claimed) installPageHooks()
