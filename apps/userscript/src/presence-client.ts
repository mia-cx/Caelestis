import {
  decodePresenceServerEvent,
  type PainterIdentity,
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_QUICK_CLAIMS_MIN_MS,
  PRESENCE_VIEWPORT_MIN_MS,
  type PresenceClientEvent,
  type PresenceDraft,
  type PresencePeer,
  type PresenceRect,
  type PresenceServerEvent,
  type RegionClaim,
  reuseDocument,
  sameRect,
  sameTemplateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { log, warn } from './debug.js'
import {
  isProfileEnabled,
  measureProfile,
  measureProfileDetail,
  recordProfileCounter,
  recordProfileMessage,
  recordProfileWorkload,
} from './profile.js'
import { pollRegionSnapshots, type RegionSnapshot } from './region-api.js'
import {
  activeServerToken,
  isCurrentServerConnection,
  serverConnectionIdentity,
} from './server-connections.js'
import { liveClientId, liveCredentialProtocol } from './server-sync-coordinator.js'
import { serverEndpoint } from './server-url.js'
import { getState, onStateChange, type ServerConnection } from './settings.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

/**
 * One throttled socket per compatible server. Each may have a distinct audience.
 * Viewports and drafts retain their existing cadence and server-side nearby filtering.
 * A random tab publisher ID identifies copies without sharing credential admission IDs.
 *
 * The socket publishes what it is given (`setPresenceViewport`, `setPresenceDraft`,
 * `setPresenceQuickClaims`) and holds what the server says. While a server has no socket open,
 * its claims come from `region-api`'s snapshot poll instead.
 */

const MAX_RECONNECT_MS = 30_000
const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_JITTER_MS = 500

/** What was last sent on a socket. `undefined` means nothing yet; a new session has no quick claims. */
interface Sent {
  viewport: PresenceRect | null | undefined
  draft: PresenceDraft | null | undefined
  quickClaims: readonly PresenceRect[]
  viewportAt: number
  draftAt: number
  quickClaimsAt: number
}

const nothingSent = (): Sent => ({
  viewport: undefined,
  draft: undefined,
  quickClaims: [],
  viewportAt: Number.NEGATIVE_INFINITY,
  draftAt: Number.NEGATIVE_INFINITY,
  quickClaimsAt: Number.NEGATIVE_INFINITY,
})

interface Connection {
  readonly server: ServerConnection
  socket: WebSocket | null
  sessionId: string | null
  peers: Map<string, PresencePeer>
  regions: readonly RegionClaim[]
  claimsRevision: number
  ownedRegionIds: readonly string[]
  canWriteClaims: boolean
  stopSnapshots: (() => void) | null
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  flushTimer: ReturnType<typeof setTimeout> | null
  sent: Sent
}

export interface PresenceView {
  readonly peers: readonly PresencePeer[]
  readonly regions: readonly RegionClaim[]
  readonly online: number
  readonly connected: boolean
  readonly me: PainterIdentity | null
}

const connections = new Map<object, Connection>()
const listeners: (() => void)[] = []
const claimListeners: (() => void)[] = []
const receivedOrder = new WeakMap<PresencePeer, number>()
let receivedSequence = 0
/** Bumped on every change to what `presenceView` reads, so it can reuse its last answer. */
let revision = 0
let installed = false
let identityRequested = false
const publisherId = uuidV7()
let hiddenTab = false
/** What this tab would publish if it may: see `effective`. */
const local: {
  viewport: PresenceRect | null
  draft: PresenceDraft | null
  quickClaims: readonly PresenceRect[]
} = { viewport: null, draft: null, quickClaims: [] }

const run = (list: readonly (() => void)[], what: string): void => {
  for (const listener of list) {
    try {
      listener()
    } catch (error) {
      warn('install', `${what} listener failed`, String(error))
    }
  }
}

/** Tell listeners; claim listeners too when the claims changed. */
const changed = (claims = false): void => {
  revision++
  if (claims) run(claimListeners, 'presence claims')
  run(listeners, 'presence')
}

/** Runs after any peer, region, or connection change. */
export const onPresenceChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** Runs after claims change only, so reconciling claims skips every viewport update. */
export const onPresenceClaimsChange = (listener: () => void): void => {
  claimListeners.push(listener)
}

const eligible = (server: ServerConnection): boolean =>
  server.status === 'connected' &&
  server.season !== null &&
  server.info?.presence === 1 &&
  typeof WebSocket !== 'undefined'

const canPublish = (): boolean => getState().sharePresence && !hiddenTab

const sameDraft = (left: PresenceDraft | null, right: PresenceDraft | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    sameRect(left.rect, right.rect) &&
    left.pixels === right.pixels &&
    left.mask === right.mask)

const sameRects = (left: readonly PresenceRect[], right: readonly PresenceRect[]): boolean =>
  left.length === right.length && left.every((rect, index) => sameRect(rect, right[index] ?? null))

const send = (connection: Connection, event: PresenceClientEvent): boolean => {
  const socket = connection.socket
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  try {
    measureProfile('Presence send', () => {
      const payload = JSON.stringify(event)
      socket.send(payload)
      recordProfileMessage('Presence sent', payload)
    })
  } catch (error) {
    warn('install', 'presence send failed', String(error))
    return false
  }
  armHeartbeat(connection)
  return true
}

/** This server's claims, keeping held objects where nothing changed so their caches survive. */
const receivedRegions = (
  connection: Connection,
  incoming: readonly RegionClaim[],
): RegionClaim[] => {
  const previous = new Map(connection.regions.map((region) => [region.id, region]))
  return incoming
    .filter(
      (region) =>
        region.season === connection.server.season &&
        sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE),
    )
    .map((region) => reuseDocument(previous.get(region.id), region))
}

