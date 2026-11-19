import { uuidV7 } from '@caelestis/shared'
import { encodeBase64Url } from './base64url.js'
import { onServerRemoved } from './server-connections.js'
import { canonicalServerUrl } from './server-url.js'

/**
 * Who this browser is on a server's live sockets: an anonymous client id, and the credential a
 * socket carries. Shared by the live sync and presence sockets.
 */

// The backend and frontend hold their own copies of this prefix.
const LIVE_AUTH_PREFIX = 'caelestis.auth.b64.'
const LIVE_CLIENT_ID_KEY = 'caelestis.live-client-id.v1'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
    id = stored !== null && UUID_V7.test(stored) ? stored : uuidV7()
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

/** The bearer token as a WebSocket subprotocol, the only header a browser socket can carry. */
export const liveCredentialProtocol = (token: string): string =>
  `${LIVE_AUTH_PREFIX}${encodeBase64Url(token)}`
