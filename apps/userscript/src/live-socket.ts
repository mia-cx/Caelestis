import {
  encodeLivePaintParts,
  encodeLiveTileUpload,
  LIVE_PROTOCOL_V1,
  LIVE_PROTOCOL_V2,
  type LiveProjectionState,
  LiveSnapshotAssembler,
  type LiveTileOfferBatch,
  type LiveTileOfferCacheResponse,
  type LiveTileUpload,
  MAX_LIVE_MESSAGE_BYTES,
  type PaintEvent,
  uuidV7,
} from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { SerialQueue } from './concurrency.js'
import { type LiveCommandResult, type LiveSyncEvent, parseLiveEvent } from './live-events.js'
import { liveClientId, liveCredentialProtocol } from './live-identity.js'
import {
  isProfileEnabled,
  measureProfile,
  recordProfileMessage,
  recordProfileWorkload,
} from './profile.js'
import {
  type ConnectedServer,
  isCurrentServerConnection,
  serverConnectionIdentity,
} from './server-connections.js'
import { serverEndpoint } from './server-request.js'

/**
 * One live sync socket per connected server: opening it, keeping it alive, reconnecting, and the
 * command round trips that ride on it. What the events it delivers mean is the scheduler's.
 */

const MAX_RECONNECT_MS = 30_000
const MAX_FAST_RECONNECT_ATTEMPTS = 6
const LIVE_HEARTBEAT_MS = 15 * 60_000
const LIVE_HEARTBEAT_TIMEOUT_MS = 10_000
const LIVE_RECOVERY_RECONNECT_MS = 60 * 60_000
const LIVE_COMMAND_TIMEOUT_MS = 5_000
// WebSocket.OPEN and CLOSING, spelled out because test doubles need not define the statics.
const SOCKET_OPEN = 1
const SOCKET_CLOSING = 2
const CLOSE_NORMAL = 1000
const CLOSE_GOING_AWAY = 1001
const CLOSE_PROTOCOL_ERROR = 1002
const CLOSE_INTERNAL_ERROR = 1011

/** What the scheduler provides to, and learns from, the live sockets. */
export interface LiveSyncHost {
  /** The status revision and projection versions this client holds for `server`. */
  readonly stateVector: (server: ConnectedServer) => {
    readonly revision: number | null
    readonly projections: readonly LiveProjectionState[]
  }
  /** The status revision to resume from, sent when the socket opens. */
  readonly statusRevision: (server: ConnectedServer) => string | undefined
  /** Apply one sync event; false when it could not be applied. */
  readonly apply: (server: ConnectedServer, event: LiveSyncEvent) => boolean | Promise<boolean>
  /** Read live resources now: all of them, or only `resource`. */
  readonly requestReads: (
    server: ConnectedServer,
    reason: 'reconnect' | 'revision-gap',
    resource?: 'telemetry-status',
  ) => void
  /** The socket confirmed which revisions it holds, so interval reads may back off. */
  readonly reconciled: (server: ConnectedServer) => void
  /** Health changed, so the next scheduled read may have moved. */
  readonly changed: () => void
}

/**
 * How one live protocol version behaves. Version 2 pushes snapshots and answers commands, so a
 * client that falls out of step reconnects for a fresh state. Version 1 only signals, so the client
 * reads over HTTP instead; its server may never answer the state vector at all.
 */
export interface LiveProtocol {
  readonly version: 1 | 2
  readonly subprotocol: string
  readonly pushesSnapshots: boolean
  /** v1 servers may never answer the state vector; reads start after this long instead. */
  readonly bootstrapFallbackMs: number | null
  /** Out of step with the server: reconnect (v2) or read the status over HTTP (v1). */
  readonly desync: (connection: LiveConnection, code: number, reason: string) => void
}

