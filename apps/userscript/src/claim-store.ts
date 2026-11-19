import {
  type RegionClaim,
  reuseDocument,
  sameTemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { notifyListeners } from './listeners.js'
import { pollRegionSnapshots } from './region-api.js'
import { activeServerToken, serverConnectionIdentity } from './server-connections.js'
import type { ServerConnection } from './settings.js'

/**
 * Each presence server's region claims, as the server last reported them.
 *
 * The presence socket feeds a server's claims while its session is live. Otherwise the store reads
 * them from the HTTP snapshot poll, so persisted claims stay readable when admission limits or
 * network failures prevent a socket.
 */

interface ServerClaims {
  readonly server: ServerConnection
  regions: readonly RegionClaim[]
  /** Bumped on every full report; 0 until the first one arrives. */
  revision: number
  ownedRegionIds: readonly string[]
  canWrite: boolean
  /** The socket carries this server's claims, so snapshots are not read. */
  live: boolean
  stopPoll: (() => void) | null
}

const tracked = new Map<object, ServerClaims>()
const listeners: (() => void)[] = []

const entryFor = (server: ServerConnection): ServerClaims | undefined =>
  tracked.get(serverConnectionIdentity(server))

const changed = (): void => notifyListeners(listeners, 'claims listener failed')

/** Runs after any server's claims change. */
export const onClaimsChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** This server's claims, keeping held objects where nothing changed so their caches survive. */
const received = (entry: ServerClaims, incoming: readonly RegionClaim[]): RegionClaim[] => {
  const previous = new Map(entry.regions.map((region) => [region.id, region]))
  return incoming
    .filter(
      (region) =>
        region.season === entry.server.season &&
        sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE),
    )
    .map((region) => reuseDocument(previous.get(region.id), region))
}

const apply = (
  entry: ServerClaims,
  regions: readonly RegionClaim[],
  ownedRegionIds: readonly string[] | undefined,
): void => {
  entry.regions = received(entry, regions)
  entry.revision++
  entry.ownedRegionIds = ownedRegionIds ?? []
}

const stopPolling = (entry: ServerClaims): void => {
  entry.stopPoll?.()
  entry.stopPoll = null
}

/** Hold claims for a presence server. Safe to call again. */
export const trackClaims = (server: ServerConnection): void => {
  const owner = serverConnectionIdentity(server)
  if (tracked.has(owner)) return
  tracked.set(owner, {
    server,
    regions: [],
    revision: 0,
    ownedRegionIds: [],
    canWrite: false,
    live: false,
    stopPoll: null,
  })
}

/** Drop a server's claims and stop reading them. Listeners hear of it with the presence change. */
export const untrackClaims = (server: ServerConnection): void => {
  const entry = entryFor(server)
  if (entry === undefined) return
  stopPolling(entry)
  tracked.delete(serverConnectionIdentity(server))
}

/** A socket session began with this full report; the socket feeds the claims from now on. */
export const receiveLiveClaims = (
  server: ServerConnection,
  regions: readonly RegionClaim[],
  ownedRegionIds: readonly string[] | undefined,
  canWrite: boolean,
): void => {
  const entry = entryFor(server)
  if (entry === undefined) return
  entry.live = true
  apply(entry, regions, ownedRegionIds)
  entry.canWrite = canWrite
  stopPolling(entry)
  changed()
}

/** A full report on a live socket. */
export const receiveClaims = (
  server: ServerConnection,
  regions: readonly RegionClaim[],
  ownedRegionIds: readonly string[] | undefined,
): void => {
  const entry = entryFor(server)
  if (entry === undefined) return
  apply(entry, regions, ownedRegionIds)
  changed()
}

/** The server extended these claims to `expiresAt`. */
export const renewClaims = (
  server: ServerConnection,
  ids: readonly string[],
  expiresAt: number,
): void => {
  const entry = entryFor(server)
  if (entry === undefined) return
  const renewed = new Set(ids)
  entry.regions = entry.regions.map((region) =>
    renewed.has(region.id) ? { ...region, expiresAt } : region,
  )
  changed()
}

/** The socket session ended: nothing feeds the claims until a poll or a new session does. */
export const endLiveClaims = (server: ServerConnection): void => {
  const entry = entryFor(server)
  if (entry === undefined) return
  entry.live = false
  stopPolling(entry)
}

/** Read claims over HTTP while this server has no live session. Safe to call again. */
export const pollClaims = (server: ServerConnection): void => {
  const entry = entryFor(server)
  if (entry === undefined || entry.live || entry.stopPoll !== null) return
  entry.stopPoll = pollRegionSnapshots(entry.server, (snapshot) => {
    if (entry.live) return
    apply(entry, snapshot.regions, snapshot.ownedRegionIds)
    entry.canWrite = snapshot.canWrite
    changed()
  })
}

/**
 * Every connected server supporting presence, reconnecting ones included: presence-client tracks
 * claims for exactly the servers it holds a connection for.
 */
export const claimServers = (): readonly ServerConnection[] =>
  [...tracked.values()].map((entry) => entry.server)

/** Raw copies and handshake state for claim reconciliation. */
export const serverClaims = (
  server: ServerConnection,
): {
  readonly ready: boolean
  readonly regions: readonly RegionClaim[]
  readonly revision: number
  readonly ownedRegionIds: readonly string[]
} => {
  const entry = entryFor(server)
  return {
    ready: (entry?.revision ?? 0) > 0,
    regions: entry?.regions ?? [],
    revision: entry?.revision ?? 0,
    ownedRegionIds: entry?.ownedRegionIds ?? [],
  }
}

/** Claims require report/admin capability from an authenticated server snapshot. */
export const canWriteClaims = (server: ServerConnection): boolean =>
  activeServerToken(server) !== null && entryFor(server)?.canWrite === true
