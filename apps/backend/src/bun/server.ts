import { EventEmitter } from 'node:events'
import { type ServerWebSocket, serve } from 'bun'
import { MAX_LIVE_CLIENT_BINARY_BYTES } from '../live/session.js'
import type { NodeConfig } from '../node/config.js'
import { createBackendHttp } from '../node/http.js'
import {
  type LiveTransportSocket,
  type LiveUpgradeContext,
  MAX_BUFFERED_BYTES,
} from '../node/live.js'
import type { NodeRuntime } from '../node/runtime.js'

type UpgradeData = {
  accept: NonNullable<LiveUpgradeContext['accept']>
  bridge?: NativeSocket
}

class NativeSocket extends EventEmitter implements LiveTransportSocket {
  constructor(readonly socket: ServerWebSocket<UpgradeData>) {
    super()
  }
  get readyState(): number {
    return this.socket.readyState
  }
  get bufferedAmount(): number {
    return this.socket.getBufferedAmount()
  }
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.socket.send(
      typeof message === 'string' || message instanceof ArrayBuffer
        ? message
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
    )
  }
  close(code: number, reason: string): void {
    this.socket.close(code, reason)
  }
}

/** Serve the backend and its WebSockets on Bun's native HTTP server. */
export const listenBunServer = async (runtime: NodeRuntime, config: NodeConfig) => {
  const http = createBackendHttp(runtime, config)
  const sockets = new Set<ServerWebSocket<UpgradeData>>()
  const server = serve<UpgradeData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
        return http.app.fetch(request)
      const upgrade = await http.upgrade(request)
      if ('refusal' in upgrade) return upgrade.refusal
      if (server.upgrade(request, { headers: upgrade.headers, data: { accept: upgrade.accept } }))
        return
      return new Response('WebSocket upgrade rejected', { status: 400 })
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_LIVE_CLIENT_BINARY_BYTES,
      backpressureLimit: MAX_BUFFERED_BYTES,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open(socket) {
        sockets.add(socket)
        socket.data.bridge = new NativeSocket(socket)
        socket.data.accept(socket.data.bridge)
      },
      message(socket, message) {
        socket.data.bridge?.emit('message', Buffer.from(message), typeof message !== 'string')
      },
      close(socket, code, reason) {
        sockets.delete(socket)
        socket.data.bridge?.emit('close', code, Buffer.from(reason))
      },
    },
  })
  const port = server.port
  if (port === undefined) {
    await server.stop(true)
    throw new Error('Bun did not bind a TCP port')
  }
  http.listening()
  return {
    server,
    port,
    close: () =>
      http.close({
        stop: () => server.stop(),
        closeSockets: (code, reason) => {
          for (const socket of sockets) socket.close(code, reason)
        },
        force: () => void server.stop(true),
      }),
  }
}
