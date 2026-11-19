import {
  type ContributionsResponse,
  decodeLiveTileUpload,
  encodeLiveServerEvent,
  exceedsUtf8Bytes,
  frameLiveServerEvent,
  type LeaderboardResponse,
  type LiveDashboardSubscription,
  LivePaintAssembler,
  LivePaintAssemblyError,
  type LiveProjectionState,
  type LiveSyncClientEvent,
  type LiveSyncServerEvent,
  type LiveTileUpload,
  MAX_LIVE_MESSAGE_BYTES,
  parseTemplateSurfaceKey,
  parseTileKey,
  type ServerInfo,
  type StatusDelta,
  seconds,
  sha256Hex,
  type TemplateSurface,
  type TileCoord,
  templateSurfaceKey,
} from '@caelestis/shared'
import {
  LiveSyncClientEvent as LiveSyncClientEventSchema,
  LiveTileUpload as LiveTileUploadSchema,
  PaintEvent as PaintEventSchema,
} from '@caelestis/wire-schema'
import { Effect, Schema } from 'effect'
import {
  mayReport,
  paintResult,
  parseOfferBatch,
  tileOfferResult,
  tileUploadResult,
} from '../live/replies.js'
import {
  createLiveSessionFence,
  type LiveHost,
  type LiveSocket,
  type LiveSubscriberAttachment,
  MAX_LIVE_ANONYMOUS_SUBSCRIBERS,
  MAX_LIVE_CLIENT_BINARY_BYTES,
  MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS,
  MAX_LIVE_SUBSCRIBERS,
  MAX_LIVE_SUBSCRIBERS_PER_CLIENT,
  type StatusLiveConnection,
  subscriberOf,
} from '../live/session.js'
import { createChunkedManifestPersistence } from '../manifest/persistence.js'
import type { ManifestProjectionInput, ManifestProjectionRead } from '../manifest/read-model.js'
import { type CacheOutcome, recordLiveTileOfferCacheMetric } from '../metrics/request-metrics.js'
import type { BlobStore, CounterStore, SqlStore } from '../ports/index.js'
import {
  type BackendRuntime,
  createBackendRuntime,
  makeBackendContext,
} from '../runtime/backend-runtime.js'
import { ValidationError } from '../runtime/errors.js'
import { MAX_CANVAS_TILE_BYTES, offerTiles, uploadTile } from '../telemetry/ingest.js'
import { type IngestTimingSnapshot, ingestTimings } from '../telemetry/ingest-timing.js'
import { recordPaint } from '../telemetry/paint.js'
import { readAlarms, readContributions, readLeaderboard } from '../telemetry/queries.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
  StatusVisibilityScope,
} from './model.js'
import { createKeyedStatusPersistence } from './persistence.js'
import type { StatusReadModelPort } from './port.js'
import { createSeasonReadModels, type SeasonReadModels } from './season.js'
import type {
  CommittedTileGeneration,
  PreparedTileGenerationCommit,
  TileGenerationCacheRead,
  TileGenerationOffer,
} from './tile-generation-cache.js'

const MAX_DELTA_MESSAGE_BYTES = 32 * 1024
const MAX_DASHBOARD_SUBSCRIPTIONS = 4

/** A live connection's answer, and how the status projection served its first read. */
export interface LiveAdmission {
  readonly response: Response
  readonly cacheOutcome: CacheOutcome
}

/** A subscriber's socket with its attachment, read once for the operation at hand. */
interface Subscriber {
  readonly socket: LiveSocket
  readonly attachment: LiveSubscriberAttachment
}

const tryEncode = (event: LiveSyncServerEvent): readonly string[] | null => {
  try {
    return encodeLiveServerEvent(event)
  } catch {
    return null
  }
}

/** Start each keyed read once per broadcast and hand every subscriber the same promise. */
const onePerKey = <A>() => {
  const pending = new Map<string, Promise<A>>()
  return (key: string, read: () => Promise<A>): Promise<A> => {
    let held = pending.get(key)
    if (held === undefined) {
      held = read()
      pending.set(key, held)
    }
    return held
  }
}

/** The surface a manifest projection names, or null for alarms or a resource its scope contradicts. */
const manifestSurface = (projection: LiveProjectionState): TemplateSurface | null => {
  if (projection.resource === 'telemetry-alarms') return null
  const surface = parseTemplateSurfaceKey(projection.scope)
  return surface !== null &&
    (projection.resource === 'world-manifest') === (surface.kind === 'world')
    ? surface
    : null
}

