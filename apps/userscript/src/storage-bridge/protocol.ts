/**
 * The storage bridge, between Caelestis in the page world and the world that holds its storage.
 *
 * Only the page world can hook Wplace, and only another world can keep values Wplace's scripts
 * cannot read: the extension's isolated world reaches `chrome.storage.local`, and the userscript
 * manager's world reaches `GM_*` storage. At document start, before any Wplace script exists, the
 * page-world script posts one `window` message carrying a `MessagePort`; the storage world takes
 * the port and stops the event there, so no later page listener sees it. A page-world script that
 * lost the page to the other build posts the same message without a port, which closes its bridge
 * for good. The message names its build, so with both installed each bridge takes only its own.
 * Every stored value travels over the port, never over `window`, and nothing is kept in
 * page-readable storage.
 *
 * That is the boundary: Wplace's scripts cannot read Caelestis's storage or join the bridge. Values
 * Caelestis uses in the page world, such as a token on a request, are as observable to page code
 * that runs later as anything else in the page.
 *
 * Port messages are JSON strings, so Firefox's cross-world wrappers have no objects to wrap.
 */

/** The `type` of the one `window` message that hands the port over. */
export const BRIDGE_HANDOFF = 'caelestis:storage-bridge'

/** Storage world to page world. `null` stands for a deleted value. */
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

/** Page world to storage world, handled in order. */
export type PageMessage =
  | { readonly type: 'write'; readonly key: string; readonly value: string | null }
  | { readonly type: 'sync'; readonly id: number }
  /**
   * A key the page read and does not have. A store that reports changes per key, such as the
   * userscript manager's, starts reporting this one, as `changes`, including any value it now has.
   */
  | { readonly type: 'watch'; readonly key: string }
