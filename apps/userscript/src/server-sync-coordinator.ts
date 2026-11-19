import {
  type LiveProjectionResource,
  type LiveProjectionState,
  MAX_LIVE_PROJECTIONS,
  type ReconciliationReason,
  type SyncTransport,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { mapLimit } from './concurrency.js'
import { warn } from './debug.js'
import {
  isLiveProjectionResource,
  type LiveResourceEvent,
  type LiveSyncEvent,
} from './live-events.js'
import {
  activeDocument,
  attachLiveSyncHost,
  liveCapable,
  liveProtocol,
  probeLiveConnections,
  reconcileLiveConnections,
  serverLiveSyncHealthy,
  suspendLiveConnections,
} from './live-socket.js'
import {
  type ConnectedServer,
  connectedServers,
  isCurrentServerConnection,
  serverConnectionIdentity,
} from './server-connections.js'
import { onStateChange, type ServerConnection } from './settings.js'

/**
 * The one scheduler for every server resource the userscript keeps current: which resource to
 * read for which connection, when, and what a revision from a mutation or a live event means.
 * Live sockets (`live-socket.ts`) carry events in; resources register how to read and apply them.
 */

const INITIAL_POLL_MS = 60_000
const MAX_UNCHANGED_POLL_MS = 5 * 60_000
const JITTER_RANGE_MS = 30_000
const REFRESH_CONCURRENCY = 4
/** A healthy live socket carries changes, so polling falls back to a slow safety net. */
const LIVE_RECOVERY_POLL_MS = 60 * 60_000

/** Every resource the scheduler knows: the live projections, plus template status. */
export type ServerSyncResourceId = LiveProjectionResource | 'telemetry-status'

export interface ServerSyncResult {
  readonly status: 'changed' | 'unchanged' | 'failed' | 'skipped'
  readonly revision?: string
}

interface ServerSyncResource {
  readonly id: ServerSyncResourceId
  /** Stable visibility scope. Null means the resource is not active for this server. */
  readonly scope: (server: ConnectedServer) => string | null
  readonly refresh: (
    server: ConnectedServer,
    reason: ReconciliationReason,
    transport: SyncTransport,
  ) => Promise<ServerSyncResult>
  /** Healthy live transport suppresses interval polling for this resource. */
  readonly live?: boolean
  /** Manifest events invalidate this resource when their exact surface matches its active scope. */
  readonly reconcileOnManifestEvent?: boolean
  /** Apply a snapshot or delta the live socket delivered; false when it could not be applied. */
  readonly applyLiveEvent?: (
    server: ConnectedServer,
    event: LiveResourceEvent,
  ) => boolean | Promise<boolean>
  /**
   * The revision this client already holds for a connection, such as one its probe downloaded.
   * Asked on every state change, before the connection's live socket opens.
   */
  readonly adopt?: (server: ConnectedServer) => string | undefined
}

/** The scope of every world-surface resource. */
export const WORLD_SCOPE = templateSurfaceKey(WORLD_TEMPLATE_SURFACE)

/** Record each revision a resource reports this client already holds for `server`. */
const adoptHeldRevisions = (server: ConnectedServer): void => {
  for (const resource of resources.values()) {
    const revision = resource.adopt?.(server)
    const scope = revision === undefined ? null : resource.scope(server)
    if (revision !== undefined && scope !== null && isCurrentServerConnection(server))
      applyServerSyncRevision(server, scope, resource.id, revision)
  }
}

interface Schedule {
  readonly server: ConnectedServer
  readonly revision?: string
  readonly unchanged: number
  readonly failed: boolean
  readonly dueAt: number
}

interface PendingResourceRequest {
  allReason?: ReconciliationReason
  readonly servers: Map<object, ReconciliationReason>
}

const resources = new Map<ServerSyncResourceId, ServerSyncResource>()
const schedules = new Map<string, Schedule>()
const running = new WeakMap<object, Map<string, Promise<void>>>()
const pendingLiveRevisions = new WeakMap<object, Map<string, number>>()
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null
let sweepRun: Promise<void> | null = null
let requestedResources: Map<ServerSyncResourceId, PendingResourceRequest> | null = new Map()

const scheduleKey = (server: ConnectedServer, scope: string, resource: string): string =>
  `${server.url}\u0000${server.season}\u0000${scope}\u0000${resource}`

const scheduleFor = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
): Schedule | undefined => {
  const schedule = schedules.get(scheduleKey(server, scope, resource))
  return schedule !== undefined &&
    serverConnectionIdentity(schedule.server) === serverConnectionIdentity(server)
    ? schedule
    : undefined
}

