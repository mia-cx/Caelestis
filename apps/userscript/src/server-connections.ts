import { mapLimit } from './concurrency.js'
import { log, warn } from './debug.js'
import {
  parseServerInfo,
  parseServerManifest,
  type ServerInfo,
  type ServerManifest,
} from './server-manifest.js'
import { sendServerRequest, withManifestReadSlot } from './server-transport.js'
import { canonicalServerUrl, endpointUrl, type ServerApiVersion } from './server-url.js'
import {
  getState,
  MAX_CONNECTED_SERVERS,
  type ServerConnection,
  type State,
  setState,
} from './settings.js'
import { serverRowPrefix, serverScopeKey, serverTemplateIdPrefix } from './tree-keys.js'

/**
 * The lifetime of each configured server connection: probing, refreshing, replacing and removing
 * the rows in `State.servers`.
 */

const SERVER_REFRESH_CONCURRENCY = 4
const SERVER_RETRY_MS = 5_000

/** A configured server whose probe verified it: its metadata and season are known. */
export type ConnectedServer = ServerConnection & {
  readonly status: 'connected'
  readonly info: ServerInfo
  readonly season: number
}

export const isConnected = (server: ServerConnection): server is ConnectedServer =>
  server.status === 'connected' && server.info !== null && server.season !== null

/** The configured servers that are connected now, in their configured order. */
export const connectedServers = (state: Pick<State, 'servers'> = getState()) =>
  state.servers.filter(isConnected)

/** The connected row configured at `url`, if there is one. */
export const connectedServerAt = (url: string): ConnectedServer | undefined => {
  const server = serverByUrl(url)
  return server !== undefined && isConnected(server) ? server : undefined
}

/** Whether two immutable state rows still describe the same remote connection lifetime. */
export const sameServerConnection = (left: ServerConnection, right: ServerConnection): boolean =>
  left.url === right.url &&
  left.token === right.token &&
  (left.tokenUsable !== false) === (right.tokenUsable !== false) &&
  left.status === right.status &&
  left.isAdmin === right.isAdmin &&
  left.season === right.season &&
  (left.info === null
    ? right.info === null
    : right.info !== null && left.info.id === right.info.id && left.info.auth === right.info.auth)

/**
 * Runtime identity for one configured connection lifetime.
 *
 * It is deliberately not persisted: removing a server and later probing the same URL starts a new
 * lifetime even when every wire value happens to be equal. Immutable replacements made while the
 * row remains configured inherit the token in {@link upsertServer}.
 */
const serverConnectionLifetimes = new WeakMap<ServerConnection, object>()
const serverConnectionControllers = new WeakMap<object, AbortController>()

const serverConnectionLifetime = (server: ServerConnection): object => {
  const existing = serverConnectionLifetimes.get(server)
  if (existing !== undefined) return existing
  const created = {}
  serverConnectionLifetimes.set(server, created)
  return created
}

/** Opaque owner for sharing reads without exposing credentials in a cache key. */
export const serverConnectionIdentity = (server: ServerConnection): object =>
  serverConnectionLifetime(server)

const lifetimeController = (lifetime: object): AbortController => {
  let controller = serverConnectionControllers.get(lifetime)
  if (controller === undefined) {
    controller = new AbortController()
    serverConnectionControllers.set(lifetime, controller)
  }
  return controller
}

export const serverConnectionSignal = (server: ServerConnection): AbortSignal =>
  lifetimeController(serverConnectionLifetime(server)).signal

const retireServerConnection = (server: ServerConnection): void => {
  const lifetime = serverConnectionLifetimes.get(server)
  if (lifetime === undefined) return
  lifetimeController(lifetime).abort(new Error('server connection retired'))
}

/** The saved token remains sealed in state; only a currently accepted token leaves in a request. */
export const activeServerToken = (server: ServerConnection): string | null =>
  server.tokenUsable === false ? null : server.token

/** The authorization header for `token`, if there is one. */
export const bearer = (token: string | null): Record<string, string> =>
  token === null ? {} : { authorization: `Bearer ${token}` }

/** The configured connection for `url`, if there is one. */
export const serverByUrl = (url: string): ServerConnection | undefined =>
  getState().servers.find((candidate) => candidate.url === url)

/** What a sentence calls a server: the name it reports, or its URL until it has reported one. */
export const serverLabel = (server: ServerConnection): string => server.info?.name ?? server.url

/** Whether this connection has a usable token whose admin scope the server has verified. */
export const hasServerAdminToken = (server: ServerConnection): boolean =>
  server.status === 'connected' && server.isAdmin && Boolean(activeServerToken(server))

