import { canonicalServerUrl } from './server-url.js'
import { type ConnectedServer, MAX_CONNECTED_SERVERS } from './state.js'

export interface Invite {
  readonly serverUrl: string
  readonly token: string
}

/**
 * Decoded invite payload of a Wplace fragment: `#<server-base64url>.<token-base64url>`, unpadded
 * base64url (RFC 4648 §5) of UTF-8 bytes. The link carries the token, so it is shared like one.
 */
export const encodeInvite = (serverUrl: string, token: string): string => {
  const canonical = canonicalServerUrl(serverUrl)
  const encode = (value: string): string => {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  }
  return `${encode(canonical)}.${encode(token)}`
}

/**
 * A fragment only counts as an invite candidate when it starts with `aHR0c` — the base64url prefix
 * every `http://` or `https://` URL shares — followed by one or more dot-separated base64url
 * segments. Wplace's own fragments never look like that, so they are ignored deterministically.
 */
const INVITE_CANDIDATE = /^aHR0c[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)+$/

const decodePart = (part: string): string | null => {
  // Unpadded input only: a length of 1 mod 4 can never decode.
  if (part.length % 4 === 1) return null
  let binary: string
  try {
    binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'))
  } catch {
    return null
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

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
  const serverRaw = decodePart(parts[0] ?? '')
  const token = decodePart(parts[1] ?? '')
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

export interface InviteDeps {
  /** The fragment to read, usually `location.hash`. */
  readonly hash: string
  /** Drop the fragment from the address bar without reloading or firing `hashchange`. */
  readonly clearHash: () => void
  readonly servers: () => readonly ConnectedServer[]
  readonly probe: (url: string, token: string) => Promise<ConnectedServer>
  readonly upsert: (server: ConnectedServer) => boolean
  /** Post-upsert side effects; `replacing` is true when an existing server's token rotated. */
  readonly connected: (server: ConnectedServer, replacing: boolean) => void
  readonly notify: (message: string, tone: 'info' | 'error') => void
  /** True while that URL is mid connect or disconnect, so an invite must not interleave. */
  readonly isBusy: (url: string) => boolean
}

const displayName = (server: ConnectedServer, fallback: string): string =>
  server.info?.name ?? fallback

let inviteInFlight = false

/**
 * Consume an invite fragment: validate it, clear it from the address bar, and connect.
 *
 * The hash is cleared before any network call so the token leaves the address bar even when the
 * probe fails. A second invite arriving while one is in flight is ignored. No message, log line or
 * thrown error may contain the token or the raw fragment — probes carry the token in a header, so
 * their `error` strings describe statuses and URLs, never credentials; only canonical URLs and
 * server names reach notifications.
 */
export const consumeInvite = async (deps: InviteDeps): Promise<void> => {
  const invite = readInvite(deps.hash)
  if (invite === null) return
  deps.clearHash()
  if (invite === 'malformed') {
    deps.notify("That invite link isn't valid.", 'error')
    return
  }
  if (inviteInFlight || deps.isBusy(invite.serverUrl)) {
    deps.notify(
      `Still connecting to ${invite.serverUrl}. Open the invite again in a moment.`,
      'error',
    )
    return
  }
  const existing = deps.servers().find((server) => server.url === invite.serverUrl)
  if (
    existing !== undefined &&
    existing.token === invite.token &&
    existing.status === 'connected'
  ) {
    deps.notify(`Already connected to ${displayName(existing, invite.serverUrl)}.`, 'info')
    return
  }
  inviteInFlight = true
  try {
    const probed = await deps.probe(invite.serverUrl, invite.token)
    if (probed.superseded === true) return
    if (probed.status === 'connected') {
      if (!deps.upsert(probed)) {
        deps.notify(
          `Already connected to ${MAX_CONNECTED_SERVERS} servers. Disconnect one first.`,
          'error',
        )
        return
      }
      deps.connected(probed, existing !== undefined)
      deps.notify(`Connected to ${displayName(probed, invite.serverUrl)}.`, 'info')
      return
    }
    // An existing server keeps its stored credentials on either failure: the invite only ever
    // proves the token it carried, never that the old one stopped working.
    deps.notify(
      probed.status === 'needs-token'
        ? `${invite.serverUrl} didn't accept the invite's token.`
        : `Could not reach ${invite.serverUrl}.`,
      'error',
    )
  } finally {
    inviteInFlight = false
  }
}