const armHeartbeat = (connection: Connection): void => {
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  connection.heartbeatTimer = setTimeout(() => {
    connection.heartbeatTimer = null
    // The full state goes with the heartbeat, so a server that hibernated and lost this session's
    // draft mask gets it back without any extra message.
    const draft = canPublish() ? (connection.sent.draft ?? null) : null
    if (draft === null) send(connection, { type: 'presence-heartbeat' })
    else
      send(connection, {
        type: 'presence-update',
        viewport: connection.sent.viewport ?? null,
        draft,
      })
  }, PRESENCE_HEARTBEAT_MS)
}

/** What this tab is willing to publish right now: the local state, or nothing at all. */
const effective = (): typeof local => ({
  ...(canPublish() ? local : { viewport: null, draft: null }),
  // A hidden tab is still painting; its quick claims end with the paint session or the tab.
  quickClaims: getState().sharePresence ? local.quickClaims : [],
})

/**
 * Per channel: what to publish, whether it differs from what was sent, and how long until it may
 * go. Clearing never waits, so peers lose a stale rect straight away; quick claims coalesce,
 * clears included, so a burst of rectangles sends only the latest list and stays under the
 * server's per-second limit.
 */
const channels = (connection: Connection, at: number) => {
  const { viewport, draft, quickClaims } = effective()
  const { sent } = connection
  return {
    viewport: {
      value: viewport,
      dirty: sent.viewport === undefined || !sameRect(sent.viewport, viewport),
      wait: viewport === null ? 0 : Math.max(0, sent.viewportAt + PRESENCE_VIEWPORT_MIN_MS - at),
    },
    draft: {
      value: draft,
      dirty: sent.draft === undefined || !sameDraft(sent.draft, draft),
      wait: draft === null ? 0 : Math.max(0, sent.draftAt + PRESENCE_DRAFT_MIN_MS - at),
    },
    quickClaims: {
      value: quickClaims,
      dirty: !sameRects(sent.quickClaims, quickClaims),
      wait: Math.max(0, sent.quickClaimsAt + PRESENCE_QUICK_CLAIMS_MIN_MS - at),
    },
  }
}

/** Send whatever changed and is due; wait for whatever changed but is not due yet. */
const flush = (connection: Connection): void => {
  connection.flushTimer = null
  if (connection.socket?.readyState !== WebSocket.OPEN) return
  const at = Date.now()
  const { viewport, draft, quickClaims } = channels(connection, at)
  const sendViewport = viewport.dirty && viewport.wait === 0
  const sendDraft = draft.dirty && draft.wait === 0
  const sendQuickClaims = quickClaims.dirty && quickClaims.wait === 0
  if (
    (sendViewport || sendDraft || sendQuickClaims) &&
    send(connection, {
      type: 'presence-update',
      ...(sendViewport ? { viewport: viewport.value } : {}),
      ...(sendDraft ? { draft: draft.value } : {}),
      ...(sendQuickClaims ? { quickClaims: quickClaims.value } : {}),
    })
  ) {
    const { sent } = connection
    if (sendViewport) {
      sent.viewport = viewport.value
      sent.viewportAt = at
    }
    if (sendDraft) {
      sent.draft = draft.value
      sent.draftAt = at
    }
    if (sendQuickClaims) {
      sent.quickClaims = quickClaims.value
      sent.quickClaimsAt = at
    }
  }
  if (
    (viewport.dirty && !sendViewport) ||
    (draft.dirty && !sendDraft) ||
    (quickClaims.dirty && !sendQuickClaims)
  )
    scheduleFlush(connection)
}

