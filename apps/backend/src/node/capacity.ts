import { monitorEventLoopDelay } from 'node:perf_hooks'
import { isSha256Hex, MAX_PRESENCE_SUBSCRIBERS } from '@caelestis/shared'
import { type LiveSubscriberAttachment, MAX_LIVE_SUBSCRIBERS } from '../live/session.js'

export type AdmissionChannel = 'live-sync' | 'presence'
export const ADMISSION_CHANNELS: readonly AdmissionChannel[] = ['live-sync', 'presence']

/** The credential fields that name a socket's user. Attachments from older deploys may lack some. */
export type Occupant = Pick<LiveSubscriberAttachment, 'tokenHash' | 'clientHash' | 'anonymous'>

/** One live coordinator's state, as a pod exposes it for scaling decisions. */
export interface CapacityCoordinator {
  readonly kind: AdmissionChannel
  /**
   * Label value; the season for both kinds. Sockets only exist for the configured season, so the
   * label domain stays bounded. Several hosts may share a key and report their fullest member.
   */
  readonly key: string
  /** One per slot the coordinator's admission check counts; null where an attachment does not decode. */
  readonly occupants: readonly (Occupant | null)[]
  /** Socket messages and background work its host has not finished. */
  readonly pendingWork: number
}
export interface CoordinatorCapacity {
  readonly kind: AdmissionChannel
  readonly key: string
  /** Sockets on the fullest host behind this key; admission limits apply per host. */
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

/**
 * Authenticated sockets belong to their credential. Anonymous frontend sockets share the read
 * token, so their client hash (read token plus client id) identifies the browser instead.
 */
const userKey = (occupant: Occupant | null): string | null => {
  if (occupant === null) return null
  if (occupant.anonymous === true)
    return isSha256Hex(occupant.clientHash) ? `client:${occupant.clientHash}` : null
  return isSha256Hex(occupant.tokenHash) ? `token:${occupant.tokenHash}` : null
}

/** `liveSubscriberLimit` is the limit live-sync admission uses, which deployments may override. */
export const snapshotCapacity = (
  coordinators: readonly CapacityCoordinator[],
  liveSubscriberLimit = MAX_LIVE_SUBSCRIBERS,
): CapacitySnapshot => {
  const users = new Set<string>()
  let liveSlots = 0
  let presenceSlots = 0
  let pendingWork = 0
  const measured = new Map<string, CoordinatorCapacity>()
  for (const coordinator of coordinators) {
    const { kind, key, occupants } = coordinator
    for (const occupant of occupants) {
      const user = userKey(occupant)
      if (user !== null) users.add(user)
    }
    if (kind === 'live-sync') liveSlots += occupants.length
    else presenceSlots += occupants.length
    pendingWork += coordinator.pendingWork
    // Kinds never contain a colon, so this key cannot collide across kinds.
    const series = `${kind}:${key}`
    const previous = measured.get(series)?.connections ?? 0
    measured.set(series, {
      kind,
      key,
      connections: Math.max(previous, occupants.length),
      limit: kind === 'live-sync' ? liveSubscriberLimit : MAX_PRESENCE_SUBSCRIBERS,
    })
  }
  return {
    users: users.size,
    liveSlots,
    presenceSlots,
    pendingWork,
    coordinators: [...measured.values()],
  }
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

/**
 * Which admission channel a request path belongs to, or null for ordinary HTTP. The app serves
 * each route at `/v1` and at the unversioned alias, so both count.
 */
export const admissionChannel = (pathname: string): AdmissionChannel | null => {
  if (pathname.endsWith('/telemetry/live')) return 'live-sync'
  if (pathname.endsWith('/telemetry/presence')) return 'presence'
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
