import {
  isRecord,
  MAX_TILE_OFFERS,
  type PainterIdentity,
  type StatusDelta,
  seconds,
  sha256Hex,
  type TileCoord,
  type TileOffer,
  tileKey,
  uuidV7,
} from '@caelestis/shared'
import { count, warn } from './debug.js'
import {
  requestLiveTileOffer,
  requestLiveTileOfferCache,
  requestLiveTileUpload,
  serverLiveSyncHealthy,
  serverLiveSyncVersion,
} from './live-socket.js'
import {
  type ConnectedServer,
  connectedServerAt,
  connectedServers,
  isCurrentServerConnection,
  onServerRemoved,
  serverConnectionIdentity,
} from './server-connections.js'
import { manifestCoverage } from './server-manifests.js'
import { invalidateServerMismatchTiles } from './server-mismatch.js'
import { backgroundRequest, REPORT_REPLY_BYTES } from './server-request.js'
import { applyStatusDelta } from './server-status.js'
import { requestServerSync } from './server-sync-coordinator.js'
import { withRetries } from './server-transport.js'
import { getState } from './settings.js'
import { statusDeltaFrom } from './telemetry-wire.js'
import { TileOfferAcknowledgements } from './tile-offer-acknowledgements.js'
import { accountIdentity, accountIdentityKnownUnavailable, loadAccount } from './wplace-account.js'

/**
 * Offering the Wplace tiles this page fetched to every connected server whose templates cover them.
 *
 * Each observation becomes an offer with a delivery id that stays the same across retries and
 * transports. An offer is unsettled until the server acknowledges or rejects it; unsettled offers
 * wait in a bounded per-connection outbox, sharing tile bytes by hash, and are offered again after
 * a failure. Delivery goes through one of two transport chains — the v2 live socket, or the v1 live
 * cache followed by HTTP — and every transport answers with a per-offer outcome that one
 * settlement applies.
 */

const OFFER_DELAY_MS = 250
/** A failed offer waits this long before it is offered again. */
const OFFER_RETRY_MS = 60_000
const MAX_RECENT_TILES = 32
const MAX_RECENT_TILE_BYTES = 32 * 1_024 * 1_024
const MAX_UNSETTLED_OFFERS_PER_SERVER = MAX_RECENT_TILES + MAX_TILE_OFFERS
const MAX_RETAINED_TILE_BYTES = MAX_RECENT_TILE_BYTES

interface OfferedTile extends TileOffer {
  readonly deliveryId: string
  readonly coord: TileCoord
  readonly bytes: Uint8Array
}

/** What became of one offer. */
type Outcome =
  | 'acknowledged'
  /** Refused for the coverage it was offered against; a changed coverage offers it again. */
  | 'rejected'
  /** Refused outright, and remembered so the same observation is not offered again. */
  | 'refused'
  /** Refused with nothing to remember. */
  | 'dropped'
  /** Failed in a way worth repeating, once the retry delay has passed. */
  | 'retry'
  /** Not sent: the account or the connection was not ready. Kept, and offered again later. */
  | 'deferred'

/**
 * One way of delivering a batch. Answers an outcome per offer it settled — offers it leaves out go
 * to the next transport in the chain — or null when the connection or sharing ended meanwhile.
 */
type Transport = (
  server: ConnectedServer,
  identity: PainterIdentity,
  entries: readonly OfferedTile[],
) => Promise<ReadonlyMap<string, Outcome> | null>

/** One connection's offers that the server has not settled yet. */
interface Outbox {
  readonly server: ConnectedServer
  /** Every unsettled offer, least recently tried first. */
  readonly unsettled: Map<string, OfferedTile>
  /** Offers waiting for the next flush. */
  readonly queued: Map<string, OfferedTile>
  /** Offers sent at least once; only these may be evicted to stay within bounds. */
  readonly attempted: Set<string>
}

const outboxes = new Map<string, Outbox>()
/** Tile bytes shared by every unsettled offer of the same hash. */
const retainedBlobs = new Map<string, { readonly bytes: Uint8Array; refs: number }>()
let retainedBytes = 0
const recentTiles = new Map<string, OfferedTile>()
let recentTileBytes = 0
const flushTimers = new Map<
  string,
  { readonly handle: ReturnType<typeof setTimeout>; readonly retry: boolean }