/** Live sync for one season: its read models, its subscribers, and the commands they send. */
export class StatusCoordinator<Client> {
  private boundSeason: number | null = null
  private readModels: SeasonReadModels | null = null
  private readonly liveSessions = createLiveSessionFence()
  private readonly paints = new LivePaintAssembler()
  /** Dashboard changes notified so far; a refresh repeats until it has served the latest. */
  private dashboardChanges = 0
  private dashboardRefreshing = false
  private runtime: BackendRuntime | null = null

  constructor(
    private readonly objectState: LiveHost<Client>,
    private readonly sql: SqlStore,
    private readonly blobs: BlobStore,
    private readonly counters: () => CounterStore,
    /** The deployment's identity, as `serverInfo` builds it for every manifest. */
    private readonly server: ServerInfo,
    private readonly scheduleAlarms: () => Promise<void>,
    private readonly closePresence: (
      season: number,
      tokenHash: string,
      surface: TemplateSurface,
    ) => Promise<void>,
    private readonly requestMetrics?: Pick<AnalyticsEngineDataset, 'writeDataPoint'>,
    /** Deployment overrides; the defaults are the production limits. */
    private readonly limits: { readonly liveSubscribers?: number } = {},
  ) {}

  /** Live commands run here, so the read model they write through is this coordinator. */
  private backendRuntime(): BackendRuntime {
    if (this.runtime !== null) return this.runtime
    const liveReadModel: StatusReadModelPort = {
      applyCommittedChange: (season, mutation) => this.applyCommittedChange(season, mutation),
      reconcileSnapshot: (season, scope) => this.reconcileSnapshot(season, scope),
      readManifestProjection: (input) => this.readManifestProjection(input),
      notifyManifestChange: (season, surface, affectsTileCoverage) =>
        this.notifyManifestChange(season, surface, affectsTileCoverage),
      resolveCurrentTileOffers: (season, scope, offers) =>
        this.resolveCurrentTileOffers(season, scope, offers),
      prepareTileGenerationCommit: (season, tile) => this.prepareTileGenerationCommit(season, tile),
      applyCommittedTileGeneration: (season, generation) =>
        this.applyCommittedTileGeneration(season, generation),
      finishTileGenerationCommit: (season, tile, commit) =>
        this.finishTileGenerationCommit(season, tile, commit),
      notifyDashboardChange: (season) => this.notifyDashboardChange(season),
      notifyAlarmChange: async (season) => {
        const results = await Promise.allSettled([
          this.scheduleAlarms(),
          this.notifyAlarmChange(season),
        ])
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (errors.length > 0) throw new AggregateError(errors, 'Alarm notification failed')
      },
      closeCredential: (season, tokenHash) => this.closeCredential(season, tokenHash),
      readIngestTimings: (_season, reset) => this.readIngestTimings(reset),
    }
    this.runtime = createBackendRuntime(
      makeBackendContext(this.blobs, this.sql, this.counters(), liveReadModel),
    )
    return this.runtime
  }

  /** This coordinator's read models; the first season asked for binds it for good. */
  private season(season: number): SeasonReadModels {
    if (!Number.isSafeInteger(season) || season < 0)
      throw new RangeError('season must be non-negative')
    if (this.boundSeason !== null && this.boundSeason !== season)
      throw new Error('Durable Object is already bound to a season')
    this.boundSeason = season
    this.readModels ??= createSeasonReadModels({
      season,
      sql: this.sql,
      persistence: {
        status: createKeyedStatusPersistence(this.objectState.storage, season),
        manifest: createChunkedManifestPersistence(this.objectState.storage, season),
      },
    })
    return this.readModels
  }

  private send(socket: LiveSocket, event: LiveSyncServerEvent): void {
    this.sendEncoded(socket, tryEncode(event))
  }

  /**
   * Deliver an already-encoded event, so one encoding can serve many subscribers. `null` is an
   * event that could not be encoded, which closes the socket as a failed send does.
   */
  private sendEncoded(socket: LiveSocket, messages: readonly string[] | null): void {
    try {
      if (messages === null) throw new RangeError('live event could not be encoded')
      for (const message of messages) socket.send(message)
    } catch {
      try {
        socket.close(1011, 'live sync send failed')
      } catch {}
    }
  }

  /** Encode once and deliver the same messages to every subscriber. */
  private broadcast(subscribers: readonly Subscriber[], event: LiveSyncServerEvent): void {
    if (subscribers.length === 0) return
    const messages = tryEncode(event)
    for (const { socket } of subscribers) this.sendEncoded(socket, messages)
  }

