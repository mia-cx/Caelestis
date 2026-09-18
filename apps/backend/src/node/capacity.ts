import { monitorEventLoopDelay } from 'node:perf_hooks'
import { MAX_PRESENCE_SUBSCRIBERS } from '@caelestis/shared'
import { type LiveSocket, MAX_LIVE_SUBSCRIBERS } from '../status-coordinator.js'

export type AdmissionChannel = 'live-sync' | 'presence'
export const ADMISSION_CHANNELS: readonly AdmissionChannel[] = ['live-sync', 'presence']

/** Socket state one pod exposes for scaling decisions. Sockets already carry their attachments. */
export interface CapacityHost {
  getWebSockets(): readonly LiveSocket[]
  readonly pendingWork: number
}
export interface CapacityCoordinator {
  readonly kind: AdmissionChannel
  /** Season for live-sync hosts, `season:surface` for presence rooms. Never a user or token. */
  readonly key: string
  readonly host: CapacityHost
}
export interface CoordinatorCapacity {
  readonly kind: AdmissionChannel
  readonly key: string
  readonly connections: number
  readonly limit: number
}
export interface CapacitySnapshot {
  /** People connected to this pod, counted once across presence, live sync, and extra tabs. */
  readonly users: number
  /** Occupied live-sync slots; the number admission compares with `MAX_LIVE_SUBSCRIBERS`. */
  readonly liveSlots: number
  readonly presenceSlots: number
  /** Socket messages and background work not yet finished by any live host. */
  readonly pendingWork: number
  readonly coordinators: readonly CoordinatorCapacity[]
}

interface IdentityAttachment {
  readonly tokenHash?: unknown
  readonly clientHash?: unknown
  readonly anonymous?: unknown
  readonly closed?: unknown
}

const HASH = /^[0-9a-f]{64}$/

const attachmentOf = (socket: LiveSocket): IdentityAttachment | null => {
  const attachment = socket.deserializeAttachment()
  return typeof attachment === 'object' && attachment !== null
    ? (attachment as IdentityAttachment)
    : null
}

/**
 * Authenticated sockets belong to their credential. Anonymous frontend sockets share the read
 * token, so their client hash (read token plus client id) identifies the browser instead.
 */
export const userKey = (attachment: IdentityAttachment | null): string | null => {
  if (attachment === null) return null
  if (attachment.anonymous === true)
    return typeof attachment.clientHash === 'string' && HASH.test(attachment.clientHash)
      ? `client:${attachment.clientHash}`
      : null
  return typeof attachment.tokenHash === 'string' && HASH.test(attachment.tokenHash)
    ? `token:${attachment.tokenHash}`
    : null
}

/** Count sockets the same way each coordinator's admission check counts them. */
const occupied = (kind: AdmissionChannel, host: CapacityHost): LiveSocket[] =>
  host.getWebSockets().filter((socket) => {
    if (kind === 'live-sync') return true
    return attachmentOf(socket)?.closed !== true && (socket.readyState ?? 1) === 1
  })

export const snapshotCapacity = (
  coordinators: readonly CapacityCoordinator[],
): CapacitySnapshot => {
  const users = new Set<string>()
  let liveSlots = 0
  let presenceSlots = 0
  let pendingWork = 0
  const measured = coordinators.map(({ kind, key, host }) => {
    const sockets = occupied(kind, host)
    for (const socket of sockets) {
      const user = userKey(attachmentOf(socket))
      if (user !== null) users.add(user)
    }
    if (kind === 'live-sync') liveSlots += sockets.length
    else presenceSlots += sockets.length
    pendingWork += host.pendingWork
    return {
      kind,
      key,
      connections: sockets.length,
      limit: kind === 'live-sync' ? MAX_LIVE_SUBSCRIBERS : MAX_PRESENCE_SUBSCRIBERS,
    }
  })
  return { users: users.size, liveSlots, presenceSlots, pendingWork, coordinators: measured }
}

