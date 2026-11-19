import { canonicalServerUrl } from '@caelestis/shared'
import { decodeBase64Url, encodeBase64Url } from './base64url.js'
import { type ConnectOutcome, connectServer } from './server-connections.js'

export interface Invite {
  readonly serverUrl: string
  readonly token: string
}

/**
 * Decoded invite payload of a Wplace fragment: `#<server-base64url>.<token-base64url>`, unpadded
 * base64url (RFC 4648 §5) of UTF-8 bytes. The link carries the token, so it is shared like one.
 */
export const encodeInvite = (serverUrl: string, token: string): string => {
  return `${encodeBase64Url(canonicalServerUrl(serverUrl))}.${encodeBase64Url(token)}`
}

/**
 * A fragment only counts as an invite candidate when it starts with `aHR0c` — the base64url prefix
 * every `http://` or `https://` URL shares — followed by one or more dot-separated base64url
 * segments. Wplace's own fragments never look like that, so they are ignored deterministically.
 */
const INVITE_CANDIDATE = /^aHR0c[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)+$/

const tokenUsable = (token: string): boolean => {
  if (token === '') return false
  for (const char of token) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || /\s/u.test(char)) return false
  }
  return true
}

/**
 * Read an invite out of `location.hash`.
 *
 * Returns `null` for any fragment that is not an invite at all — the caller must leave those
 * alone — and `'malformed'` for one that is clearly meant as an invite but cannot be used.
 */
export const readInvite = (hash: string): Invite | 'malformed' | null => {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!INVITE_CANDIDATE.test(fragment)) return null
  const parts = fragment.split('.')
  if (parts.length !== 2) return 'malformed'
  const serverRaw = decodeBase64Url(parts[0] ?? '')
  const token = decodeBase64Url(parts[1] ?? '')
  if (serverRaw === null || token === null) return 'malformed'
  let serverUrl: string
  try {
    serverUrl = canonicalServerUrl(serverRaw)
  } catch {
    return 'malformed'
  }
  if (!tokenUsable(token)) return 'malformed'
  return { serverUrl, token }
}

let inviteInFlight = false

/**
 * Consume an invite fragment: validate it, clear it from the address bar, and connect with
 * {@link connectServer}. `null` means `hash` is not an invite and was left alone.
 *
 * The hash is cleared before any network call so the token leaves the address bar even when the
 * probe fails. A second invite arriving while one is in flight is `busy`. An existing server keeps
 * its stored credentials when the invite's token fails: the invite only ever proves the token it
 * carried, never that the old one stopped working. Nothing returned contains the token or the raw
 * fragment: probes carry the token in a header, so their `error` strings describe statuses and
 * URLs, never credentials.
 */
export const consumeInvite = async (
  hash: string,
  clearHash: () => void,
): Promise<ConnectOutcome | { readonly kind: 'malformed' } | null> => {
  const invite = readInvite(hash)
  if (invite === null) return null
  clearHash()
  if (invite === 'malformed') return { kind: 'malformed' }
  if (inviteInFlight) return { kind: 'busy', url: invite.serverUrl, disconnecting: false }
  inviteInFlight = true
  try {
    return await connectServer(invite.serverUrl, invite.token, { requireToken: true })
  } finally {
    inviteInFlight = false
  }
}
