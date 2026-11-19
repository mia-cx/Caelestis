import { DurableObject } from 'cloudflare:workers'
import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { receivePresence } from './adapters/cloudflare/live-connect.js'
import { durableLiveHost } from './adapters/cloudflare/live-host.js'
import { PresenceCoordinator } from './presence/coordinator.js'
import { IngestTimings } from './telemetry/ingest-timing.js'

/** One presence room. DO RPC exposes only prototype methods, so each one delegates. */
export class PresenceObject extends DurableObject<Env> {
  private readonly coordinator: PresenceCoordinator<WebSocket>
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.coordinator = new PresenceCoordinator(
      durableLiveHost(ctx, 'presence'),
      cloudflareStores(env).sql,
      new IngestTimings(),
    )
  }
  override fetch(request: Request) {
    return receivePresence(request, (connection) => this.coordinator.connect(connection))
  }
  override alarm() {
    return this.coordinator.alarm()
  }
  override webSocketMessage(
    ...args: Parameters<PresenceCoordinator<WebSocket>['webSocketMessage']>
  ) {
    return this.coordinator.webSocketMessage(...args)
  }
  override webSocketClose(...args: Parameters<PresenceCoordinator<WebSocket>['webSocketClose']>) {
    return this.coordinator.webSocketClose(...args)
  }
  override webSocketError(...args: Parameters<PresenceCoordinator<WebSocket>['webSocketError']>) {
    return this.coordinator.webSocketError(...args)
  }
  online() {
    return this.coordinator.online()
  }
  readIngestTimings(reset: boolean) {
    return this.coordinator.readIngestTimings(reset)
  }
  publishRegions(...args: Parameters<PresenceCoordinator<WebSocket>['publishRegions']>) {
    return this.coordinator.publishRegions(...args)
  }
  closeCredential(...args: Parameters<PresenceCoordinator<WebSocket>['closeCredential']>) {
    return this.coordinator.closeCredential(...args)
  }
}
