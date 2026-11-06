/**
 * The extension's storage bridge, between its page-world script and its isolated-world script.
 *
 * Only the isolated world can reach `chrome.storage.local`, and only the page world can hook
 * Wplace. At document start, before any Wplace script exists, the page-world script posts one
 * `window` message carrying a `MessagePort`; the isolated world takes the port and stops the event
 * there, so no later page listener sees it. Every stored value then travels over that port, never
 * over `window`.
 *
 * Port messages are JSON strings, so Firefox's cross-world wrappers have no objects to wrap.
 */

/** The `type` of the one `window` message that hands the port over. */
export const BRIDGE_HANDOFF = 'caelestis:storage-bridge'

/** Isolated world to page world, once: every stored value. */
export interface StoredSnapshot {
  readonly values: Record<string, string>
}

/** Page world to isolated world: one write, `null` for a delete. */
export interface StoredWrite {
  readonly key: string
  readonly value: string | null
}