  /** The snapshot one projection subscriber is owed, or null when it has none. */
  private async projectionSnapshot(
    attachment: LiveSubscriberAttachment,
    projection: LiveProjectionState,
  ): Promise<LiveSyncServerEvent | null> {
    if (projection.resource === 'telemetry-alarms') {
      if (projection.scope !== 'world') return null
      const alarms = await this.backendRuntime().run(
        readAlarms(attachment.season, attachment.scope === 'admin'),
      )
      return { type: 'alarms-snapshot', alarms }
    }
    const surface = manifestSurface(projection)
    if (surface === null) return null
    const read = await this.season(attachment.season).readManifest({
      server: this.server,
      season: attachment.season,
      surface,
      scope: attachment.scope,
      ifNoneMatch: [],
    })
    if (read.notModified) return null
    return {
      type: 'manifest-snapshot',
      resource: projection.resource,
      scope: projection.scope,
      manifest: read.manifest,
    }
  }

  private async sendProjectionSnapshot(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment,
    projection: LiveProjectionState,
  ): Promise<void> {
    const event = await this.projectionSnapshot(attachment, projection)
    if (event !== null) this.send(socket, event)
  }

  private async liveProjectionVersion(
    season: number,
    scope: StatusVisibilityScope,
    projection: LiveProjectionState,
  ): Promise<string | null> {
    if (projection.resource === 'telemetry-alarms') {
      if (projection.scope !== 'world') return null
      const alarms = await this.sql.readActiveAlarms(season, scope === 'admin')
      return sha256Hex(new TextEncoder().encode(JSON.stringify(alarms)))
    }
    const surface = manifestSurface(projection)
    if (surface === null) return null
    return this.season(season).knownManifestVersion(scope, surface)
  }

  private async reconcileLiveState(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment,
    event: Extract<LiveSyncClientEvent, { readonly type: 'state-vector' }>,
  ): Promise<void> {
    const read = await this.season(attachment.season).status.reconcileSnapshot(attachment.scope)
    const authoritative = await Promise.all(
      event.projections.map(async (projection) => ({
        ...projection,
        version: await this.liveProjectionVersion(attachment.season, attachment.scope, projection),
      })),
    )
    if (attachment.protocol === 2) {
      if (event.revision !== read.snapshot.revision) {
        this.send(socket, { type: 'status-snapshot', status: read.snapshot })
      }
      await Promise.all(
        authoritative.map(async (projection, index) => {
          if (projection.version === event.projections[index]?.version) return
          await this.sendProjectionSnapshot(socket, attachment, projection)
        }),
      )
    }
    const usable =
      event.revision !== null &&
      event.projections.every((projection) => projection.version !== null) &&
      authoritative.every((projection) => projection.version !== null)
    this.send(socket, {
      type: 'state-correction',
      requestId: event.requestId,
      mode: usable ? 'correction' : 'snapshot',
      revision: read.snapshot.revision,
      projections: usable
        ? authoritative.filter(
            (projection, index) => projection.version !== event.projections[index]?.version,
          )
        : authoritative,
    })
  }

  /** Open, unrevoked subscribers of this season, optionally of one visibility scope. */
  private subscribers(scope?: StatusVisibilityScope): readonly Subscriber[] {
    return this.objectState.getWebSockets('status').flatMap((socket) => {
      const attachment = subscriberOf(socket)
      return attachment !== null &&
        attachment.season === this.boundSeason &&
        attachment.revoked !== true &&
        (scope === undefined || attachment.scope === scope)
        ? [{ socket, attachment }]
        : []
    })
  }

  /** Subscribers that speak protocol 2, the only ones owed snapshots. */
  private snapshotSubscribers(): readonly Subscriber[] {
    return this.subscribers().filter(({ attachment }) => attachment.protocol === 2)
  }

  private broadcastStatus(scope: StatusVisibilityScope, delta: StatusDelta): void {
    const subscribers = this.subscribers(scope)
    if (subscribers.length === 0) return
    // Serialize once to measure the delta, then frame that same text for every subscriber.
    const encoded = JSON.stringify({ type: 'status-delta', delta } satisfies LiveSyncServerEvent)
    if (exceedsUtf8Bytes(encoded, MAX_DELTA_MESSAGE_BYTES)) {
      this.broadcast(subscribers, { type: 'status-reconcile', revision: delta.revision })
      return
    }
    const messages = frameLiveServerEvent(encoded)
    for (const { socket } of subscribers) this.sendEncoded(socket, messages)
  }