/** Upgrade outcomes per channel. Rejections are capacity refusals, not authentication failures. */
export class AdmissionCounters {
  private readonly admitted = new Map<AdmissionChannel, number>(
    ADMISSION_CHANNELS.map((channel) => [channel, 0]),
  )
  private readonly rejected = new Map<AdmissionChannel, number>(
    ADMISSION_CHANNELS.map((channel) => [channel, 0]),
  )
  record(channel: AdmissionChannel, status: number): void {
    if (status === 200) this.admitted.set(channel, (this.admitted.get(channel) ?? 0) + 1)
    else if (status === 503) this.rejected.set(channel, (this.rejected.get(channel) ?? 0) + 1)
  }
  read(channel: AdmissionChannel): { admitted: number; rejected: number } {
    return { admitted: this.admitted.get(channel) ?? 0, rejected: this.rejected.get(channel) ?? 0 }
  }
}

/** Which admission channel a request path belongs to, or null for ordinary HTTP. */
export const admissionChannel = (pathname: string): AdmissionChannel | null => {
  if (pathname.endsWith('/v1/telemetry/live')) return 'live-sync'
  if (pathname.endsWith('/v1/telemetry/presence')) return 'presence'
  return null
}

/** Event-loop delay since the previous read, in seconds. Zero when nothing was sampled. */
export class EventLoopLag {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 })
  constructor() {
    this.histogram.enable()
  }
  read(): { p99: number; max: number } {
    const count = this.histogram.count
    const lag =
      count > 0
        ? {
            p99: this.histogram.percentile(99) / 1e9,
            max: this.histogram.max / 1e9,
          }
        : { p99: 0, max: 0 }
    this.histogram.reset()
    return {
      p99: Number.isFinite(lag.p99) ? lag.p99 : 0,
      max: Number.isFinite(lag.max) ? lag.max : 0,
    }
  }
  stop(): void {
    this.histogram.disable()
  }
}

const label = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')

/** Render the pod's capacity metrics in the Prometheus text format. */
export const renderCapacityMetrics = (
  snapshot: CapacitySnapshot,
  admissions: AdmissionCounters,
  lag: { p99: number; max: number },
): string => {
  const lines = [
    '# TYPE caelestis_connected_users gauge',
    `caelestis_connected_users ${snapshot.users}`,
    '# TYPE caelestis_live_sync_connections gauge',
    `caelestis_live_sync_connections ${snapshot.liveSlots}`,
    '# TYPE caelestis_presence_connections gauge',
    `caelestis_presence_connections ${snapshot.presenceSlots}`,
    '# TYPE caelestis_live_pending_work gauge',
    `caelestis_live_pending_work ${snapshot.pendingWork}`,
    '# TYPE caelestis_coordinator_connections gauge',
    ...snapshot.coordinators.map(
      (coordinator) =>
        `caelestis_coordinator_connections{kind="${coordinator.kind}",coordinator="${label(coordinator.key)}"} ${coordinator.connections}`,
    ),
    '# TYPE caelestis_coordinator_connection_limit gauge',
    ...snapshot.coordinators.map(
      (coordinator) =>
        `caelestis_coordinator_connection_limit{kind="${coordinator.kind}",coordinator="${label(coordinator.key)}"} ${coordinator.limit}`,
    ),
    '# TYPE caelestis_admissions_total counter',
    ...ADMISSION_CHANNELS.map(
      (channel) =>
        `caelestis_admissions_total{channel="${channel}"} ${admissions.read(channel).admitted}`,
    ),
    '# TYPE caelestis_admission_rejections_total counter',
    ...ADMISSION_CHANNELS.map(
      (channel) =>
        `caelestis_admission_rejections_total{channel="${channel}"} ${admissions.read(channel).rejected}`,
    ),
    '# TYPE caelestis_event_loop_lag_seconds gauge',
    `caelestis_event_loop_lag_seconds{stat="p99"} ${lag.p99}`,
    `caelestis_event_loop_lag_seconds{stat="max"} ${lag.max}`,
  ]
  return `${lines.join('\n')}\n`
}