const scheduleFlush = (connection: Connection): void => {
  if (connection.flushTimer !== null) return
  const wait = Math.min(
    ...Object.values(channels(connection, Date.now())).map((channel) =>
      channel.dirty ? channel.wait : Number.POSITIVE_INFINITY,
    ),
  )
  if (!Number.isFinite(wait)) return
  connection.flushTimer = setTimeout(() => flush(connection), wait)
}

const scheduleAll = (): void => {
  for (const connection of connections.values()) scheduleFlush(connection)
}

const applyClaims = (
  connection: Connection,
  regions: readonly RegionClaim[],
  ownedRegionIds: readonly string[] | undefined,
): void => {
  connection.regions = receivedRegions(connection, regions)
  connection.claimsRevision++
  connection.ownedRegionIds = ownedRegionIds ?? []
}

const receivePeer = (connection: Connection, peer: PresencePeer): void => {
  receivedOrder.set(peer, ++receivedSequence)
  connection.peers.set(peer.sessionId, peer)
}

/** Apply one server event; true when it changed the claims. */
const applyServerEvent = (connection: Connection, event: PresenceServerEvent): boolean => {
  switch (event.type) {
    case 'presence-ready':
      connection.sessionId = event.sessionId
      // A server that completes the handshake and then misbehaves keeps its backoff; only a
      // healthy exchange resets it.
      connection.attempts = 0
      connection.peers = new Map()
      for (const peer of event.peers) receivePeer(connection, peer)
      applyClaims(connection, event.regions, event.ownedRegionIds)
      connection.canWriteClaims = event.canWrite === true
      stopSnapshots(connection)
      return true
    case 'presence-delta':
      for (const id of event.remove) connection.peers.delete(id)
      for (const peer of event.upsert) receivePeer(connection, peer)
      return false
    case 'regions':
      applyClaims(connection, event.regions, event.ownedRegionIds)
      return true
    case 'claims-renewed': {
      const ids = new Set(event.ids)
      connection.regions = connection.regions.map((region) =>
        ids.has(region.id) ? { ...region, expiresAt: event.expiresAt } : region,
      )
      return true
    }
  }
}

const clearTimers = (connection: Connection): void => {
  if (connection.reconnectTimer !== null) clearTimeout(connection.reconnectTimer)
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.flushTimer !== null) clearTimeout(connection.flushTimer)
  connection.reconnectTimer = null
  connection.heartbeatTimer = null
  connection.flushTimer = null
}

const stopSnapshots = (connection: Connection): void => {
  connection.stopSnapshots?.()
  connection.stopSnapshots = null
}

/** Read claims over HTTP while this server has no presence session. */
const startSnapshots = (connection: Connection): void => {
  if (connection.sessionId !== null || connection.stopSnapshots !== null) return
  connection.stopSnapshots = pollRegionSnapshots(connection.server, (snapshot: RegionSnapshot) => {
    if (connection.sessionId !== null) return
    applyClaims(connection, snapshot.regions, snapshot.ownedRegionIds)
    connection.canWriteClaims = snapshot.canWrite
    changed(true)
  })
}

const closeConnection = (connection: Connection): void => {
  stopSnapshots(connection)
  clearTimers(connection)
  const socket = connection.socket
  connection.socket = null
  connection.sessionId = null
  revision++
  if (socket !== null && socket.readyState < WebSocket.CLOSING) {
    try {
      socket.close(1000, 'presence retired')
    } catch {
      // Already gone.
    }
  }
  if (connection.peers.size > 0) {
    connection.peers = new Map()
    changed()
  }
}

const scheduleReconnect = (connection: Connection): void => {
  startSnapshots(connection)
  if (connection.reconnectTimer !== null) return
  const delay = Math.min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2 ** connection.attempts)
  connection.attempts = Math.min(connection.attempts + 1, MAX_RECONNECT_ATTEMPTS)
  connection.reconnectTimer = setTimeout(
    () => {
      connection.reconnectTimer = null
      open(connection)
    },
    delay + Math.random() * RECONNECT_JITTER_MS,
  )
}