const PROTOCOLS: { readonly [Version in 1 | 2]: LiveProtocol } = {
  1: {
    version: 1,
    subprotocol: LIVE_PROTOCOL_V1,
    pushesSnapshots: false,
    bootstrapFallbackMs: 1_000,
    desync: (connection) =>
      host?.requestReads(connection.server, 'revision-gap', 'telemetry-status'),
  },
  2: {
    version: 2,
    subprotocol: LIVE_PROTOCOL_V2,
    pushesSnapshots: true,
    bootstrapFallbackMs: null,
    desync: (connection, code, reason) => connection.socket?.close(code, reason),
  },
}

interface PendingCommand<Result> {
  readonly resolve: (response: Result | null) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface LiveConnection {
  readonly server: ConnectedServer
  socket: WebSocket | null
  /** The protocol the open socket agreed on; null before it opens. */
  protocol: LiveProtocol | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  bootstrapFallbackTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimeout: ReturnType<typeof setTimeout> | null
  attempts: number
  healthy: boolean
  reconciled: boolean
  stateRequestId: string | null
  manifestRevision: number | null
  readonly snapshots: LiveSnapshotAssembler
  readonly pending: Map<string, PendingCommand<LiveCommandResult | LiveTileOfferCacheResponse>>
}

let host: LiveSyncHost | null = null
const connections = new Map<object, LiveConnection>()
const paintDeliveries = new SerialQueue<object>()

const advertisedProtocol = (server: ConnectedServer): LiveProtocol | undefined => {
  const version = server.info.liveSyncMax ?? server.info.liveSync
  return version === undefined ? undefined : PROTOCOLS[version]
}

const connectionOf = (server: ConnectedServer): LiveConnection | undefined =>
  connections.get(serverConnectionIdentity(server))

/** The protocol in use: the one the socket agreed on, or the newest the server advertises. */
export const liveProtocol = (server: ConnectedServer): LiveProtocol | undefined =>
  connectionOf(server)?.protocol ?? advertisedProtocol(server)

export const liveCapable = (server: ConnectedServer): boolean =>
  advertisedProtocol(server) !== undefined && typeof WebSocket !== 'undefined'

/** Whether a reconciled socket currently carries this connection's live resources. */
export const serverLiveSyncHealthy = (server: ConnectedServer): boolean => {
  const held = connectionOf(server)
  return (
    liveCapable(server) &&
    held?.healthy === true &&
    held.reconciled &&
    isCurrentServerConnection(server)
  )
}

export const serverLiveSyncVersion = (server: ConnectedServer): 1 | 2 | undefined =>
  liveProtocol(server)?.version

/** Whether the tab is visible and online, the only time server work is worth doing. */
export const activeDocument = (): boolean =>
  document.visibilityState !== 'hidden' && navigator.onLine !== false

const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
  if (timer !== null) clearTimeout(timer)
  return null
}

const settlePending = (connection: LiveConnection): void => {
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer)
    pending.resolve(null)
  }
  connection.pending.clear()
}

const closeConnection = (connection: LiveConnection, preserveReconnect = false): void => {
  if (!preserveReconnect) connection.reconnectTimer = clearTimer(connection.reconnectTimer)
  connection.bootstrapFallbackTimer = clearTimer(connection.bootstrapFallbackTimer)
  connection.heartbeatTimer = clearTimer(connection.heartbeatTimer)
  connection.heartbeatTimeout = clearTimer(connection.heartbeatTimeout)
  settlePending(connection)
  connection.snapshots.clear()
  connection.healthy = false
  connection.reconciled = false
  connection.stateRequestId = null
  const socket = connection.socket
  connection.socket = null
  if (socket !== null && socket.readyState < SOCKET_CLOSING) socket.close(CLOSE_NORMAL, 'retired')
}

/** Ping now, and close the socket if no answer comes back in time. */
const ping = (connection: LiveConnection, socket: WebSocket, reason: string): void => {
  socket.send('ping')
  connection.heartbeatTimeout = setTimeout(() => {
    connection.heartbeatTimeout = null
    if (connection.socket === socket) socket.close(CLOSE_GOING_AWAY, reason)
  }, LIVE_HEARTBEAT_TIMEOUT_MS)
}

