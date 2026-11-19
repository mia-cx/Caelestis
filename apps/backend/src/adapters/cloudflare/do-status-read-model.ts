import type { LiveSyncPort } from '../../live/port.js'
import {
  MEASURED_STATUS_METHODS,
  STATUS_SHARD_METHODS,
  type StatusShard,
  statusShardName,
} from '../../status-read-model/shard.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { forwardingClient } from './forwarding-object.js'
import { forwardStatusLive } from './live-connect.js'

/** Each season's Durable Object as a status shard, resolved per call for the calling request. */
export const durableStatusShards =
  (namespace: DurableObjectNamespace<StatusReadModelObject>) =>
  (season: number): StatusShard =>
    forwardingClient<StatusShard>()(
      namespace.getByName(statusShardName(season)),
      STATUS_SHARD_METHODS,
      MEASURED_STATUS_METHODS,
    )

/** Live sync through the season's Durable Object, which holds the socket. */
export const durableLiveSync =
  (namespace: DurableObjectNamespace<StatusReadModelObject>): LiveSyncPort['connect'] =>
  (connection, request) =>
    forwardStatusLive(namespace.getByName(statusShardName(connection.season)), request, connection)