const onMessage = (connection: Connection, socket: WebSocket, data: string): void => {
  recordProfileMessage('Presence received', data)
  if (data === 'pong') return
  let event: ReturnType<typeof decodePresenceServerEvent>
  try {
    event = measureProfile('Presence parse', () => decodePresenceServerEvent(JSON.parse(data)))
  } catch {
    event = null
  }
  if (event === null) {
    recordProfileCounter('Presence invalid messages')
    socket.close(4002, 'invalid presence event')
    return
  }
  const claims =
    event !== 'unknown' &&
    measureProfile('Presence state update', () => applyServerEvent(connection, event))
  measureProfileDetail('Presence notify', () => changed(claims))
  if (!isProfileEnabled()) return
  recordProfileWorkload('Presence peers', connection.peers.size)
  recordProfileWorkload('Presence regions', connection.regions.length)
  recordProfileWorkload(
    'Presence region shapes',
    connection.regions.reduce((sum, region) => sum + region.document.items.length, 0),
  )
  recordProfileWorkload(
    'Presence region bounding pixels',
    connection.regions.reduce((sum, region) => sum + region.rect.w * region.rect.h, 0),
  )
}

const open = (connection: Connection): void => {
  const { server } = connection
  const identity = accountIdentity()
  if (
    connection.socket !== null ||
    connection.reconnectTimer !== null ||
    !isCurrentServerConnection(server) ||
    !eligible(server) ||
    server.season === null ||
    identity === null
  )
    return
  const endpoint = new URL(serverEndpoint(server.url, '/telemetry/presence'))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('surface', WORLD_TEMPLATE_SURFACE.kind)
  endpoint.searchParams.set('painterId', String(identity.wplaceUserId))
  endpoint.searchParams.set('painterName', identity.displayName)
  endpoint.searchParams.set('client', 'userscript')
  endpoint.searchParams.set('clientVersion', userscriptVersion)
  const token = activeServerToken(server)
  // Every connection carries this browser's id, so painters sharing one token are not counted
  // as one client against the per-client socket cap.
  endpoint.searchParams.set('clientId', liveClientId(server.url))
  endpoint.searchParams.set('publisherId', publisherId)
  const protocols = [PRESENCE_PROTOCOL_V1]
  if (token !== null) protocols.push(liveCredentialProtocol(token))
  let socket: WebSocket
  try {
    socket = new WebSocket(endpoint, protocols)
  } catch (error) {
    warn('install', 'presence socket could not open', String(error))
    scheduleReconnect(connection)
    return
  }
  connection.socket = socket
  socket.addEventListener('open', () => {
    if (connection.socket !== socket) return
    if (socket.protocol !== PRESENCE_PROTOCOL_V1) {
      // Browsers only allow 1000 or 3000..4999 from a page; anything else throws instead of closing.
      socket.close(4002, 'presence protocol not negotiated')
      return
    }
    connection.sent = nothingSent()
    log('install', 'presence connected', { server: server.url })
    armHeartbeat(connection)
    scheduleFlush(connection)
    changed()
  })
  socket.addEventListener('message', (message) => {
    if (connection.socket === socket && typeof message.data === 'string')
      onMessage(connection, socket, message.data)
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (connection.socket !== socket) return
    connection.socket = null
    connection.sessionId = null
    clearTimers(connection)
    connection.peers = new Map()
    changed()
    if (isCurrentServerConnection(server) && eligible(server)) scheduleReconnect(connection)
  })
}

const reconcile = (): void => {
  const retained = new Set<object>()
  if (accountIdentity() === null && !identityRequested) {
    identityRequested = true
    void loadAccount()
      .catch(() => undefined)
      .then(() => {
        identityRequested = false
        if (accountIdentity() !== null) reconcile()
      })
  }
  for (const server of getState().servers) {
    if (!eligible(server)) continue
    const owner = serverConnectionIdentity(server)
    retained.add(owner)
    if (connections.has(owner)) continue
    connections.set(owner, {
      server,
      socket: null,
      sessionId: null,
      peers: new Map(),
      regions: [],
      claimsRevision: 0,
      ownedRegionIds: [],
      canWriteClaims: false,
      stopSnapshots: null,
      attempts: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      flushTimer: null,
      sent: nothingSent(),
    })
    revision++
  }
  for (const [owner, connection] of connections) {
    if (retained.has(owner)) continue
    closeConnection(connection)
    connections.delete(owner)
  }
  for (const connection of connections.values()) {
    open(connection)
    startSnapshots(connection)
  }
}

const isOpen = (connection: Connection): boolean => connection.socket?.readyState === WebSocket.OPEN

