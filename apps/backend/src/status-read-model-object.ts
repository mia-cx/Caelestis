import { DurableObject } from 'cloudflare:workers'
import { templateSurfaceKey } from '@caelestis/shared'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { receiveStatusLive } from './adapters/cloudflare/live-connect.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { relationalSqlStore } from './adapters/relational-sql-store.js'
import { instrumentD1, measureD1Usage } from './metrics/request-metrics.js'
import { StatusCoordinator } from './status-coordinator.js'

type Coordinator = StatusCoordinator<WebSocket>

/**
 * Cloudflare lifecycle and socket binding for one season's coordinator. The four reads a Worker
 * request waits on return the D1 work they did, so the Worker's request metric can count it.
 */
export class StatusReadModelObject extends DurableObject<Env> {
  private readonly coordinator: Coordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.coordinator = new StatusCoordinator(
      {
        storage: ctx.storage,
        getWebSockets: (tag) => ctx.getWebSockets(tag),
        connect: (attachment) => {
          const pair = new WebSocketPair()
          pair[1].serializeAttachment(attachment)
          ctx.acceptWebSocket(pair[1], ['status'])
          return { client: pair[0], server: pair[1] }
        },
        upgradeResponse: (client, headers) =>
          new Response(null, { status: 101, headers, webSocket: client }),
      },
      relationalSqlStore(instrumentD1(env.DB)),
      new R2BlobStore(env.BLOBS),
      () => new DurableObjectCounterStore(env.TELEMETRY),
      {
        id: env.SERVER_ID,
        name: env.SERVER_NAME,
        auth: env.OPEN_ACCESS === 'true' ? 'none' : 'access_token',
        ...(env.SERVER_DESCRIPTION === undefined ? {} : { description: env.SERVER_DESCRIPTION }),
      },
      () => env.ALARM_WATCHER.getByName('global').schedule(),
      (season, tokenHash, surface) =>
        env.PRESENCE.getByName(`${season}:${templateSurfaceKey(surface)}`).closeCredential(
          tokenHash,
        ),
      env.REQUEST_METRICS,
    )
  }
  applyCommittedChange(...args: Parameters<Coordinator['applyCommittedChange']>) {
    return measureD1Usage(() => this.coordinator.applyCommittedChange(...args))
  }
  reconcileSnapshot(...args: Parameters<Coordinator['reconcileSnapshot']>) {
    return measureD1Usage(() => this.coordinator.reconcileSnapshot(...args))
  }
  readManifestProjection(...args: Parameters<Coordinator['readManifestProjection']>) {
    return measureD1Usage(() => this.coordinator.readManifestProjection(...args))
  }
  resolveCurrentTileOffers(...args: Parameters<Coordinator['resolveCurrentTileOffers']>) {
    return measureD1Usage(() => this.coordinator.resolveCurrentTileOffers(...args))
  }
  notifyManifestChange(...args: Parameters<Coordinator['notifyManifestChange']>) {
    return this.coordinator.notifyManifestChange(...args)
  }
  prepareTileGenerationCommit(...args: Parameters<Coordinator['prepareTileGenerationCommit']>) {
    return this.coordinator.prepareTileGenerationCommit(...args)
  }
  applyCommittedTileGeneration(...args: Parameters<Coordinator['applyCommittedTileGeneration']>) {
    return this.coordinator.applyCommittedTileGeneration(...args)
  }
  finishTileGenerationCommit(...args: Parameters<Coordinator['finishTileGenerationCommit']>) {
    return this.coordinator.finishTileGenerationCommit(...args)
  }
  readIngestTimings(...args: Parameters<Coordinator['readIngestTimings']>) {
    return this.coordinator.readIngestTimings(...args)
  }
  notifyAlarmChange(...args: Parameters<Coordinator['notifyAlarmChange']>) {
    return this.coordinator.notifyAlarmChange(...args)
  }
  notifyDashboardChange(...args: Parameters<Coordinator['notifyDashboardChange']>) {
    return this.coordinator.notifyDashboardChange(...args)
  }
  closeCredential(...args: Parameters<Coordinator['closeCredential']>) {
    return this.coordinator.closeCredential(...args)
  }
  registerPresenceSurface(...args: Parameters<Coordinator['registerPresenceSurface']>) {
    return this.coordinator.registerPresenceSurface(...args)
  }
  override fetch(request: Request) {
    return receiveStatusLive(request, (connection) => this.coordinator.connect(connection))
  }
  override webSocketMessage(...args: Parameters<Coordinator['webSocketMessage']>) {
    return this.coordinator.webSocketMessage(...args)
  }
  override webSocketClose(...args: Parameters<Coordinator['webSocketClose']>) {
    return this.coordinator.webSocketClose(...args)
  }
}
