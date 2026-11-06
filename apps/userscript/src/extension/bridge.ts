import { serveStorageBridge } from '../storage-bridge/serve.js'
import { loadStoredStrings, onStoredStringsChange, writeStoredString } from './storage.js'

/**
 * The extension's isolated-world content script: the page world's only way to `chrome.storage`.
 * See `storage-bridge/protocol.ts` for the handshake.
 *
 * The manifest lists this script before the page-world one, so its listener is the first on
 * `window` and can stop the handoff event before any page listener runs.
 */
serveStorageBridge('extension', {
  load: () =>
    loadStoredStrings().catch((error: unknown) => {
      console.warn('[caelestis] could not load stored values', error)
      return null
    }),
  write: writeStoredString,
  onChange: onStoredStringsChange,
})
