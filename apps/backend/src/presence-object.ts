import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { durableStatusShards } from './adapters/cloudflare/do-status-read-model.js'
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
]) {
  protected readonly target: Coordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const room = parsePresenceRoomName(ctx.id.name ?? '')
    if (room === null) throw new Error(`Presence room name ${ctx.id.name} names no room`)
    const statusShard = durableStatusShards(env.STATUS_READ_MODEL)
    this.target = new PresenceCoordinator(
      durableLiveHost(ctx, 'presence'),
      room,
      cloudflareStores(env).sql,
      new IngestTimings(),
      (tokenHash) => statusShard(room.season).registerPresenceSurface(tokenHash, room.surface),
    )
  }
  override fetch(request: Request) {
    return receivePresence(request, (connection) => this.target.connect(connection))
  }
  override alarm() {
    return this.target.alarm()
  }
  override webSocketMessage(...args: Parameters<Coordinator['webSocketMessage']>) {
    return this.target.webSocketMessage(...args)
  }
  override webSocketClose(...args: Parameters<Coordinator['webSocketClose']>) {
    return this.target.webSocketClose(...args)
  }
  override webSocketError(...args: Parameters<Coordinator['webSocketError']>) {
    return this.target.webSocketError(...args)
  }
}
