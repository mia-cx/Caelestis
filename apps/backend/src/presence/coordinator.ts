import {
  type CaptureRun,
  captureEndsAt,
  decodePresenceDraftMask,
  MAX_PRESENCE_MASK_BITS,
  MAX_PRESENCE_MESSAGE_CODE_UNITS,
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_PRESENCE_PEERS,
  MAX_PRESENCE_SUBSCRIBERS,
  MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT,
  PRESENCE_INTEREST_PADDING,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_STALE_MS,
  PRESENCE_TICK_MS,
  type PresenceDraft,
  type PresencePeer,
  type PresenceRect,
  type PresenceServerEvent,
  padRect,
  quantiseRect,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  rectCentreDistance,
  rectsIntersect,
  sameRect,
  type TerritoryTeam,
  uuidV7,
} from '@caelestis/shared'
import { PresenceClientEvent } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import type { AccessTokenStore } from '../auth/store.js'
import { createLiveSessionFence, type LiveHost, type LiveSocket } from '../live/session.js'
import type { IngestTimingSnapshot, IngestTimings } from '../metrics/ingest-timing.js'
import { ownedRegionIds, type RegionOwner, type RegionStore } from '../work/region-store.js'
import {
  applyCaptureEvent,
  type CaptureAssignment,
  captureAssignments,
  captureSlotLog,
  captureStartLog,
  connectedCaptures,
  leaveCaptures,
  newlyStarted,
} from './capture.js'
import { presenceRectWithinSurface } from './geometry.js'
import { PeerGrid } from './peer-grid.js'
import type { PresenceConnection, PresenceRoomId } from './port.js'

interface Attachment extends PresenceConnection {
  readonly sessionId: string
  readonly viewport: PresenceRect | null
  readonly draftRect: PresenceRect | null
  readonly draftPixels: number
  // Tuples keep 16 large world rects around 450 JSON bytes rather than 700. Together with
  // a 128-character name and all connection fields, the attachment stays below 2,048 bytes.
  // Optional for sockets attached before quick claims were introduced.
  readonly quickClaims?: readonly (readonly [number, number, number, number])[]
  readonly lastSeenAt: number
  readonly closed?: boolean
  readonly renewedAt?: number
  /** On an event server, the event team the session last reported. */
  readonly team?: TerritoryTeam
}

/**
 * The socket's presence attachment, or null when it holds none. A hibernated socket can outlive
 * the deploy that attached it, so the fields every tick relies on are checked, not assumed.
 */
const attachmentOf = (socket: LiveSocket): Attachment | null => {
  const attachment: unknown = socket.deserializeAttachment()
  if (typeof attachment !== 'object' || attachment === null) return null
  const held = attachment as Partial<Record<keyof Attachment, unknown>>
  const painter = held.painter
  const rectOrNull = (value: unknown) => value === null || typeof value === 'object'
  return typeof held.sessionId === 'string' &&
    typeof held.tokenHash === 'string' &&
    typeof held.credentialScope === 'string' &&
    typeof held.anonymous === 'boolean' &&
    typeof held.lastSeenAt === 'number' &&
    typeof held.draftPixels === 'number' &&
    rectOrNull(held.viewport) &&
    rectOrNull(held.draftRect) &&
    typeof painter === 'object' &&
    painter !== null &&
    'wplaceUserId' in painter &&
    typeof painter.wplaceUserId === 'number'
    ? (attachment as Attachment)
    : null
}

/** What this process remembers about one session. Hibernation forgets it; recovery rebuilds it. */
interface SessionState {
  mask?: string | undefined
  /** When its recent messages arrived, for the per-second limit. */
  rate: number[]
  /** The peers it was last sent, or undefined until it is owed a ready event. */
  sent?: Set<string>
  /** The online count it was last sent. */
  onlineSent?: number
  /** The region version and owned ids it was last sent. */
  claimsSent?: { readonly version: number; readonly owned: string }
}

/** An open socket with the attachment read once for the operation at hand. */
interface LiveSession {
  readonly socket: LiveSocket
  readonly held: Attachment
}

const CLAIM_RENEW_INTERVAL_MS = 60 * 60 * 1_000
/**
 * Storage key of one team's capture lobbies in the room, so they survive hibernation. Single runs
 * stored under `capture-run:<team>` before lobbies are never read.
 */
const captureKey = (team: TerritoryTeam): string => `capture-runs:${team}`

