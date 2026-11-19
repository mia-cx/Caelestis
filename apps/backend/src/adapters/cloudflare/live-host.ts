/**
 * A Durable Object's hibernatable sockets as a live coordinator's host. `tag` names the
 * coordinator's sockets; pings get their pong without waking the object.
 */
export const durableLiveHost = (ctx: DurableObjectState, tag: 'presence' | 'status') => {
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  return {
    storage: ctx.storage,
    getWebSockets: (socketTag: string) => ctx.getWebSockets(socketTag),
    waitUntil: (work: Promise<unknown>) => ctx.waitUntil(work),
    connect: (attachment: unknown) => {
      const pair = new WebSocketPair()
      pair[1].serializeAttachment(attachment)
      ctx.acceptWebSocket(pair[1], [tag])
      return { client: pair[0], server: pair[1] }
    },
    upgradeResponse: (client: WebSocket, headers: Headers) =>
      new Response(null, { status: 101, headers, webSocket: client }),
  }
}