/** v2 sockets push this resource's changes themselves, so it is never polled while healthy. */
const socketOnly = (server: ConnectedServer, resource: ServerSyncResource): boolean =>
  liveProtocol(server)?.pushesSnapshots === true && resource.live === true

/** Terminal unchanged cadence is never below five minutes; jitter only spreads it later. */
const adaptiveServerSyncDelay = (unchanged: number, jitter = Math.random()): number => {
  const base = Math.min(INITIAL_POLL_MS * 2 ** Math.max(0, unchanged), MAX_UNCHANGED_POLL_MS)
  const spread = Math.min(JITTER_RANGE_MS, Math.floor(base / 10))
  return base + Math.floor(Math.max(0, Math.min(1, jitter)) * spread)
}

const clearTimer = (): void => {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

const armTimer = (): void => {
  clearTimer()
  if (!installed || !activeDocument() || sweepRun !== null) return
  let next = Number.POSITIVE_INFINITY
  for (const schedule of schedules.values()) {
    if (!isCurrentServerConnection(schedule.server)) continue
    next = Math.min(next, schedule.dueAt)
  }
  if (requestedResources !== null || next !== Number.POSITIVE_INFINITY) {
    const delay = requestedResources !== null ? 0 : Math.max(0, next - Date.now())
    timer = setTimeout(runRequestedSweep, delay)
  }
}

const applyResult = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
  result: ServerSyncResult,
): void => {
  if (!isCurrentServerConnection(server) || result.status === 'skipped') return
  const previous = scheduleFor(server, scope, resource)
  const revisionChanged = result.revision !== undefined && result.revision !== previous?.revision
  const changed = result.status === 'changed' || revisionChanged
  const unchanged = result.status === 'failed' || changed ? 0 : (previous?.unchanged ?? 0) + 1
  const delay =
    result.status !== 'failed' &&
    resources.get(resource)?.live === true &&
    serverLiveSyncHealthy(server)
      ? LIVE_RECOVERY_POLL_MS
      : adaptiveServerSyncDelay(unchanged)
  const revision = result.revision ?? previous?.revision
  schedules.set(scheduleKey(server, scope, resource), {
    server,
    ...(revision === undefined ? {} : { revision }),
    unchanged,
    failed: result.status === 'failed',
    dueAt: Date.now() + delay,
  })
}

const deferHealthyLiveSchedules = (server: ConnectedServer): void => {
  const now = Date.now()
  for (const resource of resources.values()) {
    if (resource.live !== true) continue
    const scope = resource.scope(server)
    if (scope === null) continue
    const schedule = scheduleFor(server, scope, resource.id)
    if (schedule === undefined || schedule.failed) continue
    schedules.set(scheduleKey(server, scope, resource.id), {
      ...schedule,
      dueAt: Math.max(schedule.dueAt, now + LIVE_RECOVERY_POLL_MS),
    })
  }
}

const runResource = async (
  resource: ServerSyncResource,
  server: ConnectedServer,
  scope: string,
  reason: ReconciliationReason,
): Promise<void> => {
  const key = scheduleKey(server, scope, resource.id)
  const owner = serverConnectionIdentity(server)
  let owned = running.get(owner)
  if (owned === undefined) {
    owned = new Map()
    running.set(owner, owned)
  }
  const pending = owned.get(key)
  if (pending !== undefined) return pending
  const started = resource
    .refresh(
      server,
      reason,
      resource.live === true && serverLiveSyncHealthy(server) ? 'recovery' : 'compatibility-poll',
    )
    .then((result) => applyResult(server, scope, resource.id, result))
    .catch((error: unknown) => {
      warn(`server sync of ${resource.id} failed`, String(error))
      applyResult(server, scope, resource.id, { status: 'failed' })
    })
    .finally(() => {
      if (owned?.get(key) === started) owned.delete(key)
      finishPendingLiveRevision(server, scope, resource.id)
    })
  owned.set(key, started)
  return started
}

