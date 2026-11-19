import {
  alarmWatcher,
  cloudflareBindings,
  cloudflareConfig,
  durablePresenceRooms,
} from './adapters/cloudflare/bindings.js'
import { forwardingObject } from './adapters/cloudflare/forwarding-object.js'
import { receiveStatusLive } from './adapters/cloudflare/live-connect.js'
import { durableLiveHost } from './adapters/cloudflare/live-host.js'
import { serverInfo } from './server/info.js'
import { StatusCoordinator } from './status-read-model/coordinator.js'
import {
  MEASURED_STATUS_METHODS,
  parseStatusShardName,
  STATUS_SHARD_METHODS,
} from './status-read-model/shard.js'

type Coordinator = StatusCoordinator<WebSocket>

/** One season's status coordinator, named `statusShardName(season)`. */
export class StatusReadModelObject extends forwardingObject<Coordinator>()(
  [...STATUS_SHARD_METHODS, 'webSocketMessage', 'webSocketClose'],
  MEASURED_STATUS_METHODS,
) {
  protected readonly target: Coordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const season = parseStatusShardName(ctx.id.name ?? '')
    if (season === null) throw new Error(`Status shard name ${ctx.id.name} names no season`)
    const config = cloudflareConfig(env)
    const {
      stores: { sql, blobs },
      counters,
    } = cloudflareBindings(env)
    const rooms = durablePresenceRooms(env)
    this.target = new StatusCoordinator(
      durableLiveHost(ctx, 'status'),
      season,
      sql,
      blobs,
      () => counters,
      serverInfo(config, config.serverId),
      () => alarmWatcher(env).schedule(),
      (tokenHash, surface) => rooms(season, surface).closeCredential(tokenHash),
      env.REQUEST_METRICS,
      { liveSubscribers: config.liveSubscriberLimit },
    )
  }
  override fetch(request: Request) {
    return receiveStatusLive(request, (connection) => this.target.connect(connection))
  }
}
