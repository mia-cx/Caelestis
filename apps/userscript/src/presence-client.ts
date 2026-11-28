import {
  type CaptureClientEvent,
  type CaptureRun,
  decodePresenceServerEvent,
  isEventServer,
  liveCredentialProtocol,
  MAX_PRESENCE_MESSAGES_PER_SECOND,
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
  sameRect,
  type TerritoryTeam,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import {
  endLiveClaims,
  onClaimsChange,
  pollClaims,
  receiveClaims,
  receiveLiveClaims,
  renewClaims,
  serverClaims,
  trackClaims,
  untrackClaims,
} from './claim-store.js'
import { userscriptVersion } from './client-metrics.js'
import { log, warn } from './debug.js'
import { notifyListeners } from './listeners.js'
import { liveClientId } from './live-identity.js'
import {
  isProfileEnabled,
  measureProfile,
  measureProfileDetail,
  recordProfileCounter,
  recordProfileMessage,
  recordProfileWorkload,
} from './profile.js'
import {
  activeServerToken,
  isCurrentServerConnection,
  serverConnectionIdentity,
} from './server-connections.js'
import { serverEndpoint } from './server-request.js'
import { getState, onStateChange, type ServerConnection } from './settings.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

/**
 * One throttled socket per compatible server. Each may have a distinct audience.
 * Viewports and drafts retain their existing cadence and server-side nearby filtering.
 * A random tab publisher ID identifies copies without sharing credential admission IDs.
 *
 * The socket publishes what it is given (`setPresenceViewport`, `setPresenceDraft`,
 * `setPresenceQuickClaims`), holds the peers the server reports, and feeds its claims to
 * `claim-store`, which polls snapshots while a server has no session.
 */

const MAX_RECONNECT_MS = 30_000
const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_JITTER_MS = 500
/** Round trips per clock sync, and the gap between them: under the server's message rate limit. */
const CLOCK_PINGS = 6
const CLOCK_PING_GAP_MS = 250
/** The server's rate window, and the share of its limit this tab uses: one short, for headroom. */
const RATE_WINDOW_MS = 1_000
const SEND_BUDGET = MAX_PRESENCE_MESSAGES_PER_SECOND - 1
/** The shortest time between two sync bursts on one socket. */
const CLOCK_RESYNC_MS = CLOCK_PINGS * CLOCK_PING_GAP_MS + 1_000

/**
 * This tab's clock for capture timing: wall time at page load plus monotonic time since, so a
 * system clock change mid-countdown cannot move it.
 */
export const localClock = (): number => performance.timeOrigin + performance.now()

/** What was last sent on a socket. `undefined` means nothing yet; a new session has no quick claims. */
interface Sent {
  viewport: PresenceRect | null | undefined
  draft: PresenceDraft | null | undefined
  quickClaims: readonly PresenceRect[]
  /** The event team last reported to an event server. */
  team: TerritoryTeam | null
  viewportAt: number
  draftAt: number
  quickClaimsAt: number
}

const nothingSent = (): Sent => ({
  viewport: undefined,
  draft: undefined,
  quickClaims: [],
  team: null,
  viewportAt: Number.NEGATIVE_INFINITY,
  draftAt: Number.NEGATIVE_INFINITY,
  quickClaimsAt: Number.NEGATIVE_INFINITY,
})

/** The server clock against this tab's monotonic clock, from the quickest `clock` round trip. */
interface ClockSample {
  /** Server time minus local time, in milliseconds. */
  readonly offset: number
  readonly rtt: number
}

interface Connection {
  readonly server: ServerConnection
  socket: WebSocket | null
  sessionId: string | null
  peers: Map<string, PresencePeer>
  /** The capture lobbies of this painter's team, as the server last sent them. */
  captures: readonly CaptureRun[]
  /** Whether the server lets this socket's credential write, as its ready event said. */
  canWrite: boolean
  clock: ClockSample | null
  /** When the last clock sync burst started, so callers may ask as often as they like. */
  clockSyncAt: number
  /** When each message of the last second went, for the shared send budget. */
  sentAt: number[]
  /** Capture and clock messages waiting for budget, in order. */
  outbox: (() => PresenceClientEvent)[]
  outboxTimer: ReturnType<typeof setTimeout> | null
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
  /** This painter's event team, which event servers share presence and capture runs within. */
  team: TerritoryTeam | null
} = { viewport: null, draft: null, quickClaims: [], team: null }

const changed = (): void => {
  revision++
  notifyListeners(listeners, 'presence listener failed')
}

/** Runs after any peer, region, or connection change. */
export const onPresenceChange = (listener: () => void): void => {
  listeners.push(listener)
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

/** Messages sent in the last second, pruned; what the server's rate limit counts. */
const recentSends = (connection: Connection, at = Date.now()): number[] => {
  connection.sentAt = connection.sentAt.filter((sent) => at - sent < RATE_WINDOW_MS)
  return connection.sentAt
}

/** Milliseconds until the socket may send again: zero while it is under its budget. */
const sendWait = (connection: Connection): number => {
  const at = Date.now()
  const recent = recentSends(connection, at)
  return recent.length < SEND_BUDGET ? 0 : (recent[0] as number) + RATE_WINDOW_MS - at
}

/**
 * Send one event if the socket has budget for it. The server closes a socket past its message
 * rate, and timers held back by a long task fire together, so every message counts against one
 * budget; a caller told no tries again later.
 */
const send = (connection: Connection, event: PresenceClientEvent): boolean => {
  const socket = connection.socket
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  if (sendWait(connection) > 0) return false
  connection.sentAt.push(Date.now())
  try {
    measureProfile('Presence send', () => {
      const payload = JSON.stringify(event)
      socket.send(payload)
      recordProfileMessage('Presence sent', payload)
    })
  } catch (error) {
    warn('presence send failed', String(error))
    return false
  }
  armHeartbeat(connection)
  return true
}

const armHeartbeat = (connection: Connection): void => {
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  connection.heartbeatTimer = setTimeout(() => {
    connection.heartbeatTimer = null
    // The full state goes with the heartbeat, so a server that hibernated and lost this session's
    // draft mask gets it back without any extra message.
    const draft = canPublish() ? (connection.sent.draft ?? null) : null
    const sent =
      draft === null
        ? send(connection, { type: 'presence-heartbeat' })
        : send(connection, {
            type: 'presence-update',
            viewport: connection.sent.viewport ?? null,
            draft,
          })
    if (!sent && isOpen(connection))
      connection.heartbeatTimer = setTimeout(() => armHeartbeat(connection), sendWait(connection))
  }, PRESENCE_HEARTBEAT_MS)
}

/**
 * Queue a capture or clock message, built when it actually goes so a clock ping carries its true
 * send time, and drain the queue as the budget allows.
 */
const enqueue = (connection: Connection, build: () => PresenceClientEvent): void => {
  connection.outbox.push(build)
  drain(connection)
}

const drain = (connection: Connection): void => {
  if (connection.outboxTimer !== null) return
  while (connection.outbox.length > 0 && isOpen(connection)) {
    const next = connection.outbox[0] as () => PresenceClientEvent
    if (!send(connection, next())) break
    connection.outbox.shift()
  }
  if (connection.outbox.length === 0 || !isOpen(connection)) return
  connection.outboxTimer = setTimeout(() => {
    connection.outboxTimer = null
    drain(connection)
  }, sendWait(connection))
}

/** What this tab is willing to publish to `connection` right now: the local state, or nothing. */
const effective = (connection: Connection): typeof local => ({
  ...(canPublish() ? local : { viewport: null, draft: null }),
  // A hidden tab is still painting; its quick claims end with the paint session or the tab.
  // An event server takes none.
  quickClaims:
    getState().sharePresence && !isEventServer(connection.server.info) ? local.quickClaims : [],
  // The team is no presence of its own: a hidden tab still needs its team's capture lobbies.
  team: local.team,
})

/**
 * Per channel: what to publish, whether it differs from what was sent, and how long until it may
 * go. Clearing never waits, so peers lose a stale rect straight away; quick claims coalesce,
 * clears included, so a burst of rectangles sends only the latest list and stays under the
 * server's per-second limit.
 */
const channels = (connection: Connection, at: number) => {
  const { viewport, draft, quickClaims, team } = effective(connection)
  const { sent } = connection
  return {
    // Only an event server routes by team; others are never told it.
    team: {
      value: team,
      dirty: team !== null && team !== sent.team && isEventServer(connection.server.info),
      wait: 0,
    },
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
  const { viewport, draft, quickClaims, team } = channels(connection, at)
  const sendViewport = viewport.dirty && viewport.wait === 0
  const sendDraft = draft.dirty && draft.wait === 0
  const sendQuickClaims = quickClaims.dirty && quickClaims.wait === 0
  const sendTeam = team.dirty
  const due = sendViewport || sendDraft || sendQuickClaims || sendTeam
  if (due && sendWait(connection) > 0) {
    // Over budget for this second: the same changes go as soon as there is room.
    connection.flushTimer = setTimeout(() => flush(connection), sendWait(connection))
    return
  }
  if (
    due &&
    send(connection, {
      type: 'presence-update',
      ...(sendViewport ? { viewport: viewport.value } : {}),
      ...(sendDraft ? { draft: draft.value } : {}),
      ...(sendQuickClaims ? { quickClaims: quickClaims.value } : {}),
      ...(sendTeam && team.value !== null ? { team: team.value } : {}),
    })
  ) {
    const { sent } = connection
    if (sendTeam) sent.team = team.value
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

const receivePeer = (connection: Connection, peer: PresencePeer): void => {
  receivedOrder.set(peer, ++receivedSequence)
  connection.peers.set(peer.sessionId, peer)
}

/**
 * Apply one server event. True when it changed the claims, whose store has then told every
 * listener already.
 */
const applyServerEvent = (connection: Connection, event: PresenceServerEvent): boolean => {
  const { server } = connection
  switch (event.type) {
    case 'presence-ready':
      connection.sessionId = event.sessionId
      // A server that completes the handshake and then misbehaves keeps its backoff; only a
      // healthy exchange resets it.
      connection.attempts = 0
      connection.peers = new Map()
      connection.canWrite = event.canWrite === true
      for (const peer of event.peers) receivePeer(connection, peer)
      receiveLiveClaims(server, event.regions, event.ownedRegionIds, event.canWrite === true)
      return true
    case 'presence-delta':
      for (const id of event.remove) connection.peers.delete(id)
      for (const peer of event.upsert) receivePeer(connection, peer)
      return false
    case 'regions':
      receiveClaims(server, event.regions, event.ownedRegionIds)
      return true
    case 'claims-renewed':
      renewClaims(server, event.ids, event.expiresAt)
      return true
    case 'capture-runs':
      connection.captures = event.runs
      return false
    case 'clock': {
      // The server answered halfway through the round trip, as near as one trip can tell; the
      // quickest trip bounds that error tightest, so it alone is kept.
      const rtt = localClock() - event.sent
      if (rtt < 0 || (connection.clock !== null && rtt >= connection.clock.rtt)) return false
      connection.clock = { offset: event.at - (event.sent + rtt / 2), rtt }
      return false
    }
  }
}

const clearTimers = (connection: Connection): void => {
  if (connection.outboxTimer !== null) clearTimeout(connection.outboxTimer)
  connection.outboxTimer = null
  connection.outbox = []
  if (connection.reconnectTimer !== null) clearTimeout(connection.reconnectTimer)
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.flushTimer !== null) clearTimeout(connection.flushTimer)
  connection.reconnectTimer = null
  connection.heartbeatTimer = null
  connection.flushTimer = null
}

const closeConnection = (connection: Connection): void => {
  endLiveClaims(connection.server)
  clearTimers(connection)
  const socket = connection.socket
  connection.socket = null
  connection.sessionId = null
  connection.captures = []
  connection.clock = null
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
  pollClaims(connection.server)
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
  if (!claims) measureProfileDetail('Presence notify', changed)
  if (!isProfileEnabled()) return
  const { regions } = serverClaims(connection.server)
  recordProfileWorkload('Presence peers', connection.peers.size)
  recordProfileWorkload('Presence regions', regions.length)
  recordProfileWorkload(
    'Presence region shapes',
    regions.reduce((sum, region) => sum + region.document.items.length, 0),
  )
  recordProfileWorkload(
    'Presence region bounding pixels',
    regions.reduce((sum, region) => sum + region.rect.w * region.rect.h, 0),
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
  const endpoint = new URL(serverEndpoint(server, '/telemetry/presence'))
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
    warn('presence socket could not open', String(error))
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
    log('presence connected', { server: server.url })
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
    connection.captures = []
    connection.clock = null
    endLiveClaims(server)
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
    // An event server takes no claims.
    if (!isEventServer(server.info)) trackClaims(server)
    connections.set(owner, {
      server,
      socket: null,
      sessionId: null,
      peers: new Map(),
      captures: [],
      canWrite: false,
      clock: null,
      clockSyncAt: Number.NEGATIVE_INFINITY,
      sentAt: [],
      outbox: [],
      outboxTimer: null,
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
    untrackClaims(connection.server)
    connections.delete(owner)
  }
  for (const connection of connections.values()) {
    open(connection)
    pollClaims(connection.server)
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
    for (const region of serverClaims(connection.server).regions) {
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

/** A server's capture lobbies, as one connected socket sees them. */
export interface CaptureView {
  readonly server: ServerConnection
  /** The lobbies of this painter's team. */
  readonly runs: readonly CaptureRun[]
  /** This tab's session on the server, which is how lobbies name it. */
  readonly sessionId: string
  /** Server time minus `localClock()`, once a clock sync has answered. */
  readonly clockOffset: number | null
  /** The round trip that offset was measured over. */
  readonly clockRtt: number | null
  /** Whether this socket may join: its credential can write. */
  readonly canWrite: boolean
}

/** Every open presence socket and the capture lobbies it holds. */
export const captureViews = (): readonly CaptureView[] =>
  [...connections.values()].flatMap((connection) =>
    isOpen(connection) && connection.sessionId !== null
      ? [
          {
            server: connection.server,
            runs: connection.captures,
            sessionId: connection.sessionId,
            clockOffset: connection.clock?.offset ?? null,
            clockRtt: connection.clock?.rtt ?? null,
            canWrite: connection.canWrite,
          },
        ]
      : [],
  )

const connectionFor = (server: ServerConnection): Connection | undefined =>
  [...connections.values()].find((connection) => connection.server.url === server.url)

/** Send a capture event on a server's presence socket. False when it has none open. */
export const sendCapture = (server: ServerConnection, event: CaptureClientEvent): boolean => {
  const connection = connectionFor(server)
  if (connection === undefined || !isOpen(connection)) return false
  // The server acts on the lobbies of the team the session reported, so the team goes first.
  const { team } = local
  if (team !== null && connection.sent.team !== team) {
    connection.sent.team = team
    enqueue(connection, () => ({ type: 'presence-update', team }))
  }
  enqueue(connection, () => event)
  return true
}

/**
 * Measure a server's clock against this tab's with a burst of round trips. Each sample keeps the
 * quickest trip seen on this socket, so later bursts only ever tighten the estimate. A call while
 * a burst is still running, or just after, does nothing: the server closes a socket that sends
 * more than its message rate allows.
 */
export const syncCaptureClock = (server: ServerConnection): void => {
  const connection = connectionFor(server)
  const now = localClock()
  if (connection === undefined || now - connection.clockSyncAt < CLOCK_RESYNC_MS) return
  connection.clockSyncAt = now
  for (let ping = 0; ping < CLOCK_PINGS; ping++)
    setTimeout(() => {
      if (isOpen(connection))
        enqueue(connection, () => ({ type: 'clock', sent: Math.round(localClock()) }))
    }, ping * CLOCK_PING_GAP_MS)
}

/** Whether this tab holds any presence connection, and so has something to publish to. */
export const presenceConnected = (): boolean => connections.size > 0

/** Whether a quick claim reaches anyone: an open session on a server that takes them. */
export const quickClaimsAvailable = (): boolean =>
  [...connections.values()].some(
    (connection) =>
      isOpen(connection) && connection.canWrite && !isEventServer(connection.server.info),
  )

/** Report this painter's event team to event servers, which share presence within a team. */
export const setPresenceTeam = (team: TerritoryTeam | null): void => {
  if (team === local.team) return
  local.team = team
  scheduleAll()
}

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
  // The view merges claims too, so every claim change is a presence change.
  onClaimsChange(changed)
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