>()
const flushing = new Set<string>()
/** Servers whose next flush is a retry after a failure. */
const retrying = new Set<string>()
const receipts = new TileOfferAcknowledgements()

const metric = (
  outcome: 'avoided' | 'retried' | 'requested' | 'accepted' | 'rejected',
  by = 1,
): void => count(`telemetry:tile-offers-${outcome}`, by)

const reportError = (error: unknown): void => {
  warn('tile offer failed', String(error))
}

/** The receipt key of a connection: its URL, lifetime and season. */
const receiptOf = (server: ConnectedServer) =>
  [server.url, serverConnectionIdentity(server), server.season] as const

const offerOf = ({ deliveryId, tile, sha256, ts }: OfferedTile) => ({
  deliveryId,
  tile,
  sha256,
  ts,
})

const coversTile = (server: ConnectedServer, tile: string): boolean =>
  manifestCoverage(server)?.tiles.has(tile) === true

const forgetOffer = (serverUrl: string, deliveryId: string): void => {
  const outbox = outboxes.get(serverUrl)
  if (outbox === undefined) return
  outbox.attempted.delete(deliveryId)
  outbox.queued.delete(deliveryId)
  const entry = outbox.unsettled.get(deliveryId)
  if (entry !== undefined) {
    outbox.unsettled.delete(deliveryId)
    const blob = retainedBlobs.get(entry.sha256)
    if (blob !== undefined && --blob.refs === 0) {
      retainedBlobs.delete(entry.sha256)
      retainedBytes -= blob.bytes.byteLength
    }
  }
  if (outbox.unsettled.size === 0 && outbox.queued.size === 0) outboxes.delete(serverUrl)
}

const dropOutbox = (serverUrl: string): void => {
  const outbox = outboxes.get(serverUrl)
  if (outbox === undefined) return
  for (const deliveryId of [...outbox.unsettled.keys()]) forgetOffer(serverUrl, deliveryId)
  outboxes.delete(serverUrl)
}

/** This connection's outbox; one left by an earlier connection to the URL is dropped first. */
const outboxFor = (server: ConnectedServer): Outbox => {
  const existing = outboxes.get(server.url)
  if (
    existing !== undefined &&
    serverConnectionIdentity(existing.server) === serverConnectionIdentity(server) &&
    existing.server.season === server.season
  )
    return existing
  dropOutbox(server.url)
  const created: Outbox = {
    server,
    unsettled: new Map(),
    queued: new Map(),
    attempted: new Set(),
  }
  outboxes.set(server.url, created)
  return created
}

/** Offers this connection holds, if the URL's outbox belongs to it. */
const currentOutbox = (server: ConnectedServer): Outbox | undefined => {
  const outbox = outboxes.get(server.url)
  return outbox !== undefined &&
    serverConnectionIdentity(outbox.server) === serverConnectionIdentity(server) &&
    outbox.server.season === server.season
    ? outbox
    : undefined
}

const clearServer = (serverUrl: string): void => {
  const timer = flushTimers.get(serverUrl)
  if (timer !== undefined) clearTimeout(timer.handle)
  flushTimers.delete(serverUrl)
  dropOutbox(serverUrl)
  retrying.delete(serverUrl)
}

onServerRemoved(clearServer)

const clearAll = (): void => {
  for (const serverUrl of new Set([...flushTimers.keys(), ...outboxes.keys(), ...retrying]))
    clearServer(serverUrl)
}

const evictionCandidate = (
  candidates: Iterable<Outbox>,
): readonly [serverUrl: string, deliveryId: string] | undefined => {
  for (const outbox of candidates)
    for (const deliveryId of outbox.unsettled.keys())
      if (outbox.attempted.has(deliveryId)) return [outbox.server.url, deliveryId]
  return undefined
}

/** Stay within the per-server and shared byte bounds; a first delivery is never the victim. */
const trim = (serverUrl: string): void => {
  const outbox = outboxes.get(serverUrl)
  while (outbox !== undefined && outbox.unsettled.size > MAX_UNSETTLED_OFFERS_PER_SERVER) {
    const eviction = evictionCandidate([outbox])
    if (eviction === undefined) break
    forgetOffer(...eviction)
  }
  while (retainedBytes > MAX_RETAINED_TILE_BYTES) {
    const eviction = evictionCandidate(outboxes.values())
    if (eviction === undefined) break
    forgetOffer(...eviction)
  }
}

