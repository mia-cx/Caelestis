/**
 * How a client reaches a Caelestis server: the URL rules, retry rule, live credential encoding and
 * tile hash naming that the frontend, userscript and backend must agree on.
 */

/** The conventional backend mount under an origin-only server address. */
export const BACKEND_MOUNT = '/backend'

/**
 * The versioned API under a server's base URL. Servers that predate it answer 404 there, and
 * clients fall back to the unversioned root.
 */
export const API_VERSION_PATH = '/v1'

/** A server's identity: an HTTP(S) URL without credentials, query, fragment or trailing slash. */
export const canonicalServerUrl = (value: string): string => {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('server URL must use HTTP or HTTPS')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('server URL must not contain credentials')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * The base URL that API paths append to. An origin-only address uses the conventional backend
 * mount; a path supplied by the operator is already the base, so self-hosted deployments can mount
 * the backend wherever their host layout requires.
 */
export const resolveServerUrl = (value: string): string => {
  const canonical = canonicalServerUrl(value)
  return new URL(canonical).pathname === '/' ? `${canonical}${BACKEND_MOUNT}` : canonical
}

/** A response worth one retry of an idempotent request: a timeout, rate limit or server failure. */
export const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

/** Live sockets carry the bearer token as a subprotocol, the only header a browser socket can set. */
export const LIVE_AUTH_PREFIX = 'caelestis.auth.b64.'

export const liveCredentialProtocol = (token: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(token)) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${LIVE_AUTH_PREFIX}${encoded}`
}

/** The token a `liveCredentialProtocol` carries, or null when it is not one. */
export const parseLiveCredentialProtocol = (protocol: string): string | null => {
  if (!protocol.startsWith(LIVE_AUTH_PREFIX)) return null
  const encoded = protocol.slice(LIVE_AUTH_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const token = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return token.length === 0 ? null : token
  } catch {
    return null
  }
}

const ARCHIVE_TILE_PREFIX = 'archive:'

/** Names an archived tile image so it shares one hash space with live tile captures. */
export const archiveTileHash = (hash: string): string => `${ARCHIVE_TILE_PREFIX}${hash}`

/** The API path, without a leading slash, that serves a live or archived tile image by hash. */
export const tileImagePath = (hash: string): string =>
  hash.startsWith(ARCHIVE_TILE_PREFIX)
    ? `archive/tiles/${hash.slice(ARCHIVE_TILE_PREFIX.length)}`
    : `tiles/${hash}`
