import { Hono } from 'hono'
import { admissionChannel, renderCapacityMetrics } from './capacity.js'
import { LEGACY_MOUNT, type NodeConfig } from './config.js'
import { type LiveTransportSocket, type LiveUpgradeContext, liveRequestContext } from './live.js'
import type { NodeRuntime } from './runtime.js'

/** The frontend's same-origin live-sync proxy, answered with the server-held read token. */
const LIVE_PROXY = '/api/v1/telemetry/live'
const LISTENER_ROUTES = new Set(['/health/live', '/health/ready', '/metrics', LIVE_PROXY])
const SHUTDOWN_GRACE_MS = 5_000

/** A transport's listener and sockets, as a graceful shutdown stops them. */
export interface Listener {
  /** Stop accepting connections; resolves once the listener has closed. */
  stop(): Promise<void>
  closeSockets(code: number, reason: string): void
  /** Drop whatever is still open after the grace period. */
  force(): void
}

/** An upgrade the backend admitted, with who accepts the socket, or the answer that refuses it. */
export type Upgrade =
  | { readonly accept: (socket: LiveTransportSocket) => void; readonly headers: Headers }
  | { readonly refusal: Response }

/** Routing, health checks, metrics, upgrades, and shutdown shared by both portable transports. */
export const createBackendHttp = (runtime: NodeRuntime, config: NodeConfig) => {
  let stopping = false
  const mounts = [...new Set([config.basePath, LEGACY_MOUNT])]
  const mountOf = (pathname: string) =>
    mounts.find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

  const backendFetch = (request: Request) => {
    const url = new URL(request.url)
    const mount = mountOf(url.pathname)
    if (mount === undefined) return Promise.resolve(new Response('Not Found', { status: 404 }))
    url.pathname = url.pathname.slice(mount.length) || '/'
    return runtime.app.fetch(new Request(url.href, request))
  }

  const metrics = async () => {
    const [failures, dropped, jobs] = await Promise.all([
      runtime.counters.readFlushFailureCount(),
      runtime.counters.readDroppedLateCount(),
      runtime.connection
        .prepare('SELECT COUNT(*) AS count FROM runtime_alarms')
        .first<{ count: number }>(),
    ])
    const capacity = renderCapacityMetrics(
      runtime.capacity.snapshot(),
      runtime.capacity.admissions,
      runtime.capacity.eventLoopLag.read(),
    )
    return new Response(
      `# TYPE caelestis_counter_flush_failures gauge\ncaelestis_counter_flush_failures ${failures}\n# TYPE caelestis_counter_dropped_deltas_total counter\ncaelestis_counter_dropped_deltas_total ${dropped}\n# TYPE caelestis_durable_jobs_pending gauge\ncaelestis_durable_jobs_pending ${jobs?.count ?? 0}\n${capacity}`,
      { headers: { 'content-type': 'text/plain; version=0.0.4' } },
    )
  }

  const app = new Hono()
  app.all('*', async (context) => {
    if (stopping) return new Response('Server shutting down', { status: 503 })
    const request = context.req.raw
    const url = new URL(request.url)
    if (url.pathname === '/health/live') return Response.json({ ok: true })
    if (url.pathname === '/metrics') return metrics()
    if (url.pathname === '/health/ready') {
      try {
        await runtime.connection.prepare('SELECT 1').first()
        return Response.json({ ok: true })
      } catch {
        return Response.json({ ok: false }, { status: 503 })
      }
    }
    const channel = admissionChannel(url.pathname)
    if (url.pathname === LIVE_PROXY) {
      url.pathname = `${config.basePath}/v1/telemetry/live`
      const headers = new Headers(request.headers)
      headers.delete('cookie')
      headers.set('authorization', `Bearer ${runtime.readToken}`)
      const response = await backendFetch(new Request(url.href, { method: 'GET', headers }))
      if (channel) runtime.capacity.admissions.record(channel, response.status)
      return response
    }
    const startedAt = performance.now()
    const response = await backendFetch(request)
    if (channel) runtime.capacity.admissions.record(channel, response.status)
    console.info(
      JSON.stringify({
        event: 'request',
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    )
    return response
  })

  return {
    app,
    backendFetch,
    /** Whether the backend answers this path; anything else belongs to the frontend. */
    owns: (pathname: string) =>
      stopping || LISTENER_ROUTES.has(pathname) || mountOf(pathname) !== undefined,
    /** Run a WebSocket upgrade through the backend, which authenticates and admits it. */
    upgrade: async (request: Request): Promise<Upgrade> => {
      const context: LiveUpgradeContext = {}
      const response = await liveRequestContext.run(context, () => app.fetch(request))
      if (response.status !== 200) return { refusal: response }
      if (!context.accept)
        return { refusal: new Response('WebSocket upgrade rejected', { status: 400 }) }
      return { accept: context.accept, headers: response.headers }
    },
    /** Start the durable scheduler once the transport is listening. */
    listening: () => runtime.scheduler.start(),
    /** Stop the listener, ask every socket to leave, then close the runtime. */
    close: async (listener: Listener): Promise<void> => {
      if (stopping) return
      stopping = true
      const stopped = listener.stop()
      listener.closeSockets(1001, 'server shutting down')
      const force = setTimeout(() => listener.force(), SHUTDOWN_GRACE_MS)
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