/** How long past a lobby's closing slot its members' slot reports are still checked and logged. */
const ASSIGNED_SLOT_MS = 120_000
/** The earliest claim expiry. The room's identity is stored beside it but read from the room. */
interface RegionExpiry extends PresenceRoomId {
  readonly at: number | null
}

/** Repack a mask after snapping its rectangle outward; the bit origins must move together. */
const quantisedDraft = (draft: PresenceDraft): PresenceDraft => {
  const rect = quantiseRect(draft.rect)
  if (sameRect(rect, draft.rect)) return draft
  const bits = rect.w * rect.h
  if (draft.mask === undefined || bits > MAX_PRESENCE_MASK_BITS)
    return { rect, pixels: draft.pixels }
  const source = decodePresenceDraftMask(draft)
  if (source === null) return { rect, pixels: draft.pixels }
  const bytes = new Uint8Array(Math.ceil(bits / 8))
  for (let bit = 0; bit < source.length; bit++) {
    if (source[bit] !== 1) continue
    const x = draft.rect.x - rect.x + (bit % draft.rect.w)
    const y = draft.rect.y - rect.y + Math.floor(bit / draft.rect.w)
    const target = y * rect.w + x
    bytes[target >> 3] = (bytes[target >> 3] ?? 0) | (128 >> (target & 7))
  }
  return { rect, pixels: draft.pixels, mask: btoa(String.fromCharCode(...bytes)) }
}

/** One hibernating room per season and drawing surface. Only region claims live in D1. */
export interface PresenceHost<Client> extends LiveHost<Client> {
  waitUntil(work: Promise<unknown>): void
}

/** One presence room: the sessions of one season and drawing surface. */
export class PresenceCoordinator<Client> {
  private readonly sessions = createLiveSessionFence()
  private readonly local = new Map<string, SessionState>()
  /** Sessions whose peer state changed since the last tick, including ones that left. */
  private readonly dirty = new Set<string>()
  private regionSnapshot: string | null = null
  private regionVersion = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** When the last tick started, so the next one keeps to the tick interval however long it ran. */
  private tickStartedAt = Number.NEGATIVE_INFINITY
  private stopped = false
  /** Per team, lobby changes one at a time, each reading the lobbies the previous one stored. */
  private readonly captureQueues = new Map<TerritoryTeam, Promise<readonly CaptureRun[]>>()
  /**
   * Each member's slot in recently started lobbies, by `lobby:session:slot`, so a slot report is
   * checked against the slot it was given even after its lobby closed or started its next round.
   * Kept in memory only, until a while past each lobby's closing slot.
   */
  private readonly assignedSlots = new Map<
    string,
    { readonly slot: CaptureAssignment; readonly until: number }
  >()

  constructor(
    private readonly state: PresenceHost<Client>,
    private readonly room: PresenceRoomId,
    private readonly sql: AccessTokenStore & { readonly regions: RegionStore },
    /** This room's own collector, as a Durable Object's isolate gives each room. */
    private readonly timings: IngestTimings,
    /**
     * Record that this room may hold sessions of a credential, so revoking it reaches the room even
     * while it hibernates.
     */
    private readonly routeRevocation: (tokenHash: string) => Promise<void>,
    /**
     * Whether this is an event server: it runs capture lobbies per event team, shares viewports and
     * drafts within each team only, and takes no quick claims.
     */
    private readonly eventServer = false,
  ) {}

  readIngestTimings(reset: boolean): IngestTimingSnapshot {
    return this.timings.read(reset)
  }

  private localState(sessionId: string): SessionState {
    let held = this.local.get(sessionId)
    if (held === undefined) {
      held = { rate: [] }
      this.local.set(sessionId, held)
    }
    return held
  }

  /** A team's lobbies as last stored, after any change still being applied. */
  private captureRuns(team: TerritoryTeam): Promise<readonly CaptureRun[]> {
    let queued = this.captureQueues.get(team)
    if (queued === undefined) {
      queued = this.state.storage
        .get<readonly CaptureRun[]>(captureKey(team))
        .then((runs) => runs ?? [])
      this.captureQueues.set(team, queued)
    }
    return queued
  }

