import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getRequestListener } from '@hono/node-server'
import type { NodeConfig } from './config.js'
import { createBackendHttp } from './http.js'
import { createWebSocketServer } from './live.js'
import type { NodeRuntime } from './runtime.js'

export type FrontendHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>

/** Serve the backend, frontend, and authenticated WebSockets on one HTTP listener. */
export const listenNodeServer = async (
  runtime: NodeRuntime,
  config: NodeConfig,
  frontend?: FrontendHandler,
) => {
  const http = createBackendHttp(runtime, config)
  const backendListener = getRequestListener(http.app.fetch, { overrideGlobalObjects: false })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!frontend || http.owns(pathname)) {
      backendListener(request, response)
      return
    }
    const hostedRequest = Object.assign(request, {
      caelestis: {
        env: {
          CAELESTIS_READ_TOKEN: runtime.readToken,
          CAELESTIS_BACKEND: { fetch: http.backendFetch },
        },
        objectStorage: runtime.objects,
      },
    })
    const failed = (error?: unknown) => {
      if (error) console.error('Frontend request failed', error)
      if (!response.headersSent) response.writeHead(error ? 500 : 404)
      response.end(error ? 'Internal Server Error' : 'Not Found')
    }
    try {
      Promise.resolve(frontend(hostedRequest, response, failed)).catch(failed)
    } catch (error) {
      failed(error)
    }
  })
  const protocols = new WeakMap<IncomingMessage, string>()
  const sockets = createWebSocketServer((request) => protocols.get(request) ?? false)
  server.on('upgrade', (request, socket, head) => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    http
      .upgrade(new Request(new URL(request.url ?? '/', 'http://localhost').href, { headers }))
      .then((upgrade) => {
        if ('refusal' in upgrade) {
          socket.end(
            `HTTP/1.1 ${upgrade.refusal.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          )
          return
        }
        const protocol = upgrade.headers.get('sec-websocket-protocol')
        if (protocol) protocols.set(request, protocol)
        sockets.handleUpgrade(request, socket, head, upgrade.accept)
      })
      .catch((error: unknown) => {
        console.error('WebSocket upgrade failed', error)
        socket.destroy()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  http.listening()
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      http.close({
        stop: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        closeSockets: (code, reason) => {
          for (const socket of sockets.clients) socket.close(code, reason)
        },
        force: () => {
          for (const socket of sockets.clients) socket.terminate()
          server.closeAllConnections()
        },
      }),
  }
}
