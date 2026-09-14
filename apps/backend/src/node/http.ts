import { Hono } from 'hono'
import type { NodeConfig } from './config.js'
import type { openNodeRuntime } from './runtime.js'

export type PortableRuntime = Awaited<ReturnType<typeof openNodeRuntime>>

/** Shared routing, health checks, and metrics for both portable HTTP transports. */
export const createBackendHttp = (
  runtime: PortableRuntime,
  config: NodeConfig,
  stopping: () => boolean,
) => {
  const backendFetch = (request: Request) => {
    const url = new URL(request.url)
    const mount = [config.basePath, '/backend'].find(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
    if (mount === undefined) return Promise.resolve(new Response('Not Found', { status: 404 }))
    url.pathname = url.pathname.slice(mount.length) || '/'
    return runtime.app.fetch(new Request(url.href, request))
  }
  const app = new Hono()
  app.all('*', async (context) => {
    if (stopping()) return new Response('Server shutting down', { status: 503 })
    const request = context.req.raw
    const url = new URL(request.url)
    if (url.pathname === '/health/live') return Response.json({ ok: true })
    if (url.pathname === '/metrics') {
      const [failures, dropped, jobs] = await Promise.all([
        runtime.counters.readFlushFailureCount(),
        runtime.counters.readDroppedLateCount(),
        runtime.connection
          .prepare('SELECT COUNT(*) AS count FROM runtime_alarms')
          .first<{ count: number }>(),
      ])
      return new Response(
        `# TYPE caelestis_counter_flush_failures gauge\ncaelestis_counter_flush_failures ${failures}\n# TYPE caelestis_counter_dropped_deltas_total counter\ncaelestis_counter_dropped_deltas_total ${dropped}\n# TYPE caelestis_durable_jobs_pending gauge\ncaelestis_durable_jobs_pending ${jobs?.count ?? 0}\n`,
        { headers: { 'content-type': 'text/plain; version=0.0.4' } },
      )
    }
    if (url.pathname === '/health/ready') {
      try {
        await runtime.connection.prepare('SELECT 1').first()
        return Response.json({ ok: true })
      } catch {
        return Response.json({ ok: false }, { status: 503 })
      }
    }
    if (url.pathname === '/api/v1/telemetry/live') {
      url.pathname = `${config.basePath}/v1/telemetry/live`
      const headers = new Headers(request.headers)
      headers.delete('cookie')
      headers.set('authorization', `Bearer ${runtime.readToken}`)
      return backendFetch(new Request(url.href, { method: 'GET', headers }))
    }
    const startedAt = performance.now()
    const response = await backendFetch(request)
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
  return { app, backendFetch }
}