const sweep = async (
  requested: ReadonlyMap<ServerSyncResourceId, PendingResourceRequest> | null,
): Promise<void> => {
  if (!activeDocument()) return
  const now = Date.now()
  const work: Array<() => Promise<void>> = []
  const liveKeys = new Set<string>()
  for (const server of connectedServers()) {
    for (const resource of resources.values()) {
      const scope = resource.scope(server)
      if (scope === null) continue
      liveKeys.add(scheduleKey(server, scope, resource.id))
      const explicit = requested?.get(resource.id)
      const targeted = explicit?.servers.get(serverConnectionIdentity(server))
      const asked = explicit?.allReason !== undefined || targeted !== undefined
      if (!asked && (socketOnly(server, resource) || requested !== null)) continue
      const scheduled = scheduleFor(server, scope, resource.id)
      if (requested === null && scheduled !== undefined && scheduled.dueAt > now) continue
      const reason = targeted ?? explicit?.allReason ?? 'interval'
      work.push(() =>
        isCurrentServerConnection(server)
          ? runResource(resource, server, scope, reason)
          : Promise.resolve(),
      )
    }
  }
  for (const key of schedules.keys()) if (!liveKeys.has(key)) schedules.delete(key)
  await mapLimit(work, REFRESH_CONCURRENCY, (run) => run())
}

function runRequestedSweep(): void {
  timer = null
  if (sweepRun !== null) return
  sweepRun = (async () => {
    let first = true
    while (activeDocument() && (first || requestedResources !== null)) {
      first = false
      const requested = requestedResources
      requestedResources = null
      await sweep(requested)
    }
  })().finally(() => {
    sweepRun = null
    armTimer()
  })
}

/** Coalesce event bursts into one bounded active-document refresh. */
export const requestServerSync = (
  reason: ReconciliationReason,
  resource?: ServerSyncResourceId,
  server?: ServerConnection,
): void => {
  requestedResources ??= new Map()
  for (const id of resource === undefined ? resources.keys() : [resource]) {
    const pending: PendingResourceRequest = requestedResources.get(id) ?? { servers: new Map() }
    if (server === undefined) pending.allReason = reason
    else pending.servers.set(serverConnectionIdentity(server), reason)
    requestedResources.set(id, pending)
  }
  armTimer()
}

const requestLiveServerSync = (reason: ReconciliationReason, server: ConnectedServer): void => {
  for (const resource of resources.values()) {
    if (resource.live === true) requestServerSync(reason, resource.id, server)
  }
}

const requestAvailableServerSync = (
  reason: ReconciliationReason,
  onlyResource?: ServerSyncResourceId,
): void => {
  const now = Date.now()
  for (const server of connectedServers()) {
    for (const resource of resources.values()) {
      if (onlyResource !== undefined && resource.id !== onlyResource) continue
      if (socketOnly(server, resource)) continue
      if (resource.live === true && liveCapable(server) && !serverLiveSyncHealthy(server)) continue
      // A connection that already holds a current answer keeps its own cadence. Another server
      // connecting, or this one adopting its probe's manifest, is no reason to read it again.
      const scope = resource.scope(server)
      const schedule = scope === null ? undefined : scheduleFor(server, scope, resource.id)
      if (schedule !== undefined && !schedule.failed && schedule.dueAt > now) continue
      requestServerSync(reason, resource.id, server)
    }
  }
  armTimer()
}

/**
 * Register a consumer without giving it a timer of its own. Registering before or after the
 * scheduler installs is the same: a late resource is read for every connection straight away.
 */
export const registerServerSyncResource = (resource: ServerSyncResource): void => {
  if (resources.has(resource.id)) throw new Error(`duplicate server sync resource: ${resource.id}`)
  resources.set(resource.id, resource)
  if (installed) requestAvailableServerSync('connect', resource.id)
}