/** Whether this immutable connection snapshot is still the configured lifetime for its URL. */
export const isCurrentServerConnection = (server: ServerConnection): boolean => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined) return false
  if (current === server) return true
  const lifetime = serverConnectionLifetimes.get(server)
  return lifetime !== undefined && serverConnectionLifetimes.get(current) === lifetime
}

/**
 * The manifest each probe downloaded to verify its credential, by server URL, until the connection
 * it produced adopts it through {@link takeProbedManifest}.
 */
const probedManifests = new Map<
  string,
  { readonly server: ServerConnection; readonly manifest: ServerManifest; readonly request: number }
>()

/** Hand over, once, the manifest the probe for this URL downloaded. */
export const takeProbedManifest = (serverUrl: string) => {
  const probed = probedManifests.get(serverUrl)
  probedManifests.delete(serverUrl)
  return probed
}

type RemovedListener = (url: string) => void | Promise<void>
const removedListeners = new Set<RemovedListener>()

/**
 * Run `listener` with the URL of each server the user disconnects, after its row is gone. Every
 * module that keeps state per server subscribes here, so nothing a connection left behind leaks
 * into the next connection to the same URL.
 */
export const onServerRemoved = (listener: RemovedListener): (() => void) => {
  removedListeners.add(listener)
  return () => removedListeners.delete(listener)
}

/** A stored switch or preference key that belongs to the server at `url` and nothing else. */
const ownedByServer = (key: string, url: string): boolean => {
  const singleSegmentAfter = (prefix: string): boolean =>
    key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(':')
  return (
    key === serverScopeKey(url) ||
    singleSegmentAfter(serverRowPrefix('node', url)) ||
    singleSegmentAfter(serverTemplateIdPrefix(url)) ||
    // Template switches written before server template ids were `srv:` keys.
    singleSegmentAfter(serverRowPrefix('st', url))
  )
}

/**
 * Replace one server in place, keyed by url, preserving its saved token and the order of the rest.
 * A row identical to the stored one changes nothing and notifies no listener.
 */
export const upsertServer = (server: ServerConnection): boolean => {
  const servers = getState().servers
  const index = servers.findIndex((s) => s.url === server.url)
  if (index === -1 && servers.length >= MAX_CONNECTED_SERVERS) {
    // No connection will adopt the refused probe's manifest.
    if (probedManifests.get(server.url)?.server === server) probedManifests.delete(server.url)
    return false
  }
  const current = index === -1 ? undefined : servers[index]
  // A probe may decide to continue anonymously, but only an explicit disconnect may erase the
  // credential stored for this URL. A non-empty replacement still lets the user rotate the token.
  const candidate =
    current !== undefined && current.token !== null && server.token === null
      ? { ...server, token: current.token, tokenUsable: false }
      : server
  const canRetainIdentity =
    candidate.lastVerified == null &&
    current?.lastVerified != null &&
    (candidate.info === null || candidate.info.id === current.lastVerified.serverId)
  const next = canRetainIdentity ? { ...candidate, lastVerified: current.lastVerified } : candidate
  const retainsLifetime = current !== undefined && sameServerConnection(current, candidate)
  if (current !== undefined && !retainsLifetime) retireServerConnection(current)
  const lifetime = retainsLifetime ? serverConnectionLifetime(current) : {}
  serverConnectionLifetimes.set(server, lifetime)
  serverConnectionLifetimes.set(candidate, lifetime)
  serverConnectionLifetimes.set(next, lifetime)
  // An offline row is re-probed every few seconds with the same answer. Writing it again would
  // wake every state listener, so an identical stored row is not a change.
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return true
  setState({
    servers: index === -1 ? [...servers, next] : servers.map((s, i) => (i === index ? next : s)),
  })
  return true
}

/**
 * Disconnect the server at `url`: end its connection lifetime, which aborts its requests, drop its
 * row and the switches and preferences that can only refer to it, then let every per-server cache
 * forget it. Settles once they all have.
 */
