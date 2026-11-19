import { canonicalServerUrl, isUuidV7, uuidV7 } from '@caelestis/shared'
import { onServerRemoved } from './server-connections.js'

/**
 * Who this browser is on a server's live sockets: an anonymous client id, kept per server. The
 * credential a socket carries is `liveCredentialProtocol` in `@caelestis/shared`.
 */

const LIVE_CLIENT_ID_KEY = 'caelestis.live-client-id.v1'

const cachedLiveClientIds = new Map<string, string>()

const storageKeyFor = (serverKey: string): string => `${LIVE_CLIENT_ID_KEY}:${serverKey}`

/**
 * Stable, non-secret browser identity scoped to one anonymous server, for as long as the server
 * stays connected.
 */
export const liveClientId = (serverUrl: string): string => {
  const serverKey = canonicalServerUrl(serverUrl)
  const cached = cachedLiveClientIds.get(serverKey)
  if (cached !== undefined) return cached
  const storageKey = storageKeyFor(serverKey)
  let id: string
  try {
    const stored = localStorage.getItem(storageKey)
    id = stored !== null && isUuidV7(stored) ? stored : uuidV7()
    if (id !== stored) localStorage.setItem(storageKey, id)
  } catch {
    // Storage can be blocked for the page; the id then lasts as long as this page does.
    id = uuidV7()
  }
  cachedLiveClientIds.set(serverKey, id)
  return id
}

// Rows are stored under their canonical URL. The stored id is page-readable, so it goes too.
onServerRemoved((serverUrl) => {
  cachedLiveClientIds.delete(serverUrl)
  try {
    localStorage.removeItem(storageKeyFor(serverUrl))
  } catch {
    // Storage blocked for the page held no id to remove.
  }
})
