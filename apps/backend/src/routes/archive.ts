import { Hono, type MiddlewareHandler } from 'hono'
import { ArchiveOperationActiveError } from '../archive/errors.js'
import { exportPage, finishExport, startExport } from '../archive/export.js'
import type { ArchiveStatus } from '../archive/fence.js'
import type { ArchiveHost } from '../archive/port.js'
import {
  activateRestore,
  appendRestore,
  archiveStatus,
  beginRestore,
  discardRestore,
} from '../archive/restore.js'
import { ARCHIVE_NEXT_HEADER, MAX_RESTORE_MIB } from '../archive/wire.js'
import { errorResponse } from '../runtime/hono.js'
import { readBoundedText } from './body.js'

/**
 * While an archive operation holds the server, answer 503 to every request this guards. An
 * export keeps the dataset still; a restore keeps a partial dataset out of sight.
 */
export const archiveHold =
  (sql: ArchiveStatus): MiddlewareHandler =>
  async (c, next) => {
    if (await sql.archiveOperationActive())
      return errorResponse(c, new ArchiveOperationActiveError())
    await next()
  }

/**
 * Server archive export and restore.
 *
 * An export freezes writes, then serves the dataset as cursor-paged NDJSON. A restore accepts
 * the same lines in order and opens the server only after the archive's end record verifies.
 * Refusals are `ArchiveError`s, which the app's error handler answers.
 */
export const createArchiveAdminRoutes = (host: ArchiveHost | undefined) => {
  const routes = new Hono()
  if (host === undefined) {
    routes.all('/*', (c) =>
      c.json({ error: 'This server stores data in memory and cannot archive it.' }, 501),
    )
    return routes
  }

  routes.get('/', async (c) => c.json(await archiveStatus(host)))
  routes.post('/export', async (c) => c.json(await startExport(host), 201))
  routes.get('/export', async (c) => {
    const page = await exportPage(host, c.req.query('cursor') ?? null)
    return new Response(page.lines.map((line) => `${line}\n`).join(''), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        ...(page.next === null ? {} : { [ARCHIVE_NEXT_HEADER]: page.next }),
      },
    })
  })
  routes.delete('/export', async (c) =>
    (await finishExport(host))
      ? c.body(null, 204)
      : c.json({ error: 'No export is in progress.' }, 409),
  )
  routes.post('/import', async (c) => {
    const started = await beginRestore(host, (await c.req.text()).trim())
    return c.json(started, started.resumed ? 200 : 201)
  })
  routes.post('/import/records', async (c) => {
    const position = Number(c.req.query('position'))
    if (!Number.isSafeInteger(position) || position < 1)
      return c.json({ error: 'Give the position of the first record you are sending.' }, 400)
    const text = await readBoundedText(c.req.raw, MAX_RESTORE_MIB * 1024 * 1024)
    if (text === null)
      return c.json({ error: `Send at most ${MAX_RESTORE_MIB} MiB of records per request.` }, 413)
    const lines = text.split('\n').filter((line) => line.length > 0)
    return c.json(await appendRestore(host, position, lines))
  })
  routes.post('/import/activate', async (c) => c.json(await activateRestore(host)))
  routes.delete('/import', async (c) => c.json({ done: await discardRestore(host) }))
  return routes
}
