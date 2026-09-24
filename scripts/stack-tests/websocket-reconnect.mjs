import { setTimeout as delay } from 'node:timers/promises'

/** A lost WebSocket transport, distinct from a failed acceptance assertion or server response. */
export class WebSocketDisconnected extends Error {}

/** Replay an idempotent exchange after deployment disconnects, without retrying assertions. */
export async function reconnectWebSocket(exchange) {
  const attempts = 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await exchange()
    } catch (error) {
      if (!(error instanceof WebSocketDisconnected) || attempt === attempts - 1) throw error
      await delay(1000)
    }
  }
}