  /**
   * Apply one change to a team's lobbies, close those with no connected member, store them, and
   * send them to that team's sessions if changed.
   */
  private updateCapture(
    team: TerritoryTeam,
    change: (runs: readonly CaptureRun[]) => readonly CaptureRun[],
  ): void {
    const previous = this.captureRuns(team)
    const next = previous.then(async (runs) => {
      // Only sessions still on this team count: one that switched team is gone from its lobbies.
      const connected = new Set(
        this.sessionsOpen()
          .filter(({ held }) => held.team === team)
          .map(({ held }) => held.sessionId),
      )
      const updated = connectedCaptures(change(runs), connected)
      if (updated === runs) return runs
      if (updated.length === 0) await this.state.storage.delete(captureKey(team))
      else await this.state.storage.put(captureKey(team), updated)
      for (const run of newlyStarted(runs, updated)) {
        console.info(JSON.stringify(captureStartLog(run)))
        this.assignSlots(run)
      }
      const payload = JSON.stringify({
        type: 'capture-runs',
        runs: updated,
      } satisfies PresenceServerEvent)
      // Recipients are read after the write: a session that switched team meanwhile has already
      // been sent its new team's lobbies and must not get these.
      for (const { socket, held } of this.sessionsOpen())
        if (held.team === team) this.sendEncoded(socket, payload)
      return updated
    })
    // A failed write keeps the run as it was, so the next change starts from what is stored.
    this.captureQueues.set(
      team,
      next.catch(() => previous),
    )
    this.state.waitUntil(next)
  }

