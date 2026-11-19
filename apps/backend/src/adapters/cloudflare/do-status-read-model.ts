import type { LiveSyncPort } from '../../live/port.js'
import type { MeasuredD1Operation } from '../../metrics/request-metrics.js'
import { mergeD1Usage } from '../../metrics/request-metrics.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { type StatusShard, statusShardName } from '../coordinated-status-read-model.js'
import { forwardStatusLive } from './live-connect.js'

/** Credit D1 work a Durable Object did for this request to the request's metric. */
const measured = async <A>(operation: Promise<MeasuredD1Operation<A>>): Promise<A> => {
  const result = await operation
  mergeD1Usage(result.usage)
  if (!result.success) throw result.error
  return result.value
}

/**
 * Each season's Durable Object as a status shard. A stub belongs to the request that created it,
 * so every call resolves its own.
 */
export const durableStatusShards =
  (namespace: DurableObjectNamespace<StatusReadModelObject>) =>
  (season: number): StatusShard => {
    const stub = namespace.getByName(statusShardName(season))
    return {
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
    }
  }

/** Live sync through the season's Durable Object, which holds the socket. */
export const durableLiveSync =
  (namespace: DurableObjectNamespace<StatusReadModelObject>): LiveSyncPort['connect'] =>
  (request, connection) =>
    forwardStatusLive(namespace.getByName(statusShardName(connection.season)), request, connection)
