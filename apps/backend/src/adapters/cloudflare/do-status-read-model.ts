import type { StatusLiveConnection } from '../../live/session.js'
import type { MeasuredD1Operation } from '../../metrics/request-metrics.js'
import { mergeD1Usage } from '../../metrics/request-metrics.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { CoordinatedStatusReadModel, type StatusShard } from '../coordinated-status-read-model.js'
import { forwardStatusLive } from './live-connect.js'

/** Credit D1 work a Durable Object did for this request to the request's metric. */
const measured = async <A>(operation: Promise<MeasuredD1Operation<A>>): Promise<A> => {
  const result = await operation
  mergeD1Usage(result.usage)
  if (!result.success) throw result.error
  return result.value
}

/** One season's Durable Object as a status shard. */
const shardOf = (stub: DurableObjectStub<StatusReadModelObject>): StatusShard => ({
  applyCommittedChange: (season, mutation) =>
    measured(
      mutation === undefined
        ? stub.applyCommittedChange(season)
        : stub.applyCommittedChange(season, mutation),
    ),
  reconcileSnapshot: (...args) => measured(stub.reconcileSnapshot(...args)),
  readManifestProjection: (...args) => measured(stub.readManifestProjection(...args)),
  resolveCurrentTileOffers: (...args) => measured(stub.resolveCurrentTileOffers(...args)),
  notifyManifestChange: (...args) => stub.notifyManifestChange(...args),
  prepareTileGenerationCommit: (...args) => stub.prepareTileGenerationCommit(...args),
  applyCommittedTileGeneration: (...args) => stub.applyCommittedTileGeneration(...args),
  finishTileGenerationCommit: (...args) => stub.finishTileGenerationCommit(...args),
  notifyAlarmChange: (...args) => stub.notifyAlarmChange(...args),
  notifyDashboardChange: (...args) => stub.notifyDashboardChange(...args),
  closeCredential: (...args) => stub.closeCredential(...args),
  readIngestTimings: (...args) => stub.readIngestTimings(...args),
  registerPresenceSurface: (...args) => stub.registerPresenceSurface(...args),
})

/** Resolve each season through Cloudflare's Durable Object namespace. */
export class DurableObjectStatusReadModel extends CoordinatedStatusReadModel {
  constructor(
    private readonly namespace: DurableObjectNamespace<StatusReadModelObject>,
    scheduleAlarms?: () => Promise<void>,
  ) {
    super((season) => shardOf(namespace.getByName(`season:${season}`)), scheduleAlarms)
  }

  connectLive(request: Request, connection: StatusLiveConnection): Promise<Response> {
    return forwardStatusLive(
      this.namespace.getByName(`season:${connection.season}`),
      request,
      connection,
    )
  }
}
