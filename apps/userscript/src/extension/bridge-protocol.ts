/**
 * The extension's storage bridge, between its page-world script and its isolated-world script.
 *
 * Only the isolated world can reach `chrome.storage.local`, and only the page world can hook
 * Wplace. At document start, before any Wplace script exists, the page-world script posts one
 * `window` message carrying a `MessagePort`; the isolated world takes the port and stops the event
 * there, so no later page listener sees it. The page-world script connects on every load, whether
 * it runs Caelestis or only serves its storage to the userscript, and the bridge stops listening
 * after that first message. Every stored value travels over the port, never over `window`, and
 * nothing is kept in page-readable storage.
 *
 * That is the boundary: Wplace's scripts cannot read Caelestis's storage or join the bridge. Values
 * Caelestis uses in the page world, such as a token on a request, are as observable to page code
 * that runs later as they are in the userscript.
 *
 * Port messages are JSON strings, so Firefox's cross-world wrappers have no objects to wrap.
 */

/** The `type` of the one `window` message that hands the port over. */
export const BRIDGE_HANDOFF = 'caelestis:storage-bridge'

/** Isolated world to page world. `null` stands for a deleted value. */
export type BridgeMessage =
  /** Once, first: every stored value. */
  | { readonly type: 'snapshot'; readonly values: Record<string, string> }
  /** Each change made elsewhere: the toolbar popup, another tab. The page skips values it holds. */
  | { readonly type: 'changes'; readonly changes: Record<string, string | null> }
  /**
   * The answer to a `sync`: every stored value, read after all earlier writes were stored. `null`
   * when storage could not be read or an earlier write failed, so the sync fails rather than
   * passing for empty storage.
   */
  | {
      readonly type: 'synced'
      readonly id: number
      readonly values: Record<string, string> | null
    }

/** Page world to isolated world, handled in order. */
export type PageMessage =
  | { readonly type: 'write'; readonly key: string; readonly value: string | null }
  | { readonly type: 'sync'; readonly id: number }
