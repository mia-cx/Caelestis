import { cloudflareBindings, cloudflareConfig } from './adapters/cloudflare/bindings.js'
import { forwardingObject } from './adapters/cloudflare/forwarding-object.js'
import { receivePresence } from './adapters/cloudflare/live-connect.js'
import { durableLiveHost } from './adapters/cloudflare/live-host.js'
import { IngestTimings } from './metrics/ingest-timing.js'
import { PresenceCoordinator } from './presence/coordinator.js'
import { parsePresenceRoomName } from './presence/port.js'

type Coordinator = PresenceCoordinator<WebSocket>

/** One presence room, named `presenceRoomName(season, surface)`. */
export class PresenceObject extends forwardingObject<Coordinator>()([
  'online',
  'readIngestTimings',
  'publishRegions',
  'closeCredential',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
]) {
  protected readonly target: Coordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const room = parsePresenceRoomName(ctx.id.name ?? '')
    if (room === null) throw new Error(`Presence room name ${ctx.id.name} names no room`)
    const { stores, statusShard } = cloudflareBindings(env)
    this.target = new PresenceCoordinator(
      durableLiveHost(ctx, 'presence'),
      room,
      stores.sql,
      new IngestTimings(),
      (tokenHash) => statusShard(room.season).registerPresenceSurface(tokenHash, room.surface),
      cloudflareConfig(env).eventServer,
    )
  }
  override fetch(request: Request) {
    return receivePresence(request, (connection) => this.target.connect(connection))
  }
}