const retain = (server: ConnectedServer, entry: OfferedTile, bounded = true): OfferedTile => {
  const outbox = outboxFor(server)
  if (!outbox.unsettled.has(entry.deliveryId)) {
    const blob = retainedBlobs.get(entry.sha256)
    if (blob === undefined) {
      retainedBlobs.set(entry.sha256, { bytes: entry.bytes, refs: 1 })
      retainedBytes += entry.bytes.byteLength
    } else blob.refs++
    outbox.unsettled.set(
      entry.deliveryId,
      blob === undefined ? entry : { ...entry, bytes: blob.bytes },
    )
  }
  if (bounded) trim(server.url)
  return outboxes.get(server.url)?.unsettled.get(entry.deliveryId) ?? entry
}

/** Move an unsettled offer to the back, behind the ones not yet tried as often. */
const rotate = (serverUrl: string, entry: OfferedTile): void => {
  const outbox = outboxes.get(serverUrl)
  if (outbox === undefined || !outbox.unsettled.delete(entry.deliveryId)) return
  outbox.unsettled.set(entry.deliveryId, entry)
}

/** Retry only observations still inside the bounded recent replay window. */
const keepForRetry = (server: ConnectedServer, entry: OfferedTile): void => {
  if (!getState().shareTiles || !isCurrentServerConnection(server)) return
  if (!recentTiles.has(entry.deliveryId)) {
    forgetOffer(server.url, entry.deliveryId)
    return
  }
  if (outboxes.get(server.url)?.unsettled.has(entry.deliveryId)) {
    rotate(server.url, entry)
    return
  }
  // Trimming already removed this active delivery. Restore the bounded recent retry after failure.
  retain(server, entry, false)
}

interface FlushPlan {
  /** Something failed and the unsettled offers are offered again. */
  retry: boolean
  /** ...without waiting for the retry delay. */
  immediately: boolean
}

/** Apply each offer's outcome to the outbox and receipts, the one place settlement happens. */
const settle = (
  server: ConnectedServer,
  entries: readonly OfferedTile[],
  outcomes: ReadonlyMap<string, Outcome>,
  plan: FlushPlan,
): void => {
  let accepted = 0
  let rejected = 0
  for (const entry of entries) {
    const outcome = outcomes.get(entry.deliveryId)
    const key = entry.deliveryId
    switch (outcome) {
      case undefined:
        break
      case 'acknowledged':
        receipts.acknowledged(...receiptOf(server), key)
        forgetOffer(server.url, key)
        accepted++
        break
      case 'rejected':
        rejected++
        // A refusal is definitive only for the current manifest coverage. Suppress hot-loop
        // captures, but offer again when a later manifest changed the covered tile set.
        if (receipts.rejected(...receiptOf(server), key)) forgetOffer(server.url, key)
        else {
          plan.retry = true
          plan.immediately = true
          shareObservedTile(entry)
        }
        break
      case 'refused':
        receipts.rejected(...receiptOf(server), key)
        forgetOffer(server.url, key)
        break
      case 'dropped':
        rejected++
        forgetOffer(server.url, key)
        break
      case 'retry':
        plan.retry = true
        receipts.retryable(...receiptOf(server), key)
        keepForRetry(server, entry)
        break
      case 'deferred':
        plan.retry = true
        plan.immediately = false
        receipts.retryable(...receiptOf(server), key)
        rotate(server.url, entry)
        break
    }
  }
  if (accepted > 0) metric('accepted', accepted)
  if (rejected > 0) metric('rejected', rejected)
}

const allAs = (entries: readonly OfferedTile[], outcome: Outcome): ReadonlyMap<string, Outcome> =>
  new Map(entries.map((entry) => [entry.deliveryId, outcome]))

/** Whether this connection may still settle what it sent. */
const stillSharing = (server: ConnectedServer): boolean =>
  getState().shareTiles && isCurrentServerConnection(server)