export const removeServer = async (url: string): Promise<void> => {
  cancelServerProbe(url)
  probedManifests.delete(url)
  const current = getState().servers.find((server) => server.url === url)
  if (current !== undefined) retireServerConnection(current)
  const state = getState()
  const templatePrefix = serverTemplateIdPrefix(url)
  setState({
    servers: state.servers.filter((s) => s.url !== url),
    customOrder: state.customOrder.filter((candidate) => candidate !== serverScopeKey(url)),
    serverTemplatePreferences: state.serverTemplatePreferences.filter(
      (preference) => !preference.id.startsWith(templatePrefix),
    ),
    hiddenScopes: state.hiddenScopes.filter((key) => !ownedByServer(key, url)),
  })
  const settled = await Promise.allSettled(
    [...removedListeners].map(async (listener) => listener(url)),
  )
  for (const outcome of settled)
    if (outcome.status === 'rejected')
      warn('install', 'server removal observer failed', String(outcome.reason))
}

/**
 * Mark a connection whose credential an admin route refused: 401 means the token expired, 403 that
 * it lacks admin scope.
 */
export const noteAuthFailure = (server: ServerConnection, status: number): void => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(server)) return
  const needsToken = status === 401
  upsertServer({
    ...current,
    status: needsToken ? 'needs-token' : 'connected',
    error: needsToken ? 'authorization expired' : 'admin access required',
    isAdmin: false,
  })
}

/** Establish admin scope without downloading the same tree a second time after the manifest. */
const probeAdminScope = async (
  base: string,
  apiVersion: ServerApiVersion,
  token: string | null,
  season: number,
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    // The status is the whole answer, so the body is thrown away unread. Parsing it measured the
    // full folder tree against the 64 KB cap meant for a one-line mutation reply, and any server
    // with a real tree therefore reported that our token could only read it.
    const { response } = await sendServerRequest(
      endpointUrl(base, `/admin/nodes?season=${season}`, apiVersion),
      { headers: bearer(token), signal },
      { limits: 'tree', read: 'discard' },
    )
    return response.ok
  } catch {
    return false
  }
}

const activeServerProbes = new Map<string, AbortController>()

export const cancelServerProbe = (serverUrl: string): void => {
  activeServerProbes.get(serverUrl)?.abort(new Error('server probe cancelled'))
  activeServerProbes.delete(serverUrl)
}

/**
 * Ask a server who it is.
 *
 * `GET /server` is deliberately public and always answers, so a client can learn whether a token is
 * needed *before* asking anyone for one. Asking for a code up front is the likeliest way to lose
 * someone on first run — most servers will not want one.
 */
