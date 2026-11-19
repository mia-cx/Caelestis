import { mapLimit } from './concurrency.js'
import { log, warn } from './debug.js'
import { notifyListeners } from './listeners.js'
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

/** Opaque owner of one connection lifetime, for sharing reads without credentials in a cache key. */
export const serverConnectionIdentity = (server: ServerConnection): object => {
  const existing = serverConnectionLifetimes.get(server)
  if (existing !== undefined) return existing
  const created = {}
  serverConnectionLifetimes.set(server, created)
  return created
}

const lifetimeController = (lifetime: object): AbortController => {
  let controller = serverConnectionControllers.get(lifetime)
  if (controller === undefined) {
    controller = new AbortController()
    serverConnectionControllers.set(lifetime, controller)
  }
  return controller
}

export const serverConnectionSignal = (server: ServerConnection): AbortSignal =>
  lifetimeController(serverConnectionIdentity(server)).signal

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
  const current = serverByUrl(server.url)
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

/**
 * Hand over, once, the manifest the probe for this URL downloaded, as soon as the connection that
 * probe produced is the configured one.
 */
export const takeProbedManifest = (serverUrl: string) => {
  const probed = probedManifests.get(serverUrl)
  if (probed === undefined || !isCurrentServerConnection(probed.server)) return undefined
  probedManifests.delete(serverUrl)
  return probed
}

type RemovingListener = (server: ServerConnection) => void | Promise<void>
type RemovedListener = (url: string) => void | Promise<void>
const removingListeners = new Set<RemovingListener>()
const removedListeners = new Set<RemovedListener>()
const connectedListeners = new Set<(server: ServerConnection) => void>()

/**
 * Run `listener` with each server the user disconnects while its row and credential still exist.
 * The row stays until every listener settles, so this is where a server is told goodbye.
 */
export const onServerRemoving = (listener: RemovingListener): void => {
  removingListeners.add(listener)
}

/**
 * Run `listener` with the URL of each server the user disconnects, after its row is gone. Every
 * module that keeps state per server subscribes here, so nothing a connection left behind leaks
 * into the next connection to the same URL.
 */
export const onServerRemoved = (listener: RemovedListener): void => {
  removedListeners.add(listener)
}

/**
 * Run `listener` with each row {@link connectServer} stores: a server added, its token replaced, or
 * an invite accepted. Re-probes of a stored row are not connects.
 */
export const onServerConnected = (listener: (server: ServerConnection) => void): void => {
  connectedListeners.add(listener)
}