/** Apply a revision carried by an authoritative response without rereading the same resource. */
export const applyServerSyncRevision = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
  revision: string,
): void => {
  applyResult(server, scope, resource, { status: 'unchanged', revision })
  armTimer()
}

type ServerSyncDeltaOutcome = 'applied' | 'duplicate' | 'reconcile' | 'stale-connection'

export const serverSyncRevision = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
): string | undefined => scheduleFor(server, scope, resource)?.revision

const revisionNumber = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
): number | null => {
  const revision = Number(serverSyncRevision(server, scope, resource))
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}

/** Read `resource` once the server says it reached `revision`, after any read already running. */
const requestLiveRevision = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
  revision: number,
): void => {
  const current = revisionNumber(server, scope, resource)
  if (current !== null && current >= revision) return
  const owner = serverConnectionIdentity(server)
  const key = scheduleKey(server, scope, resource)
  if (running.get(owner)?.has(key) === true) {
    let pending = pendingLiveRevisions.get(owner)
    if (pending === undefined) {
      pending = new Map()
      pendingLiveRevisions.set(owner, pending)
    }
    pending.set(key, Math.max(revision, pending.get(key) ?? -1))
    return
  }
  requestServerSync('revision-gap', resource, server)
}

const finishPendingLiveRevision = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
): void => {
  const owner = serverConnectionIdentity(server)
  const key = scheduleKey(server, scope, resource)
  const pending = pendingLiveRevisions.get(owner)
  const expected = pending?.get(key)
  if (expected === undefined) return
  pending?.delete(key)
  if (pending?.size === 0) pendingLiveRevisions.delete(owner)
  if (!isCurrentServerConnection(server)) return
  const current = revisionNumber(server, scope, resource)
  if (current === null || current < expected) requestServerSync('revision-gap', resource, server)
}

/**
 * Apply a full read only if no response-driven delta advanced the resource while it was in flight.
 * Applying a result here also records it, so the resource's refresh answers `skipped`.
 */
export const applyServerSyncSnapshot = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
  startedRevision: string | undefined,
  result: ServerSyncResult,
  apply: () => void,
): 'applied' | 'stale' | 'stale-connection' => {
  if (!isCurrentServerConnection(server)) return 'stale-connection'
  if (serverSyncRevision(server, scope, resource) !== startedRevision) return 'stale'
  apply()
  applyResult(server, scope, resource, result)
  armTimer()
  return 'applied'
}

/**
 * Apply one ordered authoritative delta. Exact base matching makes duplicate, stale, and
 * out-of-order mutation responses harmless; a gap schedules one bounded reconciliation.
 */
export const applyServerSyncDelta = (
  server: ConnectedServer,
  scope: string,
  resource: ServerSyncResourceId,
  baseRevision: string,
  revision: string,
  apply: () => void,
): ServerSyncDeltaOutcome => {
  if (!isCurrentServerConnection(server)) return 'stale-connection'
  const current = serverSyncRevision(server, scope, resource)
  if (current === revision) return 'duplicate'
  if (current === undefined || current !== baseRevision) {
    requestServerSync('revision-gap', resource, server)
    return 'reconcile'
  }
  try {
    apply()
  } catch (error) {
    warn(`could not apply a ${resource} delta`, String(error))
    requestServerSync('revision-gap', resource, server)
    return 'reconcile'
  }
  applyResult(server, scope, resource, { status: 'changed', revision })
  armTimer()
  return 'applied'
}

/** The versions this client holds, which a live socket sends when it opens. */
const stateVector = (server: ConnectedServer) => ({
  revision: revisionNumber(server, WORLD_SCOPE, 'telemetry-status'),
  projections: [...resources.values()]
    .flatMap((resource): LiveProjectionState[] => {
      if (resource.live !== true || !isLiveProjectionResource(resource.id)) return []
      const scope = resource.scope(server)
      if (scope === null) return []
      return [
        {
          resource: resource.id,
          scope,
          version: serverSyncRevision(server, scope, resource.id) ?? null,
        },
      ]
    })
    .slice(0, MAX_LIVE_PROJECTIONS),
})