const armHeartbeat = (connection: LiveConnection): void => {
  connection.heartbeatTimer = clearTimer(connection.heartbeatTimer)
  connection.heartbeatTimeout = clearTimer(connection.heartbeatTimeout)
  connection.heartbeatTimer = setTimeout(() => {
    connection.heartbeatTimer = null
    const socket = connection.socket
    if (socket === null || socket.readyState !== SOCKET_OPEN) return
    ping(connection, socket, 'live sync heartbeat timeout')
  }, LIVE_HEARTBEAT_MS)
}

/** Check a socket that may have died while the page was hidden or offline. */
const probe = (connection: LiveConnection): void => {
  const socket = connection.socket
  if (socket === null || socket.readyState !== SOCKET_OPEN || connection.heartbeatTimeout !== null)
    return
  connection.heartbeatTimer = clearTimer(connection.heartbeatTimer)
  ping(connection, socket, 'live sync resume timeout')
}

const confirmHealthy = (connection: LiveConnection): void => {
  connection.attempts = 0
  connection.healthy = true
  armHeartbeat(connection)
}

const scheduleReconnect = (connection: LiveConnection): void => {
  if (connection.reconnectTimer !== null) return
  const attempt = connection.attempts
  connection.attempts = Math.min(attempt + 1, MAX_FAST_RECONNECT_ATTEMPTS)
  const delay =
    attempt < MAX_FAST_RECONNECT_ATTEMPTS
      ? Math.min(1_000 * 2 ** attempt, MAX_RECONNECT_MS)
      : LIVE_RECOVERY_RECONNECT_MS
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null
    open(connection)
  }, delay)
}

const completeReconciliation = (connection: LiveConnection): void => {
  connection.reconciled = true
  connection.bootstrapFallbackTimer = clearTimer(connection.bootstrapFallbackTimer)
  host?.reconciled(connection.server)
}

const armBootstrapFallback = (connection: LiveConnection): void => {
  connection.bootstrapFallbackTimer = clearTimer(connection.bootstrapFallbackTimer)
  const delay = liveProtocol(connection.server)?.bootstrapFallbackMs ?? null
  if (delay === null) return
  connection.bootstrapFallbackTimer = setTimeout(() => {
    connection.bootstrapFallbackTimer = null
    if (!isCurrentServerConnection(connection.server) || connection.reconciled) return
    connection.stateRequestId = null
    completeReconciliation(connection)
    host?.requestReads(connection.server, 'reconnect')
  }, delay)
}

const resolvePending = (
  connection: LiveConnection,
  requestId: string,
  response: LiveCommandResult | LiveTileOfferCacheResponse,
): void => {
  const pending = connection.pending.get(requestId)
  if (pending === undefined) return
  connection.pending.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve(response)
}

/** What the socket itself owns in an event; the rest is handed to the scheduler. */
const receive = async (connection: LiveConnection, raw: unknown): Promise<void> => {
  const { server } = connection
  const protocol = liveProtocol(server)
  if (!isCurrentServerConnection(server) || protocol === undefined) return
  const event = parseLiveEvent(raw)
  if (event === null) {
    protocol.desync(connection, CLOSE_PROTOCOL_ERROR, 'invalid live event')
    return
  }
  switch (event.type) {
    case 'dashboard-snapshot':
      return
    case 'tile-offer-cache-result':
      resolvePending(connection, event.requestId, event.response)
      return
    case 'paint-result':
    case 'paint-part-result':
    case 'tile-offer-result':
    case 'tile-upload-result':
      resolvePending(connection, event.requestId, event)
      return
    case 'state-correction':
      if (connection.stateRequestId !== event.requestId) return
      connection.stateRequestId = null
      completeReconciliation(connection)
      // v2 follows the correction with the snapshots themselves.
      if (protocol.pushesSnapshots) return
      break
    case 'manifest-reconcile':
      if (event.revision !== null) {
        if (event.revision <= (connection.manifestRevision ?? -1)) return
        connection.manifestRevision = event.revision
      }
      break
    case 'alarms-reconcile':
      if (protocol.pushesSnapshots) return
      break
    case 'status-reconcile':
      if (protocol.pushesSnapshots) {
        connection.socket?.close(CLOSE_INTERNAL_ERROR, 'status snapshot required')
        return
      }
      break
  }
  if (await (host?.apply(server, event) ?? true)) return
  if (event.type === 'status-delta')
    protocol.desync(connection, CLOSE_INTERNAL_ERROR, 'status revision gap')
  else connection.socket?.close(CLOSE_INTERNAL_ERROR, 'invalid live snapshot')
}