/** Call every listener with `value` and wait for all of them; a failure is reported, not thrown. */
const settleEach = async <T>(
  listeners: Iterable<(value: T) => void | Promise<void>>,
  value: T,
  failure: string,
): Promise<void> => {
  const settled = await Promise.allSettled([...listeners].map(async (listener) => listener(value)))
  for (const outcome of settled)
    if (outcome.status === 'rejected') warn(failure, String(outcome.reason))
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
  const lifetime = retainsLifetime ? serverConnectionIdentity(current) : {}
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

/** URLs a connect or a disconnect is working on; another must wait for it. */
const connecting = new Set<string>()
const removing = new Set<string>()

/**
 * Disconnect the server at `url`: say goodbye while its credential still exists, end its connection
 * lifetime, which aborts its requests, drop its row and the switches and preferences that can only
 * refer to it, then let every per-server cache forget it. Settles once they all have; a second call
 * while one is running does nothing.
 */
export const removeServer = async (url: string): Promise<void> => {
  if (removing.has(url)) return
  removing.add(url)
  try {
    const leaving = serverByUrl(url)
    // With nobody to say goodbye, the row goes in this same task.
    if (leaving !== undefined && removingListeners.size > 0)
      await settleEach(removingListeners, leaving, 'server removal observer failed')
    cancelServerProbe(url)
    probedManifests.delete(url)
    const current = serverByUrl(url)
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
    await settleEach(removedListeners, url, 'server removal observer failed')
  } finally {
    removing.delete(url)
  }
}

/** What {@link connectServer} came to. */
export type ConnectOutcome =
  | {
      /** `connected` stored `server`; `already` found it stored and changed nothing. */
      readonly kind: 'connected' | 'already' | 'refused' | 'unreachable'
      readonly server: ServerConnection
    }
  | { readonly kind: 'busy'; readonly url: string; readonly disconnecting: boolean }
  | { readonly kind: 'full' | 'superseded' }

/**
 * Connect the server at `url` with `token`: probe it, store the row, and tell every
 * {@link onServerConnected} listener. Adding, replacing a token and accepting an invite all come
 * through here.
 *
 * Without a token an address already configured is `already` connected, and a server that asks for
 * one is stored so its row can ask. With a token only a verified connection is stored, and a refused
 * token leaves the stored row and its credential alone. `requireToken` also refuses a connection
 * that works only without the token, and treats a row already connected with it as `already`.
 * A connect or disconnect running for the same URL makes this `busy`; one superseded by a newer
 * probe, or whose row was disconnected meanwhile, is `superseded` and changes nothing.
 */
export const connectServer = async (
  url: string,
  token: string | null,
  { requireToken = false }: { readonly requireToken?: boolean } = {},
): Promise<ConnectOutcome> => {
  let canonical: string | null = null
  try {
    canonical = canonicalServerUrl(url)
  } catch {
    // The probe reports the address error.
  }
  const existing = canonical === null ? undefined : serverByUrl(canonical)
  if (
    existing !== undefined &&
    (token === null ||
      (requireToken && existing.token === token && existing.status === 'connected'))
  )
    return { kind: 'already', server: existing }
  if (canonical !== null && (connecting.has(canonical) || removing.has(canonical)))
    return { kind: 'busy', url: canonical, disconnecting: removing.has(canonical) }
  if (canonical !== null) connecting.add(canonical)
  try {
    const probed = await probeServer(url, token)
    if (probed.superseded === true) return { kind: 'superseded' }
    // The panel stays usable during the probe; a server disconnected meanwhile must not come back.
    if (existing !== undefined && !isCurrentServerConnection(existing))
      return { kind: 'superseded' }
    if (probed.status === 'unreachable') return { kind: 'unreachable', server: probed }
    const appeared = existing === undefined ? serverByUrl(probed.url) : undefined
    if (appeared !== undefined) return { kind: 'already', server: appeared }
    const accepted =
      token === null ||
      (probed.status === 'connected' && !(requireToken && probed.tokenUsable === false))
    if (!accepted) return { kind: 'refused', server: probed }
    if (!upsertServer(probed)) return { kind: 'full' }
    notifyListeners(connectedListeners, 'server connection observer failed', probed)
    return { kind: 'connected', server: probed }
  } finally {
    if (canonical !== null) connecting.delete(canonical)
  }
}

/**
 * Mark a connection whose credential an admin route refused: 401 means the token expired, 403 that
 * it lacks admin scope.
 */
export const noteAuthFailure = (server: ServerConnection, status: number): void => {
  const current = serverByUrl(server.url)
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
    // The status is the whole answer, so the body is thrown away unread. Parsing it would measure
    // the full folder tree against the 64 KB cap meant for a one-line mutation reply, and any server
    // with a real tree would then report that our token could only read it.
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

const cancelServerProbe = (serverUrl: string): void => {
  activeServerProbes.get(serverUrl)?.abort(new Error('server probe cancelled'))
  activeServerProbes.delete(serverUrl)
}

/** A probe that verified nothing; `info` is what it learnt before failing. */
const failedProbe = (
  url: string,
  token: string | null,
  status: 'unreachable' | 'needs-token',
  {
    info = null,
    error,
    ...extra
  }: Partial<Pick<ServerConnection, 'info' | 'error' | 'apiVersion' | 'superseded'>> = {},
): ServerConnection => ({
  url,
  info,
  token,
  status,
  ...(error === undefined ? {} : { error }),
  isAdmin: false,
  season: null,
  ...extra,
})

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
    return failedProbe(url.trim(), token, 'unreachable', { error: String(error) })
  }
  const activeProbe = activeServerProbes.get(base)
  if (activeProbe !== undefined && options.supersedeActive === false) {
    return failedProbe(base, token, 'unreachable', {
      error: 'superseded by an active foreground server probe',
      superseded: true,
    })
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
    if (!response.ok)
      return failedProbe(base, token, 'unreachable', { error: `HTTP ${response.status}` })
    const info = parseServerInfo(body)
    if (info === null) throw new TypeError('server returned invalid metadata')
    observedInfo = info
    log(`probed ${base}`, { name: info.name, auth: info.auth })
    const version = apiVersion === 'legacy' ? { apiVersion } : {}

    if (info.auth === 'access_token' && token === null)
      return failedProbe(base, null, 'needs-token', { info, ...version })

    // `GET /server` is public and never looks at the Authorization header, so reaching it proves
    // nothing about a code. Without this second call any non-empty string would read as "connected"
    // and every later request would fail with 401.
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
      log(`${base} rejected the stored code; retrying open access`)
      effectiveToken = null
      const anonymous = await fetchManifest(null)
      authed = anonymous.response
      manifestBody = anonymous.body
      manifestRequest = anonymous.sequence
    }
    if (authed.status === 401 || authed.status === 403) {
      log(`${base} rejected the code`, { status: authed.status })
      return failedProbe(base, token, 'needs-token', { info, error: 'rejected', ...version })
    }
    if (!authed.ok)
      return failedProbe(base, token, 'unreachable', { info, error: `HTTP ${authed.status}` })
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
    return failedProbe(base, token, 'unreachable', {
      info: observedInfo,
      error: String(error),
      ...(probeController.signal.aborted ? { superseded: true as const } : {}),
    })
  } finally {
    if (activeServerProbes.get(base) === probeController) activeServerProbes.delete(base)
  }
}

/** Probe each row and apply the answer, without letting a stale probe resurrect a removed row. */
const refreshServers = async (snapshot: readonly ServerConnection[]): Promise<void> => {
  await mapLimit(snapshot, SERVER_REFRESH_CONCURRENCY, async (server) => {
    if (!isCurrentServerConnection(server)) return
    const refreshed = await probeServer(server.url, server.token, { supersedeActive: false })
    if (refreshed.superseded === true) return
    const current = serverByUrl(server.url)
    if (current === undefined || !isCurrentServerConnection(server)) return
    // A cosmetic replacement can land while the probe is in flight. Preserve that newer local
    // metadata while still applying the probe's current connectivity, season, and scope result.
    upsertServer(current === server ? refreshed : { ...refreshed, info: current.info })
  })
}

let serverRetryTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start every stored connection: revalidate its identity, auth and scope now, and keep re-probing
 * offline rows through short server restarts with their persisted credentials.
 */
export const installServerConnections = (): void => {
  void refreshServers([...getState().servers])
  if (serverRetryTimer !== null) clearInterval(serverRetryTimer)
  serverRetryTimer = setInterval(() => {
    const unreachable = getState().servers.filter((server) => server.status === 'unreachable')
    if (unreachable.length > 0) void refreshServers(unreachable)
  }, SERVER_RETRY_MS)
}
