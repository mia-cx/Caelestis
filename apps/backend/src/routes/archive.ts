import { type Context, Hono } from 'hono'
import { exportPage, finishExport, startExport } from '../archive/export.js'
import { ArchiveError } from '../archive/format.js'
import type { ArchiveHost } from '../archive/port.js'
import {
  activateRestore,
  appendRestore,
  archiveStatus,
  beginRestore,
  discardRestore,
  MAX_RESTORE_LINES,
} from '../archive/restore.js'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'

/** Response header carrying the cursor of the next export page; absent on the last page. */
export const ARCHIVE_NEXT_HEADER = 'caelestis-archive-next'
const MAX_RESTORE_BYTES = 64 * 1024 * 1024

const refuse = (c: Context, error: unknown): Response => {
  if (!(error instanceof ArchiveError)) throw error
  if (error.retryAt !== undefined)
    c.header('retry-after', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))))
  return c.json({ error: error.message }, error.status)
}

/**
 * Admin-only server archive export and restore.
 *
 * An export freezes writes, then serves the dataset as cursor-paged NDJSON. A restore accepts
 * the same lines in order and opens the server only after the archive's end record verifies.
 */
export const createArchiveAdminRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  host?: ArchiveHost,
  onActivated?: () => Promise<void>,
) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))
  routes.use('/*', async (c, next) => {
    if (host === undefined)
      return c.json({ error: 'This server stores data in memory and cannot archive it.' }, 501)
    await next()
  })
  const run = async (c: Context, operation: (host: ArchiveHost) => Promise<Response>) => {
    try {
      return await operation(host as ArchiveHost)
    } catch (error) {
      return refuse(c, error)
    }
  }

  routes.get('/', (c) => run(c, async (host) => c.json(await archiveStatus(host))))
  routes.post('/export', (c) => run(c, async (host) => c.json(await startExport(host), 201)))
  routes.get('/export', (c) =>
    run(c, async (host) => {
      const page = await exportPage(host, c.req.query('cursor') ?? null)
      return new Response(page.lines.map((line) => `${line}\n`).join(''), {
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          ...(page.next === null ? {} : { [ARCHIVE_NEXT_HEADER]: page.next }),
        },
      })
    }),
  )
  routes.delete('/export', (c) =>
    run(c, async (host) =>
      (await finishExport(host))
        ? c.body(null, 204)
        : c.json({ error: 'No export is in progress.' }, 409),
    ),
  )
  routes.post('/import', (c) =>
    run(c, async (host) => {
      const started = await beginRestore(host, (await c.req.text()).trim())
      return c.json(started, started.resumed ? 200 : 201)
    }),
  )
  routes.post('/import/records', (c) =>
    run(c, async (host) => {
      const position = Number(c.req.query('position'))
      if (!Number.isSafeInteger(position) || position < 1)
        return c.json({ error: 'Give the position of the first record you are sending.' }, 400)
      if (Number(c.req.header('content-length') ?? 0) > MAX_RESTORE_BYTES)
        return c.json({ error: `Send at most ${MAX_RESTORE_LINES} lines per request.` }, 413)
      const lines = (await c.req.text()).split('\n').filter((line) => line.length > 0)
      return c.json(await appendRestore(host, position, lines))
    }),
  )
  routes.post('/import/activate', (c) =>
    run(c, async (host) => {
      const activated = await activateRestore(host)
      await onActivated?.()
      return c.json(activated)
    }),
  )
  routes.delete('/import', (c) =>
    run(c, async (host) => c.json({ done: await discardRestore(host) })),
  )
  return routes
}