/** A complete JSON message, a snapshot part still being assembled, or something invalid. */
const assemble = (
  connection: LiveConnection,
  data: unknown,
): { readonly value: unknown } | 'pending' | 'invalid' => {
  if (
    typeof data !== 'string' ||
    new TextEncoder().encode(data).byteLength > MAX_LIVE_MESSAGE_BYTES
  )
    return 'invalid'
  try {
    const value = connection.snapshots.push(JSON.parse(data))
    return value === null ? 'pending' : { value }
  } catch {
    return 'invalid'
  }
}

const socketUrl = (server: ConnectedServer, authenticated: boolean): URL => {
  const endpoint = new URL(serverEndpoint(server, '/telemetry/live'))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('scope', server.isAdmin ? 'admin' : 'public')
  endpoint.searchParams.set('client', 'userscript')
  endpoint.searchParams.set('clientVersion', userscriptVersion)
  endpoint.searchParams.set('stateVector', '1')
  if (!authenticated) endpoint.searchParams.set('clientId', liveClientId(server.url))
  const revision = host?.statusRevision(server)
  if (revision !== undefined) endpoint.searchParams.set('revision', revision)
  return endpoint
}

const open = (connection: LiveConnection): void => {
  const { server } = connection
  const advertised = advertisedProtocol(server)
  if (
    !activeDocument() ||
    !isCurrentServerConnection(server) ||
    advertised === undefined ||
    typeof WebSocket === 'undefined' ||
    connection.socket !== null ||
    connection.reconnectTimer !== null
  )
    return
  const authenticated = server.token !== null && server.tokenUsable !== false
  // A v2 server still accepts v1, so the newest it advertises is offered first.
  const protocols =
    advertised.version === 2 ? [LIVE_PROTOCOL_V2, LIVE_PROTOCOL_V1] : [LIVE_PROTOCOL_V1]
  if (authenticated && server.token !== null) protocols.push(liveCredentialProtocol(server.token))
  let socket: WebSocket
  try {
    socket = new WebSocket(socketUrl(server, authenticated), protocols)
  } catch {
    scheduleReconnect(connection)
    armBootstrapFallback(connection)
    return
  }
  connection.socket = socket
  armBootstrapFallback(connection)
  socket.addEventListener('open', () => {
    if (connection.socket !== socket || !isCurrentServerConnection(server)) return
    connection.protocol =
      Object.values(PROTOCOLS).find((protocol) => protocol.subprotocol === socket.protocol) ?? null
    if (connection.protocol === null) {
      socket.close(CLOSE_PROTOCOL_ERROR, 'live protocol not negotiated')
      return
    }
    connection.healthy = true
    connection.reconciled = false
    armHeartbeat(connection)
    const requestId = uuidV7()
    connection.stateRequestId = requestId
    socket.send(JSON.stringify({ type: 'state-vector', requestId, ...host?.stateVector(server) }))
    armBootstrapFallback(connection)
    host?.changed()
  })
  socket.addEventListener('message', (message) => {
    if (connection.socket !== socket) return
    if (message.data === 'pong') {
      confirmHealthy(connection)
      return
    }
    const assembled = assemble(connection, message.data)
    if (assembled === 'invalid') {
      const protocol = liveProtocol(server)
      protocol?.desync(connection, CLOSE_PROTOCOL_ERROR, 'invalid live event')
      return
    }
    confirmHealthy(connection)
    if (assembled !== 'pending')
      void receive(connection, assembled.value).catch(() =>
        socket.close(CLOSE_INTERNAL_ERROR, 'live event failed'),
      )
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (connection.socket !== socket) return
    connection.socket = null
    connection.healthy = false
    connection.reconciled = false
    connection.stateRequestId = null
    connection.heartbeatTimer = clearTimer(connection.heartbeatTimer)
    connection.heartbeatTimeout = clearTimer(connection.heartbeatTimeout)
    if (!isCurrentServerConnection(server)) return
    scheduleReconnect(connection)
    armBootstrapFallback(connection)
    host?.changed()
  })
}