let shared: {
  readonly revision: number
  readonly open: readonly boolean[]
  readonly peers: readonly PresencePeer[]
  readonly regions: readonly RegionClaim[]
} | null = null

/** Every peer and claim across servers, deduplicated; rebuilt only when presence changed. */
const merged = (): NonNullable<typeof shared> => {
  const open = [...connections.values()].map(isOpen)
  if (
    shared?.revision === revision &&
    shared.open.length === open.length &&
    shared.open.every((held, index) => held === open[index])
  )
    return shared
  const peers = new Map<string, PresencePeer>()
  const regions = new Map<string, RegionClaim>()
  for (const connection of connections.values()) {
    if (isOpen(connection))
      for (const peer of connection.peers.values()) {
        if (peer.sessionId === connection.sessionId || peer.publisherId === publisherId) continue
        const key =
          peer.publisherId === undefined
            ? `${connection.server.url}:${peer.sessionId}`
            : `${peer.painter.wplaceUserId}:${peer.publisherId}`
        const previous = peers.get(key)
        if (
          previous === undefined ||
          (receivedOrder.get(peer) ?? 0) > (receivedOrder.get(previous) ?? 0)
        )
          peers.set(key, peer)
      }
    for (const region of connection.regions) {
      const key = `${region.season}:${region.surface.kind}:${region.surface.allianceId}:${region.claimant.wplaceUserId}:${region.id}`
      regions.set(key, region)
    }
  }
  shared = {
    revision,
    open,
    peers: [...peers].map(([key, peer]) => ({ ...peer, sessionId: key })),
    regions: [...regions.values()],
  }
  return shared
}

/** Unique nearby sessions and logical claims across all connected servers. */
export const presenceView = (): PresenceView => {
  const { peers, regions, open } = merged()
  return {
    peers,
    regions,
    online: peers.length,
    connected: open.includes(true),
    me: accountIdentity(),
  }
}

/** Every connected server supporting presence, including sockets currently reconnecting. */
export const presenceServers = (): readonly ServerConnection[] =>
  [...connections.values()].map((connection) => connection.server)

const connectionFor = (server: ServerConnection): Connection | null =>
  connections.get(serverConnectionIdentity(server)) ?? null

/** Raw copies and handshake state for claim reconciliation. */
export const presenceServerClaims = (
  server: ServerConnection,
): {
  readonly ready: boolean
  readonly regions: readonly RegionClaim[]
  readonly revision: number
  readonly ownedRegionIds: readonly string[]
} => {
  const connection = connectionFor(server)
  return {
    ready: (connection?.claimsRevision ?? 0) > 0,
    regions: connection?.regions ?? [],
    revision: connection?.claimsRevision ?? 0,
    ownedRegionIds: connection?.ownedRegionIds ?? [],
  }
}

/** Claims require report/admin capability from an authenticated server snapshot. */
export const presenceCanWriteClaims = (server: ServerConnection): boolean =>
  activeServerToken(server) !== null && connectionFor(server)?.canWriteClaims === true

/** Publish this tab's viewport. */
export const setPresenceViewport = (viewport: PresenceRect | null): void => {
  if (sameRect(viewport, local.viewport)) return
  local.viewport = viewport
  scheduleAll()
}

/** Publish this tab's drafted pixels. */
export const setPresenceDraft = (draft: PresenceDraft | null): void => {
  if (sameDraft(draft, local.draft)) return
  local.draft = draft
  scheduleAll()
}

/** This tab's quick claims for the current paint session, newest last. */
export const presenceQuickClaims = (): readonly PresenceRect[] => local.quickClaims

/** Replace this tab's quick claims and send them to every server at once. `[]` clears them. */
export const setPresenceQuickClaims = (rects: readonly PresenceRect[]): void => {
  if (sameRects(rects, local.quickClaims)) return
  local.quickClaims = rects
  scheduleAll()
  changed()
}

const onVisibility = (): void => {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (hidden === hiddenTab) return
  hiddenTab = hidden
  scheduleAll()
}

/** Install once, after state has loaded. Safe to call again. */
export const installPresence = (): void => {
  if (installed) return
  installed = true
  onStateChange(() => {
    reconcile()
    scheduleAll()
  })
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    // A tab that installs while hidden gets no visibility event; read the state now so a hidden
    // tab never publishes before it is looked at.
    hiddenTab = document.visibilityState === 'hidden'
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', reconcile)
    window.addEventListener('offline', () => {
      for (const connection of connections.values()) closeConnection(connection)
    })
  }
  reconcile()
}
