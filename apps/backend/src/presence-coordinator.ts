import {
  decodePresenceDraftMask,
  isWorkIdentity,
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
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'
import { PresenceClientEvent } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { normalizeMetricClientIdentity } from './metrics/request-metrics.js'
import type { SqlStore } from './ports/index.js'
import { presenceRectWithinSurface } from './presence/geometry.js'
import type { PresenceConnection } from './presence/port.js'
import type { LiveHost, LiveSocket } from './status-coordinator.js'
import { createLiveSessionFence } from './status-coordinator.js'
import { ingestTimings } from './telemetry/ingest-timing.js'

interface Attachment extends PresenceConnection {
  readonly sessionId: string
  readonly viewport: PresenceRect | null
  readonly draftRect: PresenceRect | null
  readonly draftPixels: number
  readonly lastSeenAt: number
  readonly closed?: boolean
  readonly renewedAt?: number
}

const CLAIM_RENEW_INTERVAL_MS = 60 * 60 * 1_000
interface RegionExpiry {
  readonly season: number
  readonly surface: TemplateSurface
  readonly at: number | null
}

const natural = (text: string | null): number | null => {
  if (text === null || !/^(0|[1-9]\d*)$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
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

export class PresenceCoordinator<Client> {
  private readonly sessions = createLiveSessionFence()
  private readonly masks = new Map<string, string>()
  private readonly rates = new Map<string, number[]>()
  private readonly sent = new Map<string, Set<string>>()
  private readonly onlineSent = new Map<string, number>()
  private readonly dirty = new Set<string>()
  private regionSnapshot: string | null = null
  private regionVersion = 0
  private readonly claimsSent = new Map<
    string,
    { readonly version: number; readonly owned: string }
  >()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly state: PresenceHost<Client>,
    private readonly sql: SqlStore,
  ) {}

  private attachment(socket: LiveSocket): Attachment {
    return socket.deserializeAttachment() as Attachment
  }
  /** Stop the transient delivery timer when a host shuts down. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private sockets(): LiveSocket[] {
    return this.state
      .getWebSockets('presence')
      .filter((socket) => !this.attachment(socket).closed && socket.readyState === 1)
  }

  private peer(attachment: Attachment): PresencePeer {
    const mask = this.masks.get(attachment.sessionId)
    return {
      sessionId: attachment.sessionId,
      ...(attachment.publisherId === undefined ? {} : { publisherId: attachment.publisherId }),
      painter: attachment.painter,
      viewport: attachment.viewport,
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

  private relevant(subscriber: Attachment, peers: readonly PresencePeer[]): PresencePeer[] {
    const viewport = subscriber.viewport
    if (viewport === null) return []
    const interest = padRect(viewport, PRESENCE_INTEREST_PADDING)
    const candidates: { peer: PresencePeer; distance: number }[] = []
    for (const peer of peers) {
      if (peer.sessionId === subscriber.sessionId) continue
      const other = peer.viewport
      const draft = peer.draft?.rect
      if (
        !(other !== null && rectsIntersect(interest, other)) &&
        !(draft !== undefined && rectsIntersect(interest, draft))
      )
        continue
      candidates.push({
        peer,
        distance: Math.min(
          other === null ? Number.POSITIVE_INFINITY : rectCentreDistance(viewport, other),
          draft === undefined ? Number.POSITIVE_INFINITY : rectCentreDistance(viewport, draft),
        ),
      })
    }
    return candidates
      .sort((a, b) => a.distance - b.distance || a.peer.sessionId.localeCompare(b.peer.sessionId))
      .slice(0, MAX_PRESENCE_PEERS)
      .map(({ peer }) => peer)
  }

  private send(socket: LiveSocket, event: PresenceServerEvent): void {
    try {
      const started = performance.now()
      const payload = JSON.stringify(event)
      ingestTimings.record(
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

  private armTick(): void {
    if (this.stopped || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.state.waitUntil(this.tick())
    }, PRESENCE_TICK_MS)
  }

  private async armAlarm(): Promise<void> {
    const alarm = await this.state.storage.getAlarm()
    const sockets = this.sockets()
    const regionExpiry = await this.state.storage.get<RegionExpiry>('region-expiry')
    const expiresAt = Math.min(
      ...sockets.map((socket) => this.attachment(socket).lastSeenAt + PRESENCE_STALE_MS),
      regionExpiry?.at ?? Number.POSITIVE_INFINITY,
    )
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
    if (expiry?.at != null && expiry.at <= Date.now())
      await this.publishRegions(expiry.season, expiry.surface)
    await this.tick()
  }

  private async tick(): Promise<void> {
    const queued = performance.now()
    await this.sessions.revoke(async () =>
      ingestTimings.timed('presence', 'total', async () => {
        ingestTimings.record('presence', 'queue', performance.now() - queued)
        const recovering = this.sockets().find(
          (socket) => !this.sent.has(this.attachment(socket).sessionId),
        )
        const attachment = recovering === undefined ? undefined : this.attachment(recovering)
        const regions =
          attachment === undefined
            ? []
            : await ingestTimings.timed('claims', 'list', () =>
                this.sql.regions.listRegions(attachment.season, attachment.surface),
              )
        const now = Date.now()
        for (const socket of this.sockets()) {
          if (now - this.attachment(socket).lastSeenAt >= PRESENCE_STALE_MS)
            this.close(socket, 1000, 'presence stale')
        }
        const sockets = this.sockets()
        for (const socket of sockets) {
          const held = this.attachment(socket)
          if (held.anonymous || now - (held.renewedAt ?? 0) < CLAIM_RENEW_INTERVAL_MS) continue
          // A valid heartbeat/update has kept this session alive. Ownership always uses both keys,
          // including for administrators; connecting must never renew another painter's claims.
          const renewed = await ingestTimings.timed('claims', 'renew', () =>
            this.sql.regions.renewRegions(held.tokenHash, held.painter.wplaceUserId, now),
          )
          socket.serializeAttachment({ ...held, renewedAt: now } satisfies Attachment)
          if (renewed)
            this.send(socket, {
              type: 'claims-renewed',
              expiresAt: now + REGION_CLAIM_TTL_MS,
              ids: await this.ownedRegionIds(held),
            })
        }
        const peers = sockets.map((socket) => this.peer(this.attachment(socket)))
        const dirty = new Set(this.dirty)
        this.dirty.clear()
        for (const socket of sockets) {
          const subscriber = this.attachment(socket)
          const previous = this.sent.get(subscriber.sessionId)
          // Heartbeats only refresh liveness. Recovery, membership changes and dirty peer state
          // still recompute every recipient so moving viewports can discover previously unseen peers.
          if (
            previous !== undefined &&
            dirty.size === 0 &&
            this.onlineSent.get(subscriber.sessionId) === sockets.length
          )
            continue
          const started = performance.now()
          const relevant = this.relevant(subscriber, peers)
          ingestTimings.record('presence', 'select', performance.now() - started)
          const next = new Set(relevant.map((peer) => peer.sessionId))
          this.sent.set(subscriber.sessionId, next)
          if (previous === undefined) {
            this.onlineSent.set(subscriber.sessionId, sockets.length)
            this.send(socket, {
              type: 'presence-ready',
              sessionId: subscriber.sessionId,
              online: sockets.length,
              peers: relevant,
              regions,
              ownedRegionIds: await this.ownedRegionIds(subscriber),
              canWrite: subscriber.credentialScope !== 'read' && !subscriber.anonymous,
            })
            continue
          }
          const upsert = relevant.filter(
            (peer) => dirty.has(peer.sessionId) || !previous.has(peer.sessionId),
          )
          const remove = [...previous].filter((id) => !next.has(id))
          const onlineChanged = this.onlineSent.get(subscriber.sessionId) !== sockets.length
          this.onlineSent.set(subscriber.sessionId, sockets.length)
          if (upsert.length || remove.length || onlineChanged)
            this.send(socket, { type: 'presence-delta', online: sockets.length, upsert, remove })
        }
        await this.armAlarm()
      }),
    )
  }

  private drop(socket: LiveSocket): void {
    const attachment = this.attachment(socket)
    socket.serializeAttachment({ ...attachment, closed: true } satisfies Attachment)
    const id = attachment.sessionId
    this.masks.delete(id)
    this.rates.delete(id)
    this.sent.delete(id)
    this.onlineSent.delete(id)
    this.claimsSent.delete(id)
    this.dirty.add(id)
    this.armTick()
  }

  private close(socket: LiveSocket, code: number, reason: string): void {
    this.drop(socket)
    try {
      socket.close(code, reason)
    } catch {
      console.error('presence socket close failed')
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket upgrade required', { status: 426 })
    const headers = request.headers
    const season = natural(headers.get('x-caelestis-season'))
    const alliance = headers.get('x-caelestis-alliance-id')
    const surface = templateSurface(
      headers.get('x-caelestis-surface-kind'),
      alliance === null ? null : natural(alliance),
    )
    let displayName: string
    try {
      displayName = decodeURIComponent(headers.get('x-caelestis-painter-name') ?? '')
    } catch {
      return new Response('Invalid painter name', { status: 400 })
    }
    const painter = { wplaceUserId: natural(headers.get('x-caelestis-painter-id')), displayName }
    const tokenHash = headers.get('x-caelestis-token-hash')
    const clientHash = headers.get('x-caelestis-client-hash')
    const publisherId = headers.get('x-caelestis-publisher-id')
    const credentialScope = headers.get('x-caelestis-credential-scope')
    const anonymous = headers.get('x-caelestis-anonymous')
    const revocable = headers.get('x-caelestis-revocable')
    if (
      season === null ||
      surface === null ||
      (alliance !== null && natural(alliance) === null) ||
      !isWorkIdentity(painter) ||
      tokenHash === null ||
      !/^[0-9a-f]{64}$/.test(tokenHash) ||
      clientHash === null ||
      !/^[0-9a-f]{64}$/.test(clientHash) ||
      (publisherId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          publisherId,
        )) ||
      (credentialScope !== 'read' && credentialScope !== 'report' && credentialScope !== 'admin') ||
      (anonymous !== '0' && anonymous !== '1') ||
      (revocable !== '0' && revocable !== '1')
    )
      return new Response('Invalid presence connection', { status: 400 })
    const metric = normalizeMetricClientIdentity(
      headers.get('x-caelestis-metric-client') ?? 'unknown',
      headers.get('x-caelestis-metric-client-version') ?? 'unknown',
    )
    let capacity = false
    let regions: readonly RegionClaim[] = []
    const pair = await this.sessions.attach(
      async () => {
        const sockets = this.sockets()
        capacity =
          sockets.length >= MAX_PRESENCE_SUBSCRIBERS ||
          sockets.filter((socket) => this.attachment(socket).clientHash === clientHash).length >=
            MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT
        if (capacity) return false
        if (revocable === '1') {
          const token = await this.sql.readAccessToken(tokenHash)
          if (token === null || token.scope !== credentialScope) return false
        }
        if (anonymous === '0')
          await this.sql.regions.renewRegions(tokenHash, painter.wplaceUserId, Date.now())
        // Share the fence with region publication so ready cannot arrive after a newer regions event.
        regions = await this.sql.regions.listRegions(season, surface)
        await this.rememberRegionExpiry(season, surface, regions)
        return true
      },
      async () => {
        const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const attachment: Attachment = {
          sessionId,
          season,
          surface,
          painter,
          tokenHash,
          clientHash,
          ...(publisherId === null ? {} : { publisherId }),
          credentialScope,
          anonymous: anonymous === '1',
          revocable: revocable === '1',
          metricClient: metric.client,
          metricClientVersion: metric.clientVersion,
          viewport: null,
          draftRect: null,
          draftPixels: 0,
          lastSeenAt: Date.now(),
          renewedAt: Date.now(),
        }
        const pair = this.state.connect(attachment)
        const sockets = this.sockets()
        const peers = this.relevant(
          attachment,
          sockets.map((socket) => this.peer(this.attachment(socket))),
        )
        this.sent.set(sessionId, new Set(peers.map((peer) => peer.sessionId)))
        this.onlineSent.set(sessionId, sockets.length)
        this.send(pair.server, {
          type: 'presence-ready',
          sessionId,
          online: sockets.length,
          peers,
          regions,
          ownedRegionIds: await this.ownedRegionIds(attachment),
          canWrite: credentialScope !== 'read' && anonymous === '0',
        })
        this.dirty.add(sessionId)
        this.armTick()
        await this.armAlarm()
        return pair
      },
    )
    if (capacity)
      return new Response('Presence subscriber limit reached', {
        status: 503,
        headers: { 'Retry-After': '30' },
      })
    if (pair === null) return new Response('Credential revoked', { status: 401 })
    const responseHeaders = new Headers()
    if (
      headers
        .get('sec-websocket-protocol')
        ?.split(',')
        .some((protocol) => protocol.trim() === PRESENCE_PROTOCOL_V1)
    )
      responseHeaders.set('sec-websocket-protocol', PRESENCE_PROTOCOL_V1)
    return this.state.upgradeResponse(pair.client, responseHeaders)
  }

  webSocketMessage(socket: LiveSocket, message: string | ArrayBuffer): void {
    const attachment = this.attachment(socket)
    if (attachment.closed) return
    const now = Date.now()
    const rate = (this.rates.get(attachment.sessionId) ?? []).filter((at) => now - at < 1_000)
    rate.push(now)
    this.rates.set(attachment.sessionId, rate)
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
    if (message === 'ping') {
      socket.send('pong')
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
    if (attachment.credentialScope === 'read') return
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
      (event.viewport != null && !presenceRectWithinSurface(event.viewport, attachment.surface)) ||
      (event.draft != null && !presenceRectWithinSurface(event.draft.rect, attachment.surface)) ||
      (viewport !== null && !presenceRectWithinSurface(viewport, attachment.surface)) ||
      (draft != null && !presenceRectWithinSurface(draft.rect, attachment.surface))
    )
      return
    if (draft !== undefined) {
      if (draft?.mask === undefined) this.masks.delete(attachment.sessionId)
      else this.masks.set(attachment.sessionId, draft.mask)
    }
    socket.serializeAttachment({
      ...attachment,
      viewport,
      draftRect: draft === undefined ? attachment.draftRect : (draft?.rect ?? null),
      draftPixels: draft === undefined ? attachment.draftPixels : (draft?.pixels ?? 0),
      lastSeenAt: now,
    } satisfies Attachment)
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
    return this.sockets().length
  }

  /** Reload committed claims and deliver the surface's authoritative region list. */
  async publishRegions(season: number, surface: TemplateSurface): Promise<void> {
    const queued = performance.now()
    await this.sessions.revoke(async () =>
      ingestTimings.timed('claims', 'total', async () => {
        ingestTimings.record('claims', 'queue', performance.now() - queued)
        const regions = await ingestTimings.timed('claims', 'list', () =>
          this.sql.regions.listRegions(season, surface),
        )
        await this.rememberRegionExpiry(season, surface, regions)
        const owners = await ingestTimings.timed('claims', 'owners', () =>
          this.sql.regions.regionOwners(season, surface),
        )
        const started = performance.now()
        const snapshot = JSON.stringify(regions)
        if (snapshot !== this.regionSnapshot) {
          this.regionSnapshot = snapshot
          this.regionVersion++
        }
        const grouped = new Map<string, Map<number, string[]>>()
        for (const owner of owners) {
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
        const prefix = `{"type":"regions","regions":${snapshot},"ownedRegionIds":`
        ingestTimings.record('claims', 'serialize', performance.now() - started)
        for (const socket of this.sockets()) {
          const attachment = this.attachment(socket)
          const started = performance.now()
          const owned = JSON.stringify(
            attachment.anonymous
              ? []
              : (grouped.get(attachment.tokenHash)?.get(attachment.painter.wplaceUserId) ?? []),
          )
          const previous = this.claimsSent.get(attachment.sessionId)
          ingestTimings.record('claims', 'serialize', performance.now() - started)
          // Ownership can change without changing public geometry. Compare both, inside the
          // revocation fence, and forget delivery state on disconnect or hibernation recovery.
          if (previous?.version === this.regionVersion && previous.owned === owned) continue
          this.claimsSent.set(attachment.sessionId, { version: this.regionVersion, owned })
          this.sendEncoded(socket, `${prefix}${owned}}`)
        }
        await this.armAlarm()
      }),
    )
  }

  private async ownedRegionIds(attachment: Attachment): Promise<readonly string[]> {
    if (attachment.anonymous) return []
    const owners = await ingestTimings.timed('claims', 'owners', () =>
      this.sql.regions.regionOwners(attachment.season, attachment.surface),
    )
    return owners
      .filter(
        ({ tokenHash, actorId }) =>
          tokenHash === attachment.tokenHash && actorId === attachment.painter.wplaceUserId,
      )
      .map(({ id }) => id)
  }

  private async rememberRegionExpiry(
    season: number,
    surface: TemplateSurface,
    regions: readonly RegionClaim[],
  ): Promise<void> {
    // A loop rather than a spread: the region list is unbounded and V8 caps call arguments.
    let at = Number.POSITIVE_INFINITY
    for (const region of regions)
      if (region.expiresAt !== undefined && region.expiresAt < at) at = region.expiresAt
    await this.state.storage.put('region-expiry', {
      season,
      surface,
      at: Number.isFinite(at) ? at : null,
    } satisfies RegionExpiry)
  }

  /** Fence revocation against the second D1 credential check and socket acceptance. */
  async closeCredential(tokenHash: string): Promise<void> {
    await this.sessions.revoke(() => {
      for (const socket of this.sockets())
        if (this.attachment(socket).tokenHash === tokenHash)
          this.close(socket, 1008, 'credential revoked')
    })
  }
}
