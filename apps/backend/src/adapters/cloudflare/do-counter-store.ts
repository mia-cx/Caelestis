import { TELEMETRY_SHARD_METHODS, type TelemetryCoordinator } from '../../coordination/telemetry.js'
import type { TelemetryShard } from '../../telemetry-shard.js'
import { forwardingClient } from './forwarding-object.js'

const SINGLE_SHARD_NAME = 'telemetry'

/**
 * The telemetry shard's Durable Object as the counter store and archive. A stale-operation
 * rejection keeps its `name` across RPC, which the restore matches on.
 */
export const durableCounters = (namespace: DurableObjectNamespace<TelemetryShard>) =>
  forwardingClient<TelemetryCoordinator>()(
    () => namespace.getByName(SINGLE_SHARD_NAME),
    TELEMETRY_SHARD_METHODS,
  )
