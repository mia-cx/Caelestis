import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { instrumentD1 } from './metrics/request-metrics.js'
import { PresenceCoordinator } from './presence-coordinator.js'
import { IngestTimings } from './telemetry/ingest-timing.js'

/** Cloudflare lifecycle and socket binding for the shared presence room. */
export class PresenceObject extends DurableObject<Env> {
  private readonly coordinator: PresenceCoordinator<WebSocket>
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.coordinator = new PresenceCoordinator(
      {
        storage: ctx.storage,
        getWebSockets: (tag) => ctx.getWebSockets(tag),
        waitUntil: (work) => ctx.waitUntil(work),
        connect: (attachment) => {
          const pair = new WebSocketPair()
          pair[1].serializeAttachment(attachment)
          ctx.acceptWebSocket(pair[1], ['presence'])
          return { client: pair[0], server: pair[1] }
        },
        upgradeResponse: (client, headers) =>
          new Response(null, { status: 101, headers, webSocket: client }),
      },
      new D1SqlStore(instrumentD1(env.DB)),
      new IngestTimings(),
    )
  }
  override fetch(...args: Parameters<PresenceCoordinator<WebSocket>['fetch']>) {
    return this.coordinator.fetch(...args)
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