/** A v1 server answered the state vector: read whatever it says this client is missing. */
const correctState = (
  server: ConnectedServer,
  event: Extract<LiveSyncEvent, { readonly type: 'state-correction' }>,
): void => {
  const currentRevision = revisionNumber(server, WORLD_SCOPE, 'telemetry-status')
  if (
    currentRevision === null ||
    currentRevision < event.revision ||
    (event.mode === 'snapshot' && currentRevision === event.revision)
  )
    requestServerSync('reconnect', 'telemetry-status', server)
  for (const projection of event.projections) {
    const resource = resources.get(projection.resource)
    if (resource?.live !== true || resource.scope(server) !== projection.scope) continue
    const current = serverSyncRevision(server, projection.scope, projection.resource)
    if (event.mode === 'snapshot' || projection.version === null || current !== projection.version)
      requestServerSync('reconnect', projection.resource, server)
  }
}

const resourceFor = (event: LiveResourceEvent): ServerSyncResourceId =>
  event.type === 'manifest-snapshot'
    ? event.resource
    : event.type === 'alarms-snapshot'
      ? 'telemetry-alarms'
      : 'telemetry-status'

/** What a live event means for the registered resources. */
const applyLiveEvent = async (server: ConnectedServer, event: LiveSyncEvent): Promise<boolean> => {
  switch (event.type) {
    case 'state-correction':
      correctState(server, event)
      return true
    case 'manifest-reconcile': {
      const scope = event.surface === null ? null : templateSurfaceKey(event.surface)
      for (const resource of resources.values())
        if (
          resource.reconcileOnManifestEvent === true &&
          (scope === null || resource.scope(server) === scope)
        )
          requestServerSync('revision-gap', resource.id, server)
      return true
    }
    case 'alarms-reconcile':
      requestServerSync('revision-gap', 'telemetry-alarms', server)
      return true
    case 'ready':
    case 'status-reconcile':
      requestLiveRevision(server, WORLD_SCOPE, 'telemetry-status', event.revision)
      return true
    default:
      return (await resources.get(resourceFor(event))?.applyLiveEvent?.(server, event)) ?? false
  }
}

const recover = (reason: 'focus' | 'online'): void => {
  if (!activeDocument()) {
    clearTimer()
    return
  }
  const connected = connectedServers()
  reconcileLiveConnections(connected)
  probeLiveConnections(connected)
  for (const server of connected) {
    for (const resource of resources.values()) {
      if (socketOnly(server, resource)) continue
      if (resource.live === true && serverLiveSyncHealthy(server)) continue
      requestServerSync(reason, resource.id, server)
    }
  }
  armTimer()
}

/** Start the scheduler and the live sockets it reads through. */
export const installServerSyncCoordinator = (): void => {
  if (installed) return
  installed = true
  attachLiveSyncHost({
    stateVector,
    statusRevision: (server) => serverSyncRevision(server, WORLD_SCOPE, 'telemetry-status'),
    apply: applyLiveEvent,
    requestReads: (server, reason, resource) =>
      resource === undefined
        ? requestLiveServerSync(reason, server)
        : requestServerSync(reason, resource, server),
    reconciled: deferHealthyLiveSchedules,
    changed: armTimer,
  })
  let previousConnections = connectedServers()
  onStateChange(() => {
    const next = connectedServers()
    // Before any socket opens, so its state vector names what this client already holds.
    for (const server of next) adoptHeldRevisions(server)
    const changed =
      next.length !== previousConnections.length ||
      next.some((server) => {
        const previous = previousConnections.find(
          (held) => held.url === server.url && isCurrentServerConnection(held),
        )
        return previous === undefined || liveCapable(previous) !== liveCapable(server)
      })
    previousConnections = next
    if (changed) {
      reconcileLiveConnections(next)
      requestAvailableServerSync('state-change')
    }
  })
  document.addEventListener('visibilitychange', () => recover('focus'))
  window.addEventListener('focus', () => recover('focus'))
  window.addEventListener('online', () => recover('online'))
  window.addEventListener('offline', () => {
    clearTimer()
    suspendLiveConnections()
  })
  reconcileLiveConnections(connectedServers())
  requestAvailableServerSync('connect')
}