/** Hand the sockets the scheduler that applies what they receive. */
export const attachLiveSyncHost = (scheduler: LiveSyncHost): void => {
  host = scheduler
}

/** Open a socket for each live-capable connection in `servers`, and close every other one. */
export const reconcileLiveConnections = (servers: readonly ConnectedServer[]): void => {
  const retained = new Set<object>()
  for (const server of servers) {
    if (!liveCapable(server)) continue
    const owner = serverConnectionIdentity(server)
    retained.add(owner)
    let connection = connections.get(owner)
    if (connection === undefined) {
      connection = {
        server,
        socket: null,
        protocol: null,
        reconnectTimer: null,
        bootstrapFallbackTimer: null,
        heartbeatTimer: null,
        heartbeatTimeout: null,
        attempts: 0,
        healthy: false,
        reconciled: false,
        stateRequestId: null,
        manifestRevision: null,
        snapshots: new LiveSnapshotAssembler(),
        pending: new Map(),
      }
      connections.set(owner, connection)
    }
    open(connection)
  }
  for (const [owner, connection] of connections) {
    if (retained.has(owner)) continue
    closeConnection(connection)
    connections.delete(owner)
  }
}

/** Check the healthy sockets of these connections, after the page was hidden or offline. */
export const probeLiveConnections = (servers: readonly ConnectedServer[]): void => {
  for (const server of servers) {
    const connection = connectionOf(server)
    if (connection !== undefined && serverLiveSyncHealthy(server)) probe(connection)
  }
}

/** Close every socket while offline; each reconnects on its own schedule. */
export const suspendLiveConnections = (): void => {
  for (const connection of connections.values()) closeConnection(connection, true)
}

/** Send one request over a healthy socket and wait for its answer, or null after a timeout. */
const roundTrip = <Result extends LiveCommandResult | LiveTileOfferCacheResponse>(
  server: ConnectedServer,
  available: boolean,
  send: (socket: WebSocket, requestId: string) => void,
  matches: (response: LiveCommandResult | LiveTileOfferCacheResponse) => response is Result,
): Promise<Result | null> => {
  const connection = connectionOf(server)
  const socket = connection?.socket ?? null
  if (!available || !serverLiveSyncHealthy(server) || connection === undefined || socket === null)
    return Promise.resolve(null)
  const requestId = uuidV7()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connection.pending.delete(requestId)
      resolve(null)
    }, LIVE_COMMAND_TIMEOUT_MS)
    connection.pending.set(requestId, {
      resolve: (response) => resolve(response !== null && matches(response) ? response : null),
      timer,
    })
    try {
      send(socket, requestId)
    } catch {
      clearTimeout(timer)
      connection.pending.delete(requestId)
      resolve(null)
    }
  })
}

const isCommand =
  <Type extends LiveCommandResult['type']>(type: Type) =>
  (
    response: LiveCommandResult | LiveTileOfferCacheResponse,
  ): response is Extract<LiveCommandResult, { readonly type: Type }> =>
    'type' in response && response.type === type

const isPaintAnswer = (
  response: LiveCommandResult | LiveTileOfferCacheResponse,
): response is Extract<
  LiveCommandResult,
  { readonly type: 'paint-result' | 'paint-part-result' }
> =>
  'type' in response && (response.type === 'paint-result' || response.type === 'paint-part-result')

const isCacheResponse = (
  response: LiveCommandResult | LiveTileOfferCacheResponse,
): response is LiveTileOfferCacheResponse => !('type' in response)

const commandsAvailable = (server: ConnectedServer): boolean => liveProtocol(server)?.version === 2

