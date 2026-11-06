import { installFeatures, installPageHooks } from '../main.js'
import { connectStorageBridge } from '../storage-bridge/connect.js'

/**
 * The extension's page-world content script, run at document start.
 *
 * The page hooks install at once, before Wplace's modules evaluate. Everything that reads stored
 * values waits for the isolated world's snapshot of `chrome.storage.local`.
 */
if (connectStorageBridge('extension', installFeatures)) installPageHooks()