  async applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    const status = this.season(season).status
    const change = await status.applyCommittedChange(mutation)
    if (change === null) {
      const snapshot = await status.reconcileSnapshot('public')
      this.broadcast(this.subscribers(), {
        type: 'status-reconcile',
        revision: snapshot.snapshot.revision,
      })
    } else {
      this.broadcastStatus('public', change.public)
      this.broadcastStatus('admin', change.admin)
    }
    return change
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    if (scope !== 'public' && scope !== 'admin') throw new RangeError('invalid visibility scope')
    return this.season(season).status.reconcileSnapshot(scope)
  }

  async readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    const projection = await this.season(input.season).readManifest(input)
    if (projection.revisionChanged) this.broadcastManifest(projection.revision)
    return projection
  }

  private broadcastManifest(revision: number, surface?: TemplateSurface): void {
    this.broadcast(this.subscribers(), {
      type: 'manifest-reconcile',
      revision,
      ...(surface === undefined ? {} : { surface }),
    })
  }

  private async broadcastManifestSnapshots(surface?: TemplateSurface): Promise<void> {
    // Subscribers that share a visibility scope and projection are owed the same bytes, so each
    // audience costs one read and one encoding however many sockets it has. `undefined` means the
    // audience is owed nothing; `null` is an event `sendEncoded` cannot deliver.
    const audiences = onePerKey<readonly string[] | null | undefined>()
    const snapshotFor = (attachment: LiveSubscriberAttachment, projection: LiveProjectionState) =>
      audiences(
        `${attachment.season}:${attachment.scope}:${projection.resource}:${projection.scope}`,
        async () => {
          const event = await this.projectionSnapshot(attachment, projection)
          return event === null ? undefined : tryEncode(event)
        },
      )
    await Promise.all(
      this.snapshotSubscribers().map(async ({ socket, attachment }) => {
        for (const projection of attachment.projections ?? []) {
          const requested = manifestSurface(projection)
          if (
            requested === null ||
            (surface !== undefined && templateSurfaceKey(requested) !== templateSurfaceKey(surface))
          ) {
            continue
          }
          const messages = await snapshotFor(attachment, projection)
          if (messages !== undefined) this.sendEncoded(socket, messages)
        }
      }),
    )
  }

  async notifyManifestChange(
    season: number,
    surface?: TemplateSurface,
    affectsTileCoverage = true,
  ): Promise<void> {
    const revision = await this.season(season).invalidateManifest(surface, affectsTileCoverage)
    this.broadcastManifest(revision, surface)
    await Promise.all([
      this.broadcastManifestSnapshots(surface),
      // Which alarms a caller sees follows the templates on a surface. Metadata-only edits, such as
      // work, tags and folders, leave every alarm and its visibility unchanged.
      surface === undefined || !affectsTileCoverage
        ? Promise.resolve()
        : this.broadcastAlarmSnapshots(),
    ])
  }

  async resolveCurrentTileOffers(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    return this.season(season).resolveTileOffers(scope, offers)
  }

  prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    return this.season(season).prepareTileCommit(tile)
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    return this.season(season).applyTileGeneration(generation)
  }

  finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    return this.season(season).finishTileCommit(tile, commit)
  }

  /** Stage timings for the live commands this coordinator handled since the last reset. */
  async readIngestTimings(reset: boolean): Promise<IngestTimingSnapshot> {
    const snapshot = ingestTimings.snapshot()
    if (reset) ingestTimings.reset()
    return snapshot
  }

  async notifyAlarmChange(season: number): Promise<void> {
    this.season(season)
    this.broadcast(this.subscribers(), { type: 'alarms-reconcile' })
    await this.broadcastAlarmSnapshots()
  }

  private async broadcastAlarmSnapshots(): Promise<void> {
    // One read and one encoding per season and scope, not one per subscriber: with hundreds of
    // sockets, a query each would starve every live command queued behind them.
    const encoded = onePerKey<readonly string[] | null>()
    const snapshotFor = ({ season, scope }: LiveSubscriberAttachment) =>
      encoded(`${season}:${scope}`, async () =>
        tryEncode({
          type: 'alarms-snapshot',
          alarms: await this.backendRuntime().run(readAlarms(season, scope === 'admin')),
        }),
      )
    await Promise.all(
      this.snapshotSubscribers().map(async ({ socket, attachment }) => {
        this.sendEncoded(socket, await snapshotFor(attachment))
      }),
    )
  }

  /**
   * Dashboard reads for one moment. Subscriptions asking the same question of the same visibility
   * scope share one read, so equal dashboards on many sockets cost what one does.
   */
  private dashboardReads() {
    const now = seconds(Math.floor(Date.now() / 1_000) + 1)
    const contributionReads = onePerKey<ContributionsResponse>()
    const leaderboardReads = onePerKey<LeaderboardResponse>()
    return async (
      attachment: LiveSubscriberAttachment,
      subscription: LiveDashboardSubscription,
    ): Promise<LiveSyncServerEvent | null> => {
      if (subscription.contributionsFrom >= now) return null
      const includeUnpublished = attachment.scope === 'admin'
      const audience = `${attachment.season}:${attachment.scope}:${JSON.stringify(subscription.templateIds)}`
      const [contributions, leaderboard] = await Promise.all([
        contributionReads(`${audience}:${subscription.contributionsFrom}`, () =>
          this.backendRuntime().run(
            readContributions({
              templateIds: subscription.templateIds,
              range: { fromSeconds: subscription.contributionsFrom, toSeconds: now },
              includeUnpublished,
            }),
          ),
        ),
        leaderboardReads(`${audience}:${subscription.leaderboardLimit}`, () =>
          this.backendRuntime().run(
            readLeaderboard({
              season: attachment.season,
              templateIds: subscription.templateIds,
              limit: subscription.leaderboardLimit,
              includeUnpublished,
            }),
          ),
        ),
      ])
      return {
        type: 'dashboard-snapshot',
        subscriptionId: subscription.subscriptionId,
        contributions,
        leaderboard,
      }
    }
  }

  private async broadcastDashboardSnapshots(): Promise<void> {
    const snapshot = this.dashboardReads()
    await Promise.all(
      this.snapshotSubscribers().flatMap(({ socket, attachment }) =>
        (attachment.dashboardSubscriptions ?? []).map(async (subscription) => {
          const event = await snapshot(attachment, subscription)
          if (event !== null) this.send(socket, event)
        }),
      ),
    )
  }

  /**
   * Schedule a dashboard refresh and return without waiting for it, so a paint is acknowledged
   * before its subscribers are. Changes that arrive during a refresh share one more refresh, which
   * starts after they landed.
   */
  async notifyDashboardChange(season: number): Promise<void> {
    this.season(season)
    this.dashboardChanges++
    if (this.dashboardRefreshing) return
    this.dashboardRefreshing = true
    // A later task, not a microtask: synchronous drivers such as SQLite would otherwise run the
    // reads before the paint that notified is acknowledged.
    setTimeout(() => void this.refreshDashboards(), 0)
  }

  private async refreshDashboards(): Promise<void> {
    let served = -1
    try {
      while (served !== this.dashboardChanges) {
        served = this.dashboardChanges
        try {
          await this.broadcastDashboardSnapshots()
        } catch (error) {
          // A missed refresh is repaired by the next paint or a resubscribe.
          console.error('dashboard refresh failed', error)
        }
      }
    } finally {
      this.dashboardRefreshing = false
    }
  }

  /** Paint, offer and upload commands need protocol 2 and a credential that may report. */
  private canReport(
    attachment: LiveSubscriberAttachment | null,
    season: number,
  ): attachment is LiveSubscriberAttachment {
    return attachment?.protocol === 2 && mayReport(attachment, season)
  }

  private async handlePaintReport(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'paint-report' }>,
  ): Promise<void> {
    const reply = (outcome: Parameters<typeof paintResult>[2]) =>
      this.send(socket, paintResult(event.requestId, event.event.eventId, outcome))
    if (!this.canReport(attachment, event.event.season)) return reply('forbidden')
    try {
      reply(
        await ingestTimings.timed('paint', 'total', () =>
          this.backendRuntime().run(
            recordPaint(event.event, attachment.tokenHash, attachment.scope === 'admin'),
          ),
        ),
      )
    } catch {
      reply('unavailable')
    }
  }

  private async handlePaintPart(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    part: Extract<LiveSyncClientEvent, { readonly type: 'paint-part' }>,
  ): Promise<void> {
    const reject = (error: 'forbidden' | 'invalid' | 'unavailable') => {
      this.paints.discard(socket)
      this.send(socket, paintResult(part.requestId, part.eventId, error))
    }
    if (!this.canReport(attachment, part.season)) return reject('forbidden')
    let encoded: string | null
    try {
      encoded = this.paints.push(socket, part)
    } catch (error) {
      if (error instanceof LivePaintAssemblyError) return reject(error.code)
      throw error
    }
    if (encoded === null) {
      this.send(socket, {
        type: 'paint-part-result',
        requestId: part.requestId,
        eventId: part.eventId,
        index: part.index,
      })
      return
    }
    try {
      const event = (() => {
        try {
          return Schema.decodeUnknownSync(PaintEventSchema)(JSON.parse(encoded))
        } catch {
          return null
        }
      })()
      if (event === null || event.eventId !== part.eventId || event.season !== part.season)
        return reject('invalid')
      await this.handlePaintReport(socket, attachment, {
        type: 'paint-report',
        requestId: part.requestId,
        event,
      })
    } finally {
      this.paints.finish(socket)
    }
  }

  private async handleTileOffer(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'tile-offer' }>,
  ): Promise<void> {
    const reply = (outcome: Parameters<typeof tileOfferResult>[1]) =>
      this.send(socket, tileOfferResult(event.requestId, outcome))
    if (!this.canReport(attachment, event.batch.season)) return reply('forbidden')
    if (parseOfferBatch(event.batch) === null) return reply('invalid')
    try {
      const result = await ingestTimings.timed('offer', 'total', () =>
        this.backendRuntime().run(
          offerTiles({
            season: event.batch.season,
            reporter: {
              wplaceUserId: event.batch.wplaceUserId,
              displayName: event.batch.displayName,
              tokenHash: attachment.tokenHash,
            },
            includeUnpublished: attachment.scope === 'admin',
            offers: event.batch.offers,
          }),
        ),
      )
      const deliveryOf = new Map<string, string>(
        event.batch.offers.map((offer) => [offer.tile, offer.deliveryId]),
      )
      const deliveries = (tiles: readonly string[]) =>
        tiles.flatMap((tile) => {
          const deliveryId = deliveryOf.get(tile)
          return deliveryId === undefined ? [] : [deliveryId]
        })
      const { coverageToken } = result
      reply({
        acknowledgedDeliveryIds: deliveries(result.acknowledged),
        wanted: deliveries(result.wanted).map((deliveryId) =>
          coverageToken === undefined ? { deliveryId } : { deliveryId, coverageToken },
        ),
        rejectedDeliveryIds: deliveries(result.rejected),
      })
    } catch {
      reply('unavailable')
    }
  }

  private async handleTileOfferCache(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'tile-offer-cache' }>,
    startedAt: number,
  ): Promise<void> {
    const unresolvedDeliveryIds = event.batch.offers.map((offer) => offer.deliveryId)
    const refuse = (error: 'forbidden' | 'invalid') =>
      this.send(socket, {
        type: 'tile-offer-cache-result',
        requestId: event.requestId,
        response: { acknowledgedDeliveryIds: [], unresolvedDeliveryIds, error },
      })
    // Unlike the commands that write, a cache read is open to protocol 1 reporters too.
    if (!mayReport(attachment, event.batch.season)) return refuse('forbidden')
    const parsed = parseOfferBatch(event.batch)
    if (parsed === null) return refuse('invalid')
    const response = this.season(event.batch.season).resolveTileOffers(
      attachment.scope,
      parsed.map(({ offer, tile }) => ({ deliveryId: offer.deliveryId, tile, hash: offer.sha256 })),
    )
    recordLiveTileOfferCacheMetric(this.requestMetrics, {
      client: attachment.metricClient ?? 'unknown',
      clientVersion: attachment.metricClientVersion ?? 'unknown',
      cacheOutcome: response.cacheOutcome,
      requested: event.batch.offers.length,
      acknowledged: response.acknowledgedDeliveryIds.length,
      durationMs: performance.now() - startedAt,
    })
    this.send(socket, {
      type: 'tile-offer-cache-result',
      requestId: event.requestId,
      response: {
        acknowledgedDeliveryIds: response.acknowledgedDeliveryIds,
        unresolvedDeliveryIds: response.unresolvedDeliveryIds,
      },
    })
  }

  private async handleTileUpload(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    message: ArrayBuffer,
  ): Promise<void> {
    const frame = decodeLiveTileUpload(message)
    const metadata: LiveTileUpload | null = (() => {
      if (frame === null) return null
      try {
        return Schema.decodeUnknownSync(LiveTileUploadSchema)(frame.metadata)
      } catch {
        return null
      }
    })()
    if (frame === null || metadata === null) {
      socket.close(1003, 'invalid live tile upload')
      return
    }
    const reply = (error?: Parameters<typeof tileUploadResult>[2]) =>
      this.send(socket, tileUploadResult(metadata.requestId, metadata.deliveryId, error))
    if (!this.canReport(attachment, metadata.season)) return reply('forbidden')
    const tile = parseTileKey(metadata.tile)
    if (tile === null || frame.payload.byteLength > MAX_CANVAS_TILE_BYTES) return reply('invalid')
    try {
      const upload = uploadTile(
        {
          wplaceUserId: metadata.wplaceUserId,
          displayName: metadata.displayName,
          tokenHash: attachment.tokenHash,
          season: metadata.season,
          tile,
          hash: metadata.sha256,
          observedAt: seconds(metadata.ts),
          includeUnpublished: attachment.scope === 'admin',
        },
        frame.payload,
      )
      reply(
        await ingestTimings.timed('upload', 'total', () =>
          this.backendRuntime().runHandled(Effect.as(upload, undefined), (error) =>
            error instanceof ValidationError ? 'invalid' : 'unavailable',
          ),
        ),
      )
    } catch {
      reply('unavailable')
    }
  }

  private async handleDashboardSubscription(
    socket: LiveSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'dashboard-subscribe' }>,
  ): Promise<void> {
    if (attachment?.protocol !== 2) return
    const retained = (attachment.dashboardSubscriptions ?? []).filter(
      (subscription) => subscription.subscriptionId !== event.subscription.subscriptionId,
    )
    if (retained.length >= MAX_DASHBOARD_SUBSCRIPTIONS) {
      socket.close(1008, 'too many dashboard subscriptions')
      return
    }
    const updated = { ...attachment, dashboardSubscriptions: [...retained, event.subscription] }
    socket.serializeAttachment(updated satisfies LiveSubscriberAttachment)
    const snapshot = await this.dashboardReads()(updated, event.subscription)
    if (snapshot !== null) this.send(socket, snapshot)
  }

  /** Persist routing before presence attachment so revocation also reaches hibernating rooms. */
  async registerPresenceSurface(
    season: number,
    tokenHash: string,
    surface: TemplateSurface,
  ): Promise<void> {
    this.season(season)
    const key = `presence:${tokenHash}:${templateSurfaceKey(surface)}`
    if ((await this.objectState.storage.get(key)) === undefined)
      await this.objectState.storage.put(key, surface)
  }

  async closeCredential(season: number, tokenHash: string): Promise<void> {
    this.season(season)
    await this.liveSessions.revoke(() => {
      for (const { socket, attachment } of this.subscribers()) {
        if (attachment.tokenHash !== tokenHash) continue
        socket.serializeAttachment({
          ...attachment,
          revoked: true,
        } satisfies LiveSubscriberAttachment)
        socket.close(1008, 'credential revoked')
      }
    })
    const rooms = await this.objectState.storage.list<TemplateSurface>({
      prefix: `presence:${tokenHash}:`,
    })
    for (const [key, surface] of rooms) {
      await this.closePresence(season, tokenHash, surface)
      await this.objectState.storage.delete(key)
    }
  }

  /** Admit one live-sync connection within the season's capacity and its credential's rights. */
  async connect(connection: StatusLiveConnection): Promise<LiveAdmission> {
    const { season, scope, tokenHash, clientHash, anonymous, revocable, protocol } = connection
    const status = this.season(season).status
    let capacityExceeded = false
    const admitted = await this.liveSessions.attach(
      async () => {
        const sockets = this.objectState.getWebSockets('status')
        if (sockets.length >= (this.limits.liveSubscribers ?? MAX_LIVE_SUBSCRIBERS)) {
          capacityExceeded = true
          return false
        }
        let anonymousConnections = 0
        let clientConnections = 0
        for (const socket of sockets) {
          const attachment = subscriberOf(socket)
          if (attachment === null || attachment.revoked === true) continue
          if (attachment.anonymous === true) anonymousConnections += 1
          if (attachment.clientHash === clientHash) clientConnections += 1
        }
        if (
          (anonymous && anonymousConnections >= MAX_LIVE_ANONYMOUS_SUBSCRIBERS) ||
          clientConnections >= MAX_LIVE_SUBSCRIBERS_PER_CLIENT
        ) {
          capacityExceeded = true
          return false
        }
        if (!revocable) return true
        const token = await this.sql.readAccessToken(tokenHash)
        return token !== null && (scope === 'public' || token.scope === 'admin')
      },
      () =>
        this.objectState.connect({
          season,
          scope,
          credentialScope: connection.credentialScope,
          tokenHash,
          clientHash,
          anonymous,
          revocable,
          lastRevision: connection.lastRevision,
          revoked: false,
          metricClient: connection.metricClient,
          metricClientVersion: connection.metricClientVersion,
          protocol,
        } satisfies LiveSubscriberAttachment),
    )
    if (capacityExceeded) {
      const response = new Response('Live subscriber limit reached', {
        status: 503,
        headers: { 'Retry-After': '30' },
      })
      return { response, cacheOutcome: 'none' }
    }
    if (admitted === null) {
      return { response: new Response('Credential revoked', { status: 401 }), cacheOutcome: 'none' }
    }
    const upgrade = async (cacheOutcome: CacheOutcome): Promise<LiveAdmission> => ({
      response: await this.objectState.upgradeResponse(
        admitted.client,
        new Headers({ 'sec-websocket-protocol': `caelestis.live.v${protocol}` }),
      ),
      cacheOutcome,
    })
    if (connection.stateVector) return upgrade('none')
    try {
      const read = await status.reconcileSnapshot(scope)
      this.send(
        admitted.server,
        connection.lastRevision === read.snapshot.revision
          ? { type: 'ready', revision: read.snapshot.revision }
          : { type: 'status-reconcile', revision: read.snapshot.revision },
      )
      return upgrade(read.cacheOutcome)
    } catch (error) {
      admitted.server.close(1011, 'status reconciliation failed')
      throw error
    }
  }

  async webSocketMessage(socket: LiveSocket, message: string | ArrayBuffer): Promise<void> {
    const startedAt = performance.now()
    const attachment = subscriberOf(socket)
    if (attachment?.revoked === true) {
      this.paints.discard(socket)
      socket.close(1008, 'credential revoked')
      return
    }
    if (typeof message === 'string' && message === 'ping') {
      socket.send('pong')
      return
    }
    if (message instanceof ArrayBuffer) {
      if (message.byteLength > MAX_LIVE_CLIENT_BINARY_BYTES) {
        socket.close(1009, 'live message too large')
        return
      }
      await this.handleTileUpload(socket, attachment, message)
      return
    }
    if (
      message.length > MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS ||
      new TextEncoder().encode(message).byteLength > MAX_LIVE_MESSAGE_BYTES
    ) {
      this.paints.discard(socket)
      socket.close(1009, 'live message too large')
      return
    }
    const raw: unknown = (() => {
      try {
        return JSON.parse(message)
      } catch {
        return null
      }
    })()
    const event: LiveSyncClientEvent | null = (() => {
      try {
        return Schema.decodeUnknownSync(LiveSyncClientEventSchema)(raw)
      } catch {
        return null
      }
    })()
    if (event === null) {
      if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'paint-part') {
        this.paints.discard(socket)
        if (
          'requestId' in raw &&
          typeof raw.requestId === 'string' &&
          raw.requestId.length <= 64 &&
          'eventId' in raw &&
          typeof raw.eventId === 'string' &&
          raw.eventId.length <= 64
        )
          this.send(socket, paintResult(raw.requestId, raw.eventId, 'invalid'))
      }
      return
    }
    switch (event.type) {
      case 'paint-part':
        return this.handlePaintPart(socket, attachment, event)
      case 'paint-report':
        return this.handlePaintReport(socket, attachment, event)
      case 'tile-offer':
        return this.handleTileOffer(socket, attachment, event)
      case 'tile-offer-cache':
        return this.handleTileOfferCache(socket, attachment, event, startedAt)
      case 'dashboard-subscribe':
        return this.handleDashboardSubscription(socket, attachment, event)
      case 'dashboard-unsubscribe':
        if (attachment?.protocol !== 2) return
        socket.serializeAttachment({
          ...attachment,
          dashboardSubscriptions: (attachment.dashboardSubscriptions ?? []).filter(
            (subscription) => subscription.subscriptionId !== event.subscriptionId,
          ),
        } satisfies LiveSubscriberAttachment)
        return
      case 'state-vector': {
        if (attachment === null) {
          socket.close(1008, 'invalid live state scope')
          return
        }
        if (attachment.stateVectorReceived === true) {
          socket.close(1008, 'state vector already received')
          return
        }
        const updated = { ...attachment, stateVectorReceived: true, projections: event.projections }
        socket.serializeAttachment(updated satisfies LiveSubscriberAttachment)
        this.season(attachment.season)
        await this.reconcileLiveState(socket, updated, event)
        return
      }
    }
  }

  webSocketClose(socket: LiveSocket, code: number, reason: string, wasClean: boolean): void {
    this.paints.discard(socket)
    try {
      socket.close(code, reason)
    } catch {
      if (!wasClean) console.error('live sync socket closed uncleanly')
    }
  }
}
