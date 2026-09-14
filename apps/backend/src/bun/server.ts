import { EventEmitter } from 'node:events'
import { type ServerWebSocket, serve } from 'bun'
import type { NodeConfig } from '../node/config.js'
import { createBackendHttp, type PortableRuntime } from '../node/http.js'
import {
  type LiveTransportSocket,
  type LiveUpgradeContext,
  liveRequestContext,
  MAX_BUFFERED_BYTES,
} from '../node/live.js'
import { MAX_LIVE_CLIENT_BINARY_BYTES } from '../status-coordinator.js'

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

/** Native Bun HTTP/WebSockets retain the shared host's admission, queues, and authorization. */
export const listenBunServer = async (runtime: PortableRuntime, config: NodeConfig) => {
  let stopping = false
  const { app } = createBackendHttp(runtime, config, () => stopping)
  const sockets = new Set<ServerWebSocket<UpgradeData>>()
  const server = serve<UpgradeData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return app.fetch(request)
      const context: LiveUpgradeContext = {}
      const response = await liveRequestContext.run(context, () => app.fetch(request))
      if (response.status !== 200) return response
      if (!context.accept) return new Response('WebSocket upgrade rejected', { status: 400 })
      if (server.upgrade(request, { headers: response.headers, data: { accept: context.accept } }))
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
  runtime.scheduler.start()
  return {
    server,
    port,
    async close() {
      if (stopping) return
      stopping = true
      const stopped = server.stop()
      for (const socket of sockets) socket.close(1001, 'server shutting down')
      const force = setTimeout(() => void server.stop(true), 5000)
      force.unref()
      try {
        await stopped
        await runtime.close()
      } finally {
        clearTimeout(force)
      }
    },
  }
}
