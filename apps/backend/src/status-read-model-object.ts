import { DurableObject } from 'cloudflare:workers'
import {
  alarmWatcher,
  cloudflareConfig,
  cloudflareStores,
  durablePresenceRooms,
} from './adapters/cloudflare/bindings.js'
import { receiveStatusLive } from './adapters/cloudflare/live-connect.js'
import { durableLiveHost } from './adapters/cloudflare/live-host.js'
import { measureD1Usage } from './metrics/request-metrics.js'
import { serverInfo } from './server/info.js'
import { StatusCoordinator } from './status-read-model/coordinator.js'

type Coordinator = StatusCoordinator<WebSocket>

/**
 * One season's status coordinator. The four reads a Worker request waits on return the D1 work
 * they did, so the Worker's request metric can count it.
 */
export class StatusReadModelObject extends DurableObject<Env> {
  private readonly coordinator: Coordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const config = cloudflareConfig(env)
    const { sql, blobs, counters } = cloudflareStores(env)
    const rooms = durablePresenceRooms(env)
    this.coordinator = new StatusCoordinator(
      durableLiveHost(ctx, 'status'),
      sql,
      blobs,
      () => counters,
      serverInfo(config, config.serverId),
      () => alarmWatcher(env).schedule(),
      (season, tokenHash, surface) => rooms(season, surface).closeCredential(tokenHash),
      env.REQUEST_METRICS,
      { liveSubscribers: config.liveSubscriberLimit },
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