/** The v2 socket: offer the batch, then upload each tile the server wants. */
const liveOffers: Transport = async (server, identity, entries) => {
  const offered = await withRetries(
    () =>
      requestLiveTileOffer(server, {
        ...identity,
        season: server.season,
        offers: entries.map(offerOf),
      }),
    (result) => result === null,
  )
  if (offered === null || offered.error !== undefined)
    return allAs(entries, offered === null || offered.error === 'unavailable' ? 'retry' : 'dropped')
  if (!stillSharing(server)) return null
  const offeredIds = new Set(entries.map((entry) => entry.deliveryId))
  const acknowledged = new Set(
    offered.response.acknowledgedDeliveryIds.filter((id) => offeredIds.has(id)),
  )
  const rejected = new Set(offered.response.rejectedDeliveryIds.filter((id) => offeredIds.has(id)))
  const wanted = new Map(
    offered.response.wanted
      .filter(({ deliveryId }) => offeredIds.has(deliveryId))
      .map((item) => [item.deliveryId, item]),
  )
  const complete = entries.every(
    (entry) =>
      Number(acknowledged.has(entry.deliveryId)) +
        Number(rejected.has(entry.deliveryId)) +
        Number(wanted.has(entry.deliveryId)) ===
      1,
  )
  if (!complete) return allAs(entries, 'retry')
  const outcomes = new Map<string, Outcome>()
  for (const entry of entries) {
    if (acknowledged.has(entry.deliveryId)) {
      outcomes.set(entry.deliveryId, 'acknowledged')
      continue
    }
    if (rejected.has(entry.deliveryId)) {
      outcomes.set(entry.deliveryId, 'rejected')
      continue
    }
    const coverageToken = wanted.get(entry.deliveryId)?.coverageToken
    const uploaded = await withRetries(
      () =>
        requestLiveTileUpload(
          server,
          {
            ...identity,
            deliveryId: entry.deliveryId,
            season: server.season,
            tile: entry.tile,
            sha256: entry.sha256,
            ts: entry.ts,
            ...(coverageToken === undefined ? {} : { coverageToken }),
          },
          entry.bytes,
        ),
      (result) => result === null,
    )
    if (uploaded?.accepted === true && uploaded.error === undefined) {
      invalidateServerMismatchTiles(server.url, [entry.coord])
      outcomes.set(entry.deliveryId, 'acknowledged')
    } else
      outcomes.set(
        entry.deliveryId,
        uploaded === null || uploaded.error === 'unavailable' ? 'retry' : 'refused',
      )
  }
  return outcomes
}

/** The v1 socket's cache: settles the offers the server already holds, leaves the rest. */
const liveCache: Transport = async (server, identity, entries) => {
  const live = await requestLiveTileOfferCache(server, {
    ...identity,
    season: server.season,
    offers: entries.map(offerOf),
  })
  if (!stillSharing(server)) return null
  if (live == null || live.error !== undefined) return new Map()
  const offeredIds = new Set(entries.map((entry) => entry.deliveryId))
  const cached = new Set(live.acknowledgedDeliveryIds.filter((id) => offeredIds.has(id)))
  const unresolved = new Set(live.unresolvedDeliveryIds.filter((id) => offeredIds.has(id)))
  const complete = entries.every(
    (entry) =>
      Number(cached.has(entry.deliveryId)) + Number(unresolved.has(entry.deliveryId)) === 1,
  )
  return complete
    ? allAs(
        entries.filter((entry) => cached.has(entry.deliveryId)),
        'acknowledged',
      )
    : new Map()
}

/** A best-effort report, retried on failure, and null when the server could not be reached. */
const telemetryWrite = (
  server: ConnectedServer,
  route: string,
  init: { readonly method: string; readonly headers?: Record<string, string> } & (
    | { readonly json: unknown }
    | { readonly body: BodyInit }
  ),
) => backgroundRequest(server, route, { ...init, maxBytes: REPORT_REPLY_BYTES })

/** The tiles in `value` that were offered, or null when it is not a list. */
const offeredTiles = (value: unknown, offered: ReadonlySet<string>): ReadonlySet<string> | null =>
  Array.isArray(value)
    ? new Set(value.filter((tile): tile is string => typeof tile === 'string' && offered.has(tile)))
    : null