  /** Remember a lobby's slots as its countdown starts, dropping those whose time has passed. */
  private assignSlots(run: CaptureRun): void {
    const now = Date.now()
    for (const [key, { until }] of this.assignedSlots)
      if (until < now) this.assignedSlots.delete(key)
    const until = (captureEndsAt(run) ?? now) + ASSIGNED_SLOT_MS
    for (const [sessionId, slot] of captureAssignments(run))
      this.assignedSlots.set(`${run.id}:${sessionId}:${slot.slotAt}`, { slot, until })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Open sessions, each attachment deserialized once. Hosts may clone it on every read. */
  private sessionsOpen(): LiveSession[] {
    const open: LiveSession[] = []
    for (const socket of this.state.getWebSockets('presence')) {
      if (socket.readyState !== 1) continue
      const held = attachmentOf(socket)
      if (held !== null && !held.closed) open.push({ socket, held })
    }
    return open
  }

  private peer(attachment: Attachment): PresencePeer {
    const mask = this.local.get(attachment.sessionId)?.mask
    return {
      sessionId: attachment.sessionId,
      ...(attachment.publisherId === undefined ? {} : { publisherId: attachment.publisherId }),
      painter: attachment.painter,
      viewport: attachment.viewport,
      ...(attachment.quickClaims?.length
        ? { quickClaims: attachment.quickClaims.map(([x, y, w, h]) => ({ x, y, w, h })) }
        : {}),
      draft:
        attachment.draftRect === null
          ? null
          : {
              rect: attachment.draftRect,
              pixels: attachment.draftPixels,
              ...(mask === undefined ? {} : { mask }),
            },
    }
  }

  /**
   * The peers each subscriber may see, as one grid per visibility group: the whole room, or on an
   * event server one grid per event team, so selection never walks another team's sessions.
   * Sessions without a team on an event server join no grid and see nobody.
   */
  private peerGrids(open: readonly LiveSession[]): Map<TerritoryTeam | undefined, PeerGrid> {
    const groups = new Map<TerritoryTeam | undefined, PresencePeer[]>()
    for (const { held } of open) {
      const team = this.eventServer ? held.team : undefined
      if (this.eventServer && team === undefined) continue
      let group = groups.get(team)
      if (group === undefined) {
        group = []
        groups.set(team, group)
      }
      group.push(this.peer(held))
    }
    return new Map([...groups].map(([team, peers]) => [team, new PeerGrid(peers)]))
  }

  /**
   * The nearest `MAX_PRESENCE_PEERS` peers in `peers` that a subscriber's interest area reaches,
   * nearest first, ties by session ID. A bounded insertion keeps the order a full stable sort
   * would give without sorting every candidate.
   */
  private relevant(subscriber: Attachment, peers: PeerGrid): PresencePeer[] {
    const viewport = subscriber.viewport
    if (viewport === null) return []
    const interest = padRect(viewport, PRESENCE_INTEREST_PADDING)
    const nearest: PresencePeer[] = []
    const distances: number[] = []
    for (const peer of peers.near(interest)) {
      if (peer.sessionId === subscriber.sessionId) continue
      const other = peer.viewport
      const draft = peer.draft?.rect
      const quickClaims = peer.quickClaims ?? []
      if (
        !(other !== null && rectsIntersect(interest, other)) &&
        !(draft !== undefined && rectsIntersect(interest, draft)) &&
        !quickClaims.some((rect) => rectsIntersect(interest, rect))
      )
        continue
      let distance = other === null ? Number.POSITIVE_INFINITY : rectCentreDistance(viewport, other)
      if (draft !== undefined) distance = Math.min(distance, rectCentreDistance(viewport, draft))
      for (const rect of quickClaims)
        distance = Math.min(distance, rectCentreDistance(viewport, rect))
      let at = nearest.length
      while (at > 0) {
        const gap = distance - (distances[at - 1] ?? 0)
        if (
          gap > 0 ||
          (gap === 0 && peer.sessionId.localeCompare(nearest[at - 1]?.sessionId ?? '') >= 0)
        )
          break
        at--
      }
      if (at === MAX_PRESENCE_PEERS) continue
      nearest.splice(at, 0, peer)
      distances.splice(at, 0, distance)
      if (nearest.length > MAX_PRESENCE_PEERS) {
        nearest.pop()
        distances.pop()
      }
    }
    return nearest
  }

  private send({ socket, held }: LiveSession, event: PresenceServerEvent): void {
    try {
      const started = performance.now()
      if (
        (event.type === 'regions' || event.type === 'presence-ready') &&
        event.ownedRegionIds !== undefined
      ) {
        // Ownership may be read after a concurrent claim insert. Advertise only IDs and actors
        // present in this snapshot; the mutation's queued publication carries the newer claim.
        const actors = new Map(
          event.regions.map((region) => [region.id, region.claimant.wplaceUserId]),
        )
        const actor = held.painter.wplaceUserId
        event = {
          ...event,
          ownedRegionIds: event.ownedRegionIds.filter((id) => actors.get(id) === actor),
        }
      }
      const payload = JSON.stringify(event)
      this.timings.record(
        event.type === 'regions' ? 'claims' : 'presence',
        'serialize',
        performance.now() - started,
      )
      this.sendEncoded(socket, payload)
    } catch {
      this.close(socket, 1011, 'presence send failed')
    }
  }

  private sendEncoded(socket: LiveSocket, payload: string): void {
    try {
      socket.send(payload)
    } catch {
      this.close(socket, 1011, 'presence send failed')
    }
  }

  /**
   * Schedule a tick for a change, no sooner than `PRESENCE_TICK_MS` after the last tick started.
   * Counting from the start keeps a busy room on a 300 ms cadence: the update that arrives
   * while a tick runs does not add that tick's work to the next interval. A room idle for longer
   * than the interval ticks at once.
   */
  private armTick(): void {
    if (this.stopped || this.timer !== null) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.state.waitUntil(this.tick())
      },
      Math.min(PRESENCE_TICK_MS, Math.max(0, this.tickStartedAt + PRESENCE_TICK_MS - Date.now())),
    )
  }

  private async armAlarm(open?: readonly LiveSession[]): Promise<void> {
    const alarm = await this.state.storage.getAlarm()
    // An event server publishes no claims, so their expiry never wakes it.
    const regionExpiry = this.eventServer
      ? undefined
      : await this.state.storage.get<RegionExpiry>('region-expiry')
    let expiresAt = regionExpiry?.at ?? Number.POSITIVE_INFINITY
    for (const { held } of open ?? this.sessionsOpen())
      expiresAt = Math.min(expiresAt, held.lastSeenAt + PRESENCE_STALE_MS)
    if (!Number.isFinite(expiresAt)) {
      if (alarm !== null) await this.state.storage.deleteAlarm()
      return
    }
    if (alarm === null || alarm <= Date.now() || expiresAt < alarm)
      await this.state.storage.setAlarm(expiresAt)
  }

  /** Expire idle sessions after hibernation and schedule the next stale sweep. */
  async alarm(): Promise<void> {
    const expiry = await this.state.storage.get<RegionExpiry>('region-expiry')
    if (expiry?.at != null && expiry.at <= Date.now()) await this.publishRegions()
    await this.tick()
  }

  private async tick(): Promise<void> {
    this.tickStartedAt = Date.now()
    const queued = performance.now()
    await this.sessions.revoke(async () =>
      this.timings.timed('presence', 'total', async () => {
        this.timings.record('presence', 'queue', performance.now() - queued)
        const now = Date.now()
        let open: LiveSession[] = []
        for (const session of this.sessionsOpen()) {
          if (now - session.held.lastSeenAt >= PRESENCE_STALE_MS)
            this.close(session.socket, 1000, 'presence stale')
          else open.push(session)
        }
        const sent = (sessionId: string) => this.local.get(sessionId)?.sent
        const recovering = open.some(({ held }) => sent(held.sessionId) === undefined)
        const regions =
          !recovering || this.eventServer
            ? []
            : await this.timings.timed('claims', 'list', () =>
                this.sql.regions.listRegions(this.room.season, this.room.surface),
              )
        // A valid heartbeat/update has kept these sessions alive. Ownership always uses both keys,
        // including for administrators; connecting must never renew another painter's claims.
        // An event server keeps claims dormant, so it renews none.
        const due = new Set(
          open.filter(
            ({ held }) =>
              !this.eventServer &&
              !held.anonymous &&
              now - (held.renewedAt ?? 0) >= CLAIM_RENEW_INTERVAL_MS,
          ),
        )
        const renewed: LiveSession[] = []
        if (due.size > 0) {
          await this.timings.timed('claims', 'renew', () =>
            this.sql.regions.renewRegions(
              [...due].map(({ held }) => ({
                tokenHash: held.tokenHash,
                actorId: held.painter.wplaceUserId,
              })),
              now,
            ),
          )
          for (const { socket } of due) {
            // Updates may have landed during the reads above; stamp the attachment as it is now.
            const held = attachmentOf(socket)
            if (held === null || held.closed) continue
            socket.serializeAttachment({ ...held, renewedAt: now } satisfies Attachment)
            renewed.push({ socket, held })
          }
        }
        // Renewal and recovery replies share one committed owner list inside this revocation
        // fence. Do not retain it across ticks, where a credential transfer or expiry could
        // invalidate it.
        const owners =
          !this.eventServer &&
          (renewed.length > 0 ||
            open.some(({ held }) => !held.anonymous && sent(held.sessionId) === undefined))
            ? await this.timings.timed('claims', 'owners', () =>
                this.sql.regions.regionOwners(this.room.season, this.room.surface),
              )
            : undefined
        for (const session of renewed) {
          const ids = await this.ownedRegionIds(session.held, owners)
          // Claims on other surfaces renewed too, but this room's client tracks only its own.
          if (ids.length > 0)
            this.send(session, {
              type: 'claims-renewed',
              expiresAt: now + REGION_CLAIM_TTL_MS,
              ids,
            })
        }
        // The reads above let updates and closes land; select from the attachments as they are now.
        if (recovering || due.size > 0) open = this.sessionsOpen()
        const dirty = new Set(this.dirty)
        this.dirty.clear()
        const online = open.length
        // Built on demand: a heartbeat-only tick selects nobody.
        let grids: Map<TerritoryTeam | undefined, PeerGrid> | undefined
        // Each peer is encoded once per tick, however many subscribers its delta reaches.
        const encoded = new Map<string, string>()
        const encode = (peer: PresencePeer) => {
          let json = encoded.get(peer.sessionId)
          if (json === undefined) {
            json = JSON.stringify(peer)
            encoded.set(peer.sessionId, json)
          }
          return json
        }
        for (const session of open) {
          const subscriber = session.held
          const local = this.localState(subscriber.sessionId)
          const previous = local.sent
          // Heartbeats only refresh liveness. Recovery, membership changes and dirty peer state
          // still recompute every recipient so moving viewports can discover previously unseen peers.
          if (previous !== undefined && dirty.size === 0 && local.onlineSent === online) continue
          grids ??= this.peerGrids(open)
          const peers = grids.get(this.eventServer ? subscriber.team : undefined)
          const started = performance.now()
          const relevant = peers === undefined ? [] : this.relevant(subscriber, peers)
          this.timings.record('presence', 'select', performance.now() - started)
          const next = new Set(relevant.map((peer) => peer.sessionId))
          local.sent = next
          if (previous === undefined) {
            local.onlineSent = online
            this.send(session, {
              type: 'presence-ready',
              sessionId: subscriber.sessionId,
              online,
              peers: relevant,
              regions,
              ownedRegionIds: await this.ownedRegionIds(subscriber, owners),
              canWrite: subscriber.credentialScope !== 'read' && !subscriber.anonymous,
            })
            continue
          }
          const upsert = relevant.filter(
            (peer) => dirty.has(peer.sessionId) || !previous.has(peer.sessionId),
          )
          const remove = [...previous].filter((id) => !next.has(id))
          const onlineChanged = local.onlineSent !== online
          local.onlineSent = online
          if (!upsert.length && !remove.length && !onlineChanged) continue
          const encoding = performance.now()
          // The bytes JSON.stringify gives the whole event, with every peer encoded only once.
          const payload = `{"type":"presence-delta","online":${online},"upsert":[${upsert.map(encode).join(',')}],"remove":${JSON.stringify(remove)}}`
          this.timings.record('presence', 'serialize', performance.now() - encoding)
          this.sendEncoded(session.socket, payload)
        }
        await this.armAlarm(open)
      }),
    )
  }

  private drop(socket: LiveSocket): void {
    const attachment = attachmentOf(socket)
    if (attachment === null) return
    socket.serializeAttachment({ ...attachment, closed: true } satisfies Attachment)
    this.local.delete(attachment.sessionId)
    this.dirty.add(attachment.sessionId)
    this.armTick()
    if (attachment.team !== undefined) this.leaveCaptures(attachment.team, attachment.sessionId)
  }

  /** Take a session out of its team's lobbies, unless its countdown holds it there. */
  private leaveCaptures(team: TerritoryTeam, sessionId: string): void {
    this.updateCapture(team, (runs) => leaveCaptures(runs, sessionId, Date.now()) ?? runs)
  }

  private close(socket: LiveSocket, code: number, reason: string): void {
    this.drop(socket)
    try {
      socket.close(code, reason)
    } catch {
      console.error('presence socket close failed')
    }
  }

  /** Admit one presence connection within the room's capacity and its credential's rights. */
  async connect(connection: PresenceConnection): Promise<Response> {
    const { season, surface, painter, tokenHash, clientHash, credentialScope, anonymous } =
      connection
    let capacity = false
    let regions: readonly RegionClaim[] = []
    const pair = await this.sessions.attach(
      async () => {
        const open = this.sessionsOpen()
        capacity =
          open.length >= MAX_PRESENCE_SUBSCRIBERS ||
          open.filter(({ held }) => held.clientHash === clientHash).length >=
            MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT
        if (capacity) return false
        if (connection.revocable) {
          // Before the credential check, so a revocation that lands after it finds this room.
          await this.routeRevocation(tokenHash)
          const token = await this.sql.readAccessToken(tokenHash)
          if (token === null || token.scope !== credentialScope) return false
        }
        // An event server neither renews nor shows the claims stored before it became one.
        if (this.eventServer) return true
        if (!anonymous)
          await this.sql.regions.renewRegions(
            [{ tokenHash, actorId: painter.wplaceUserId }],
            Date.now(),
          )
        // Share the fence with region publication so ready cannot arrive after a newer regions event.
        regions = await this.sql.regions.listRegions(season, surface)
        await this.rememberRegionExpiry(regions)
        return true
      },
      async () => {
        const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const attachment: Attachment = {
          ...connection,
          sessionId,
          viewport: null,
          draftRect: null,
          draftPixels: 0,
          lastSeenAt: Date.now(),
          renewedAt: Date.now(),
        }
        const pair = this.state.connect(attachment)
        const open = this.sessionsOpen()
        // A new session has no viewport, so it sees no peers until its first update.
        const local = this.localState(sessionId)
        local.sent = new Set()
        local.onlineSent = open.length
        this.send(
          { socket: pair.server, held: attachment },
          {
            type: 'presence-ready',
            sessionId,
            online: open.length,
            peers: [],
            regions,
            ownedRegionIds: await this.ownedRegionIds(attachment),
            canWrite: credentialScope !== 'read' && !anonymous,
          },
        )
        // Capture lobbies reach the session once it reports its team.
        this.dirty.add(sessionId)
        this.armTick()
        await this.armAlarm(open)
        return pair
      },
    )
    if (capacity)
      return new Response('Presence subscriber limit reached', {
        status: 503,
        headers: { 'Retry-After': '30' },
      })
    if (pair === null) return new Response('Credential revoked', { status: 401 })
    // The HTTP boundary admits only clients that offered this protocol.
    return this.state.upgradeResponse(
      pair.client,
      new Headers({ 'sec-websocket-protocol': PRESENCE_PROTOCOL_V1 }),
    )
  }

  webSocketMessage(socket: LiveSocket, message: string | ArrayBuffer): void {
    const attachment = attachmentOf(socket)
    if (attachment === null) {
      this.close(socket, 1011, 'presence session lost')
      return
    }
    if (attachment.closed) return
    const now = Date.now()
    const local = this.localState(attachment.sessionId)
    const rate = local.rate.filter((at) => now - at < 1_000)
    rate.push(now)
    local.rate = rate
    if (rate.length > MAX_PRESENCE_MESSAGES_PER_SECOND) {
      this.close(socket, 1008, 'presence rate limit')
      return
    }
    if (typeof message !== 'string') {
      this.close(socket, 1003, 'presence requires text messages')
      return
    }
    if (message.length > MAX_PRESENCE_MESSAGE_CODE_UNITS) {
      this.close(socket, 1009, 'presence message too large')
      return
    }
    let event: Schema.Schema.Type<typeof PresenceClientEvent>
    try {
      event = Schema.decodeUnknownSync(PresenceClientEvent)(JSON.parse(message))
    } catch {
      return
    }
    if (event.type === 'presence-heartbeat') {
      socket.serializeAttachment({ ...attachment, lastSeenAt: now } satisfies Attachment)
      this.armTick()
      return
    }
    // Capture runs and their clock sync exist only on an event server.
    if (!this.eventServer && event.type !== 'presence-update') return
    if (event.type === 'clock') {
      this.send({ socket, held: attachment }, { type: 'clock', sent: event.sent, at: Date.now() })
      return
    }
    if (attachment.credentialScope === 'read') return
    if (event.type === 'capture-timing') {
      // Logged for reading slot timing afterwards; the lobby never holds it. Only a slot the server
      // gave this session, and not yet past its grace period, is logged.
      const held = this.assignedSlots.get(`${event.run}:${attachment.sessionId}:${event.slotAt}`)
      if (held === undefined || held.until < Date.now()) return
      const assigned = held.slot
      // The lobby lives with the team it started on, whatever team the painter reports now.
      void this.captureRuns(assigned.team).then((runs) => {
        const closed = !runs.some(({ id }) => id === event.run)
        const line = captureSlotLog(event, assigned, attachment.painter, closed)
        if (line !== null) console.info(JSON.stringify(line))
      })
      return
    }
    if (event.type !== 'presence-update') {
      const { team } = attachment
      if (team === undefined) return
      const actor = {
        sessionId: attachment.sessionId,
        painter: attachment.painter,
        scope: attachment.credentialScope,
        team,
      }
      this.updateCapture(team, (runs) => applyCaptureEvent(runs, event, actor, Date.now(), uuidV7))
      return
    }
    // Anonymous sessions are read scope, so the early return above keeps their quick claims out.
    // An event server takes no claims at all.
    const quickClaims = this.eventServer ? undefined : event.quickClaims
    const team = this.eventServer ? (event.team ?? attachment.team) : undefined
    const { surface } = this.room
    const viewport =
      event.viewport === undefined
        ? attachment.viewport
        : event.viewport === null
          ? null
          : quantiseRect(event.viewport)
    const draft =
      event.draft === undefined
        ? undefined
        : event.draft === null
          ? null
          : quantisedDraft(event.draft)
    if (
      (event.viewport != null && !presenceRectWithinSurface(event.viewport, surface)) ||
      (event.draft != null && !presenceRectWithinSurface(event.draft.rect, surface)) ||
      (viewport !== null && !presenceRectWithinSurface(viewport, surface)) ||
      (draft != null && !presenceRectWithinSurface(draft.rect, surface)) ||
      quickClaims?.some((rect) => !presenceRectWithinSurface(rect, surface))
    )
      return
    if (draft !== undefined) local.mask = draft?.mask
    const updated = {
      ...attachment,
      viewport,
      draftRect: draft === undefined ? attachment.draftRect : (draft?.rect ?? null),
      draftPixels: draft === undefined ? attachment.draftPixels : (draft?.pixels ?? 0),
      ...(quickClaims === undefined
        ? {}
        : { quickClaims: quickClaims.map(({ x, y, w, h }) => [x, y, w, h] as const) }),
      ...(team === undefined ? {} : { team }),
      lastSeenAt: now,
    } satisfies Attachment
    socket.serializeAttachment(updated)
    if (team !== undefined && team !== attachment.team) {
      // A new team: leave the old team's lobby, see the new one's.
      const left = attachment.team
      if (left !== undefined) this.leaveCaptures(left, attachment.sessionId)
      void this.captureRuns(team).then((runs) => {
        // The read can finish after the session closed or switched again; then it is not theirs.
        if (socket.readyState !== 1) return
        const held = attachmentOf(socket)
        if (held === null || held.closed || held.team !== team) return
        this.send({ socket, held }, { type: 'capture-runs', runs })
      })
    }
    this.dirty.add(attachment.sessionId)
    this.armTick()
  }

  webSocketClose(socket: LiveSocket, code: number, reason: string, _wasClean: boolean): void {
    this.close(socket, code, reason)
  }
  webSocketError(socket: LiveSocket): void {
    this.close(socket, 1011, 'presence socket error')
  }

  /** Count open sockets, including hibernated sessions, without scheduling or sending updates. */
  async online(): Promise<number> {
    return this.sessionsOpen().length
  }

  /** The open sessions admission counts against the room's capacity. */
  occupants(): readonly PresenceConnection[] {
    return this.sessionsOpen().map(({ held }) => held)
  }

  /** Reload committed claims and deliver the surface's authoritative region list. */
  async publishRegions(): Promise<void> {
    if (this.eventServer) return
    const { season, surface } = this.room
    const queued = performance.now()
    await this.sessions.revoke(async () =>
      this.timings.timed('claims', 'total', async () => {
        this.timings.record('claims', 'queue', performance.now() - queued)
        const regions = await this.timings.timed('claims', 'list', () =>
          this.sql.regions.listRegions(season, surface),
        )
        await this.rememberRegionExpiry(regions)
        const owners = await this.timings.timed('claims', 'owners', () =>
          this.sql.regions.regionOwners(season, surface),
        )
        const started = performance.now()
        const snapshot = JSON.stringify(regions)
        if (snapshot !== this.regionSnapshot) {
          this.regionSnapshot = snapshot
          this.regionVersion++
        }
        const grouped = new Map<string, Map<number, string[]>>()
        const actorsInSnapshot = new Map(
          regions.map((region) => [region.id, region.claimant.wplaceUserId]),
        )
        for (const owner of owners) {
          if (actorsInSnapshot.get(owner.id) !== owner.actorId) continue
          let actors = grouped.get(owner.tokenHash)
          if (actors === undefined) {
            actors = new Map()
            grouped.set(owner.tokenHash, actors)
          }
          let ids = actors.get(owner.actorId)
          if (ids === undefined) {
            ids = []
            actors.set(owner.actorId, ids)
          }
          ids.push(owner.id)
        }
        // SQL row order is unspecified; equivalent ownership sets must share a cache key.
        for (const actors of grouped.values()) for (const ids of actors.values()) ids.sort()
        const prefix = `{"type":"regions","regions":${snapshot},"ownedRegionIds":`
        this.timings.record('claims', 'serialize', performance.now() - started)
        const open = this.sessionsOpen()
        for (const session of open) {
          const attachment = session.held
          const started = performance.now()
          const owned = JSON.stringify(
            attachment.anonymous
              ? []
              : (grouped.get(attachment.tokenHash)?.get(attachment.painter.wplaceUserId) ?? []),
          )
          const local = this.localState(attachment.sessionId)
          const previous = local.claimsSent
          this.timings.record('claims', 'serialize', performance.now() - started)
          // Ownership can change without changing public geometry. Compare both, inside the
          // revocation fence, and forget delivery state on disconnect or hibernation recovery.
          if (previous?.version === this.regionVersion && previous.owned === owned) continue
          local.claimsSent = { version: this.regionVersion, owned }
          this.sendEncoded(session.socket, `${prefix}${owned}}`)
        }
        await this.armAlarm(open)
      }),
    )
  }

  private async ownedRegionIds(
    attachment: Attachment,
    recoveredOwners?: readonly RegionOwner[],
  ): Promise<readonly string[]> {
    if (attachment.anonymous || this.eventServer) return []
    const owners =
      recoveredOwners ??
      (await this.timings.timed('claims', 'owners', () =>
        this.sql.regions.regionOwners(this.room.season, this.room.surface),
      ))
    return ownedRegionIds(owners, {
      tokenHash: attachment.tokenHash,
      actorId: attachment.painter.wplaceUserId,
    })
  }

  private async rememberRegionExpiry(regions: readonly RegionClaim[]): Promise<void> {
    // A loop rather than a spread: the region list is unbounded and V8 caps call arguments.
    let at = Number.POSITIVE_INFINITY
    for (const region of regions)
      if (region.expiresAt !== undefined && region.expiresAt < at) at = region.expiresAt
    await this.state.storage.put('region-expiry', {
      ...this.room,
      at: Number.isFinite(at) ? at : null,
    } satisfies RegionExpiry)
  }

  /** Fence revocation against the second D1 credential check and socket acceptance. */
  async closeCredential(tokenHash: string): Promise<void> {
    await this.sessions.revoke(() => {
      for (const { socket, held } of this.sessionsOpen())
        if (held.tokenHash === tokenHash) this.close(socket, 1008, 'credential revoked')
    })
  }
}