/** Ask a v1 socket which offered tiles the server already holds. */
export const requestLiveTileOfferCache = (
  server: ConnectedServer,
  batch: LiveTileOfferBatch,
): Promise<LiveTileOfferCacheResponse | null> =>
  roundTrip(
    server,
    server.info.liveTileOffers === 1,
    (socket, requestId) =>
      socket.send(JSON.stringify({ type: 'tile-offer-cache', requestId, batch })),
    isCacheResponse,
  )

type PaintResult = Extract<LiveCommandResult, { readonly type: 'paint-result' }>

const sendPaintMessage = (server: ConnectedServer, message: (requestId: string) => object) =>
  roundTrip(
    server,
    commandsAvailable(server),
    (socket, requestId) =>
      measureProfile('Live paint send', () => {
        const payload = JSON.stringify(message(requestId))
        socket.send(payload)
        recordProfileMessage('Live paint sent', payload)
      }),
    isPaintAnswer,
  )

const sendLivePaint = async (
  server: ConnectedServer,
  event: PaintEvent,
): Promise<PaintResult | null> => {
  if (!commandsAvailable(server)) return null
  const transferId = uuidV7()
  const invalid = (error: 'invalid' | 'unsupported' | 'too-large' = 'invalid'): PaintResult => ({
    type: 'paint-result',
    requestId: transferId,
    eventId: event.eventId,
    result: 'duplicate',
    error,
  })
  if (isProfileEnabled())
    recordProfileWorkload(
      'Live paint pixels',
      event.tiles.reduce((sum, tile) => sum + tile.pixels.x.length, 0),
    )
  const encoded = measureProfile('Live paint encode', () =>
    JSON.stringify({ type: 'paint-report', requestId: transferId, event }),
  )
  if (new TextEncoder().encode(encoded).byteLength <= MAX_LIVE_MESSAGE_BYTES) {
    const response = await sendPaintMessage(server, (requestId) => ({
      type: 'paint-report',
      requestId,
      event,
    }))
    return response?.type === 'paint-result' && response.eventId === event.eventId ? response : null
  }
  if (server.info.livePaintParts !== 1) return invalid('unsupported')
  let parts: ReturnType<typeof encodeLivePaintParts>
  try {
    parts = measureProfile('Live paint split', () => encodeLivePaintParts(event, transferId))
  } catch (error) {
    if (error instanceof RangeError) return invalid('too-large')
    throw error
  }
  for (const part of parts) {
    const response = await sendPaintMessage(server, (requestId) => ({
      type: 'paint-part',
      requestId,
      ...part,
    }))
    if (response === null) return null
    if (response.eventId !== event.eventId) return invalid()
    const last = part.index === part.total - 1
    if (response.type === 'paint-result')
      return response.error !== undefined || last ? response : invalid()
    if (response.index !== part.index || last) return invalid()
  }
  return invalid()
}

/** Serialize paint transfers per server; receipt of every part provides backpressure. */
export const requestLivePaint = (
  server: ConnectedServer,
  event: PaintEvent,
): Promise<PaintResult | null> =>
  paintDeliveries.run(serverConnectionIdentity(server), () => sendLivePaint(server, event))

export const requestLiveTileOffer = (
  server: ConnectedServer,
  batch: LiveTileOfferBatch,
): Promise<Extract<LiveCommandResult, { readonly type: 'tile-offer-result' }> | null> =>
  roundTrip(
    server,
    commandsAvailable(server),
    (socket, requestId) => socket.send(JSON.stringify({ type: 'tile-offer', requestId, batch })),
    isCommand('tile-offer-result'),
  )

export const requestLiveTileUpload = (
  server: ConnectedServer,
  upload: Omit<LiveTileUpload, 'type' | 'requestId'>,
  bytes: Uint8Array,
): Promise<Extract<LiveCommandResult, { readonly type: 'tile-upload-result' }> | null> =>
  roundTrip(
    server,
    commandsAvailable(server),
    (socket, requestId) =>
      socket.send(encodeLiveTileUpload({ type: 'tile-upload', requestId, ...upload }, bytes)),
    isCommand('tile-upload-result'),
  )