/** Upload the tiles the server wants over HTTP; which uploaded, and whether a reply lacked status. */
const uploadWanted = async (
  server: ConnectedServer,
  identity: PainterIdentity,
  entries: readonly OfferedTile[],
  coverageToken: string | undefined,
): Promise<{ readonly uploaded: ReadonlySet<string>; readonly missingStatus: boolean }> => {
  const uploaded = new Set<string>()
  const deltas: StatusDelta[] = []
  let missingStatus = false
  await Promise.all(
    entries.map(async (entry) => {
      const answer = await telemetryWrite(
        server,
        `/telemetry/tiles/${entry.coord.x}/${entry.coord.y}/${entry.sha256}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'image/png',
            'x-caelestis-season': String(server.season),
            'x-caelestis-observed-at': String(entry.ts),
            'x-caelestis-wplace-user-id': String(identity.wplaceUserId),
            'x-caelestis-display-name': encodeURIComponent(identity.displayName),
            ...(coverageToken === undefined
              ? {}
              : { 'x-caelestis-tile-coverage-token': coverageToken }),
          },
          body: entry.bytes.slice().buffer,
        },
      )
      const response = answer?.response ?? null
      if (response?.ok) {
        uploaded.add(entry.deliveryId)
        invalidateServerMismatchTiles(server.url, [entry.coord])
        const delta = statusDeltaFrom(isRecord(answer?.body) ? answer.body.status : undefined)
        if (delta === null) missingStatus = true
        else deltas.push(delta)
      } else if (response !== null)
        warn('telemetry tile upload was rejected', {
          server: server.url,
          tile: entry.tile,
          status: response.status,
        })
    }),
  )
  deltas.sort(
    (left, right) => left.baseRevision - right.baseRevision || left.revision - right.revision,
  )
  for (const delta of deltas) applyStatusDelta(server, delta)
  return { uploaded, missingStatus }
}

/** HTTP: offer the batch, then upload each tile the server wants. */
const httpOffers: Transport = async (server, identity, entries) => {
  const answer = await telemetryWrite(server, '/telemetry/tiles/offers', {
    method: 'POST',
    json: { ...identity, season: server.season, offers: entries.map(offerOf) },
  })
  const response = answer?.response ?? null
  if (answer === null || response === null || !response.ok) {
    if (response !== null) {
      if (response.status >= 400 && response.status < 500) metric('rejected', entries.length)
      warn('telemetry tile offer was rejected', {
        server: server.url,
        status: response.status,
      })
    }
    return allAs(entries, 'retry')
  }
  const body = answer.body
  if (!isRecord(body) || !Array.isArray(body.wanted)) return allAs(entries, 'retry')
  const offered = new Set(entries.map((entry) => entry.tile))
  const wanted = offeredTiles(body.wanted, offered) ?? new Set<string>()
  const acknowledged = offeredTiles(body.acknowledged, offered)
  const rejected = offeredTiles(body.rejected, offered)
  const complete =
    acknowledged !== null &&
    rejected !== null &&
    entries.every(
      (entry) =>
        Number(wanted.has(entry.tile)) +
          Number(acknowledged.has(entry.tile)) +
          Number(rejected.has(entry.tile)) ===
        1,
    )
  if (!stillSharing(server)) return null
  const offeredStatus = statusDeltaFrom(body.status)
  if (offeredStatus !== null) applyStatusDelta(server, offeredStatus)
  const { uploaded, missingStatus } = await uploadWanted(
    server,
    identity,
    entries.filter((entry) => wanted.has(entry.tile)),
    typeof body.coverageToken === 'string' ? body.coverageToken : undefined,
  )
  if (missingStatus || (offeredStatus === null && !serverLiveSyncHealthy(server)))
    requestServerSync('post-offer', 'telemetry-status', server)
  return new Map(
    entries.map((entry): [string, Outcome] => [
      entry.deliveryId,
      (complete && acknowledged.has(entry.tile)) || uploaded.has(entry.deliveryId)
        ? 'acknowledged'
        : complete && rejected.has(entry.tile)
          ? 'rejected'
          : 'retry',
    ]),
  )
}

const transportsFor = (server: ConnectedServer): readonly Transport[] =>
  serverLiveSyncVersion(server) === 2 ? [liveOffers] : [liveCache, httpOffers]

const flush = async (serverUrl: string): Promise<void> => {
  flushTimers.delete(serverUrl)
  if (!getState().shareTiles) {
    clearAll()
    return
  }
  if (flushing.has(serverUrl)) return
  const outbox = outboxes.get(serverUrl)
  if (outbox === undefined || outbox.queued.size === 0) return
  const pending = [...outbox.queued.values()]
  outbox.queued.clear()
  const server = outbox.server
  if (!isCurrentServerConnection(server)) return
  flushing.add(serverUrl)
  const entries: OfferedTile[] = []
  const selectedTiles = new Set<string>()
  for (const entry of pending) {
    if (entries.length < MAX_TILE_OFFERS && !selectedTiles.has(entry.tile)) {
      entries.push(entry)
      selectedTiles.add(entry.tile)
    }
  }
  const selected = new Set(entries.map((entry) => entry.deliveryId))
  const plan: FlushPlan = {
    retry: false,
    // Offers that did not fit this batch and were never tried go out straight after it.
    immediately: pending.some(
      (entry) => !selected.has(entry.deliveryId) && !outbox.attempted.has(entry.deliveryId),
    ),
  }
  try {
    for (const entry of entries) receipts.started(...receiptOf(server), entry.deliveryId)
    await loadAccount()
    const identity = accountIdentity()
    if (!getState().shareTiles) {
      clearAll()
      return
    }
    if (identity === null && accountIdentityKnownUnavailable()) {
      clearServer(server.url)
      return
    }
    if (identity === null || !isCurrentServerConnection(server)) {
      settle(server, entries, allAs(entries, 'deferred'), plan)
      return
    }
    for (const entry of entries) outbox.attempted.add(entry.deliveryId)
    trim(server.url)
    metric('requested', entries.length)
    let unsettled: readonly OfferedTile[] = entries
    for (const transport of transportsFor(server)) {
      const outcomes = await transport(server, identity, unsettled)
      if (outcomes === null) {
        if (!getState().shareTiles) clearAll()
        return
      }
      settle(server, unsettled, outcomes, plan)
      unsettled = unsettled.filter((entry) => !outcomes.has(entry.deliveryId))
      if (unsettled.length === 0) break
    }
  } finally {
    flushing.delete(serverUrl)
    requeue(serverUrl, plan)
  }
}

/** Queue every unsettled offer the current connection still covers, and schedule the next flush. */
const requeue = (serverUrl: string, plan: FlushPlan): void => {
  const server = connectedServerAt(serverUrl)
  if (getState().shareTiles && server !== undefined && manifestCoverage(server) !== null) {
    const outbox = currentOutbox(server)
    if (outbox !== undefined)
      for (const [deliveryId, entry] of outbox.unsettled)
        if (coversTile(server, entry.tile)) outbox.queued.set(deliveryId, entry)
  }
  if (!outboxes.get(serverUrl)?.queued.size) return
  const retry = plan.retry && !plan.immediately
  if (retry) retrying.add(serverUrl)
  else retrying.delete(serverUrl)
  scheduleFlush(serverUrl, retry ? OFFER_RETRY_MS : OFFER_DELAY_MS)
}

const scheduleFlush = (serverUrl: string, delay: number): void => {
  if (flushing.has(serverUrl)) return
  const pending = flushTimers.get(serverUrl)
  if (pending !== undefined) {
    // Only a fresh offer may bring a waiting retry forward.
    if (delay !== OFFER_DELAY_MS || !pending.retry) return
    clearTimeout(pending.handle)
  }
  flushTimers.set(serverUrl, {
    handle: setTimeout(() => void flush(serverUrl).catch(reportError), delay),
    retry: delay > OFFER_DELAY_MS,
  })
}

const shareObservedTile = (entry: OfferedTile): void => {
  if (!getState().shareTiles) return
  for (const server of connectedServers()) {
    if (!coversTile(server, entry.tile)) continue
    const decision = receipts.decision(...receiptOf(server), entry.deliveryId)
    if (decision === 'avoid') {
      metric('avoided')
      continue
    }
    if (decision === 'pending') continue
    if (decision === 'retry') metric('retried')
    const retained = retain(server, entry)
    outboxFor(server).queued.set(retained.deliveryId, retained)
    // Waiting for the Wplace account to load keeps a retry's pace rather than hammering.
    const awaitingIdentity = accountIdentity() === null && !accountIdentityKnownUnavailable()
    scheduleFlush(
      server.url,
      awaitingIdentity && retrying.has(server.url) ? OFFER_RETRY_MS : OFFER_DELAY_MS,
    )
  }
}

const rememberTile = (entry: OfferedTile): void => {
  recentTiles.set(entry.deliveryId, entry)
  recentTileBytes += entry.bytes.byteLength
  while (recentTiles.size > MAX_RECENT_TILES || recentTileBytes > MAX_RECENT_TILE_BYTES) {
    const tileCounts = new Map<string, number>()
    for (const recent of recentTiles.values())
      tileCounts.set(recent.tile, (tileCounts.get(recent.tile) ?? 0) + 1)
    const all = [...recentTiles]
    const duplicates = all.filter(([, recent]) => (tileCounts.get(recent.tile) ?? 0) > 1)
    // Monotonic UUIDv7 IDs preserve observation order when hashing finishes out of order.
    const eviction = (duplicates.length > 0 ? duplicates : all).reduce((oldest, candidate) =>
      candidate[0] < oldest[0] ? candidate : oldest,
    )
    if (eviction === undefined) break
    recentTiles.delete(eviction[0])
    recentTileBytes -= eviction[1].bytes.byteLength
  }
}

/** Whether a fetched tile is worth hashing: a connected server covers it, or may once it reports. */
export const wantsObservedTile = (tile: TileCoord): boolean => {
  if (!getState().shareTiles) return false
  const connected = connectedServers()
  if (connected.length === 0) return false
  const key = tileKey(tile)
  let awaitingCoverage = false
  for (const server of connected) {
    const coverage = manifestCoverage(server)
    if (coverage === null) awaitingCoverage = true
    else if (coverage.tiles.has(key)) return true
  }
  return awaitingCoverage
}

/** Offer one fetched tile to every connected server that covers it. */
export const observeTile = async (
  tile: TileCoord,
  bytes: Uint8Array,
  observedAt: number,
): Promise<void> => {
  if (!getState().shareTiles) return
  const entry: OfferedTile = {
    deliveryId: uuidV7(),
    tile: tileKey(tile),
    coord: tile,
    sha256: await sha256Hex(bytes),
    ts: seconds(observedAt),
    bytes,
  }
  rememberTile(entry)
  shareObservedTile(entry)
}

/** Offer this connection's unsettled offers again, and the recent tiles too when asked. */
export const replayTileOffers = (server: ConnectedServer, includeRecentTiles: boolean): void => {
  if (!isCurrentServerConnection(server)) return
  const deliveries = includeRecentTiles ? new Map(recentTiles) : new Map<string, OfferedTile>()
  for (const [deliveryId, entry] of currentOutbox(server)?.unsettled ?? [])
    deliveries.set(deliveryId, entry)
  for (const entry of deliveries.values()) shareObservedTile(entry)
}

/**
 * Bring the outbox in line with a newly admitted coverage: drop offers it no longer covers, and
 * when the covered tiles changed, let refused offers be offered again.
 */
export const reconcileTileOffers = (server: ConnectedServer, coverageChanged: boolean): void => {
  const outbox = outboxes.get(server.url)
  if (outbox !== undefined) {
    if (currentOutbox(server) === undefined) dropOutbox(server.url)
    else {
      for (const [deliveryId, entry] of outbox.unsettled)
        if (!coversTile(server, entry.tile)) forgetOffer(server.url, deliveryId)
      for (const [deliveryId, entry] of outbox.queued)
        if (!coversTile(server, entry.tile)) outbox.queued.delete(deliveryId)
    }
  }
  if (coverageChanged) receipts.invalidateRejections(...receiptOf(server))
}

/** Drop every offer when sharing is off. */
export const pruneTileOffers = (): void => {
  if (!getState().shareTiles) clearAll()
}
