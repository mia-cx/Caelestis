import { type AccessToken, type AccessTokenPage, listAccessTokens } from '../server-api.js'
import {
  isCurrentServerConnection,
  onServerRemoved,
  sameServerConnection,
} from '../server-connections.js'
import type { ServerConnection } from '../settings.js'

/**
 * What each server last said about its access tokens, so opening a row twice does not make it jump
 * twice.
 *
 * The panel renders synchronously and the tokens arrive over the network, so the first paint of the
 * list can only be a placeholder — and a placeholder that is a different height from the list
 * replacing it moves everything below it a moment after you looked at it. Remembering the answer
 * makes that happen once per server per session rather than once per expand.
 *
 * Held in memory only. These are the labels of a server's keys, and they are cheap to re-ask for;
 * writing them to disk would mean the answer outliving the admin rights that were allowed to see it.
 */
export interface TokenInventory {
  readonly server: ServerConnection
  /** Every page read so far, joined newest first. */
  readonly cached: AccessTokenPage | undefined
}

interface InventoryState extends TokenInventory {
  cached: AccessTokenPage | undefined
  readonly inFlight: Map<string | null, Promise<AccessTokenPage | null>>
  generation: number
}

const newInventory = (server: ServerConnection): InventoryState => ({
  server,
  cached: undefined,
  inFlight: new Map(),
  generation: 0,
})

const inventories = new Map<string, InventoryState>()

const inventoryState = (server: ServerConnection): InventoryState => {
  const current = inventories.get(server.url)
  // A stale detached caller must neither inherit nor replace cache state for a reconnected row.
  if (!isCurrentServerConnection(server)) return newInventory(server)
  if (
    current !== undefined &&
    isCurrentServerConnection(current.server) &&
    sameServerConnection(current.server, server)
  )
    return current
  const replacement = newInventory(server)
  inventories.set(server.url, replacement)
  return replacement
}

/**
 * The server's inventory. A disconnect or reconnect replaces it, so a caller holding one can tell
 * whether a late answer still belongs to the row on screen with `isCurrentInventory`.
 */
export const tokenInventory = (server: ServerConnection): TokenInventory => inventoryState(server)

export const isCurrentInventory = (inventory: TokenInventory): boolean =>
  inventories.get(inventory.server.url) === inventory

const cursorParts = (cursor: string): { createdAt: number; tokenHash: string } => {
  const split = cursor.indexOf(':')
  return { createdAt: Number(cursor.slice(0, split)), tokenHash: cursor.slice(split + 1) }
}

/** Whether next is strictly later in the backend's newest-first keyset order. */
const cursorAdvances = (cursor: string, next: string): boolean => {
  const previous = cursorParts(cursor)
  const following = cursorParts(next)
  return (
    following.createdAt < previous.createdAt ||
    (following.createdAt === previous.createdAt && following.tokenHash > previous.tokenHash)
  )
}

/** A token's identity in the list: the bootstrap token has no hash of its own. */
export const tokenKey = (token: AccessToken): string =>
  token.bootstrap === true ? 'bootstrap' : token.tokenHash

/**
 * Read the first page (`cursor` null) or the page after `cursor`, joined onto the cache. Resolves
 * null when the read failed or no longer belongs to the cache; `supersede` re-asks even while the
 * same read is in flight, for after a mutation.
 */
export const fetchTokens = (
  server: ServerConnection,
  cursor: string | null = null,
  supersede = false,
): Promise<AccessTokenPage | null> => {
  const state = inventoryState(server)
  // A cached page can expose Load more while its first page is refreshing in the background. Wait
  // for that refresh before following the cached cursor: otherwise the later page can land first and
  // then be erased when the older first-page response replaces the cache.
  const refreshing = state.inFlight.get(null)
  if (cursor !== null && refreshing !== undefined) {
    return refreshing.then(() => {
      if (inventories.get(server.url) !== state) return null
      if (state.cached?.nextCursor !== cursor) return state.cached ?? null
      return fetchTokens(server, cursor)
    })
  }
  const running = state.inFlight.get(cursor)
  if (running !== undefined && !supersede) return running
  const generation = cursor === null ? state.generation + 1 : state.generation
  if (cursor === null) state.generation = generation
  const run: Promise<AccessTokenPage | null> = listAccessTokens(server, cursor).then((page) => {
    // Only while this is still the request the map is holding. Forgetting a disconnected server
    // removes the entry, and a reply landing after that must not put its labels back.
    if (inventories.get(server.url) !== state) return null
    const current = state.inFlight.get(cursor)
    // A superseded caller should observe the replacement request, including while it is still in
    // flight. Returning its own failure would make an obsolete callback report an error after the
    // replacement succeeded (or while it was about to succeed).
    if (current !== run) return current ?? state.cached ?? null
    // A first-page refresh supersedes every later page already in flight, even when a mutation did
    // not happen to change the first page's cursor. Its response came from the older inventory.
    if (state.generation !== generation) return state.inFlight.get(null) ?? state.cached ?? null
    if (page === null) return null
    if (cursor === null) {
      state.cached = page
      return page
    }
    const previous = state.cached
    if (previous?.nextCursor !== cursor) return previous ?? null
    if (
      page.nextCursor !== null &&
      (page.tokens.length === 0 || !cursorAdvances(cursor, page.nextCursor))
    )
      return null
    const known = new Set(previous.tokens.map(tokenKey))
    const combined = {
      tokens: [...previous.tokens, ...page.tokens.filter((token) => !known.has(tokenKey(token)))],
      nextCursor: page.nextCursor,
    }
    state.cached = combined
    return combined
  })
  void run.finally(() => {
    if (inventories.get(server.url) !== state || state.inFlight.get(cursor) !== run) return
    state.inFlight.delete(cursor)
  })
  state.inFlight.set(cursor, run)
  return run
}

// A disconnected server's token labels go, and the in-flight request with them. A server row
// prefetches its tokens on hover, so a request is usually already running when the user
// disconnects, and clearing only the cache let that reply write the labels straight back in
// afterwards — past the point where we still have any right to hold them.
onServerRemoved((serverUrl) => {
  inventories.delete(serverUrl)
})

/**
 * Ask before anyone opens the row, so the list is already there when they do.
 *
 * Called from the server row on hover. A pointer arriving at a row is the earliest honest signal
 * that someone is about to open it, and the request costs one GET that would have happened a moment
 * later anyway. Nothing is drawn from this; it only warms the cache above.
 */
export const prefetchAccessTokens = (server: ServerConnection): void => {
  if (!server.isAdmin || inventoryState(server).cached !== undefined) return
  void fetchTokens(server)
}