export const probeServer = async (
  url: string,
  token: string | null,
  options: { readonly supersedeActive?: boolean } = {},
): Promise<ServerConnection> => {
  let base: string
  try {
    base = canonicalServerUrl(url)
  } catch (error) {
    return {
      url: url.trim(),
      info: null,
      token,
      status: 'unreachable',
      error: String(error),
      isAdmin: false,
      season: null,
    }
  }
  const activeProbe = activeServerProbes.get(base)
  if (activeProbe !== undefined && options.supersedeActive === false) {
    return {
      url: base,
      info: null,
      token,
      status: 'unreachable',
      error: 'superseded by an active foreground server probe',
      isAdmin: false,
      season: null,
      superseded: true,
    }
  }
  activeProbe?.abort(new Error('superseded by a newer server probe'))
  const probeController = new AbortController()
  activeServerProbes.set(base, probeController)
  let observedInfo: ServerInfo | null = null
  try {
    const signal = probeController.signal
    const readMetadata = (version: ServerApiVersion) =>
      sendServerRequest(
        endpointUrl(base, '/server', version),
        { headers: bearer(token), signal },
        { limits: 'metadata', read: 'json' },
      )
    let apiVersion: ServerApiVersion = 'v1'
    let metadata = await readMetadata(apiVersion)
    // Servers that predate the `/v1` prefix answer only at the bare path.
    if (metadata.response.status === 404) {
      apiVersion = 'legacy'
      metadata = await readMetadata(apiVersion)
    }
    const { response, body } = metadata
    if (!response.ok) {
      return {
        url: base,
        info: null,
        token,
        status: 'unreachable',
        error: `HTTP ${response.status}`,
        isAdmin: false,
        season: null,
      }
    }
    const info = parseServerInfo(body)
    if (info === null) throw new TypeError('server returned invalid metadata')
    observedInfo = info
    log('install', `probed ${base}`, { name: info.name, auth: info.auth })
    const version = apiVersion === 'legacy' ? { apiVersion } : {}

    if (info.auth === 'access_token' && token === null) {
      return {
        url: base,
        info,
        token: null,
        status: 'needs-token',
        isAdmin: false,
        season: null,
        ...version,
      }
    }

    // `GET /server` is public and never looks at the Authorization header, so reaching it proves
    // nothing about a code. Without this second call any non-empty string read as "connected" and
    // every later request failed with 401 — caught by typing a deliberately wrong code.
    const fetchManifest = (credential: string | null) =>
      withManifestReadSlot(
        signal,
        () => true,
        async (sequence) => ({
          ...(await sendServerRequest(
            endpointUrl(base, '/manifest', apiVersion),
            { headers: bearer(credential), signal },
            { limits: 'tree', read: 'json' },
          )),
          sequence,
        }),
      )
    let effectiveToken = token
    let {
      response: authed,
      body: manifestBody,
      sequence: manifestRequest,
    } = await fetchManifest(effectiveToken)
    if (
      info.auth === 'none' &&
      effectiveToken !== null &&
      (authed.status === 401 || authed.status === 403)
    ) {
      log('install', `${base} rejected the stored code; retrying open access`)
      effectiveToken = null
      const anonymous = await fetchManifest(null)
      authed = anonymous.response
      manifestBody = anonymous.body
      manifestRequest = anonymous.sequence
    }
    if (authed.status === 401 || authed.status === 403) {
      log('install', `${base} rejected the code`, { status: authed.status })
      return {
        url: base,
        info,
        token,
        status: 'needs-token',
        error: 'rejected',
        isAdmin: false,
        season: null,
        ...version,
      }
    }
    if (!authed.ok) {
      return {
        url: base,
        info,
        token,
        status: 'unreachable',
        error: `HTTP ${authed.status}`,
        isAdmin: false,
        season: null,
      }
    }
    const manifest = parseServerManifest(manifestBody, info)
    if (manifest === null) throw new TypeError('server returned an invalid manifest')
    const isAdmin = await probeAdminScope(base, apiVersion, effectiveToken, manifest.season, signal)
    if (signal.aborted) throw signal.reason
    const connected: ConnectedServer = {
      url: base,
      info,
      token,
      ...(effectiveToken === null && token !== null ? { tokenUsable: false as const } : {}),
      status: 'connected',
      isAdmin,
      season: manifest.season,
      lastVerified: { serverId: info.id, season: manifest.season },
      ...version,
    }
    probedManifests.set(base, { server: connected, manifest, request: manifestRequest })
    return connected
  } catch (error) {
    // A bad hostname, a refused connection, or a server without CORS all land here, and the
    // distinction is not visible to us — the browser withholds it deliberately.
    return {
      url: base,
      info: observedInfo,
      token,
      status: 'unreachable',
      error: String(error),
      isAdmin: false,
      season: null,
      ...(probeController.signal.aborted ? { superseded: true as const } : {}),
    }
  } finally {
    if (activeServerProbes.get(base) === probeController) activeServerProbes.delete(base)
  }
}

/** Probe each row and apply the answer; `onRefreshed` learns whether that changed the stored row. */
const refreshServers = async (
  snapshot: readonly ServerConnection[],
  onRefreshed?: (changed: boolean) => void,
): Promise<void> => {
  await mapLimit(snapshot, SERVER_REFRESH_CONCURRENCY, async (server) => {
    if (!isCurrentServerConnection(server)) return
    const refreshed = await probeServer(server.url, server.token, { supersedeActive: false })
    if (refreshed.superseded === true) return
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current === undefined || !isCurrentServerConnection(server)) return
    // A cosmetic replacement can land while the probe is in flight. Preserve that newer local
    // metadata while still applying the probe's current connectivity, season, and scope result.
    const before = getState().servers
    upsertServer(current === server ? refreshed : { ...refreshed, info: current.info })
    try {
      onRefreshed?.(getState().servers !== before)
    } catch (error) {
      warn('install', 'server refresh observer failed', String(error))
    }
  })
}

/** Revalidate persisted identity, auth and scope without allowing stale requests to resurrect rows. */
export const refreshStoredServers = async (onRefreshed?: () => void): Promise<void> =>
  refreshServers([...getState().servers], onRefreshed)

let serverRetryTimer: ReturnType<typeof setInterval> | null = null

/** Keep offline rows alive through short server restarts, reusing their persisted credentials. */
export const installServerConnectionRetry = (onRefreshed?: () => void): void => {
  if (serverRetryTimer !== null) clearInterval(serverRetryTimer)
  serverRetryTimer = setInterval(() => {
    const unreachable = getState().servers.filter((server) => server.status === 'unreachable')
    // A server that is still offline gives the same answer, which needs no redraw.
    if (unreachable.length > 0)
      void refreshServers(unreachable, (changed) => {
        if (changed) onRefreshed?.()
      })
  }, SERVER_RETRY_MS)
}
