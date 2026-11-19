import { isSha256Hex, isUuidV7, parseTileKey } from '@caelestis/shared'
import { Effect, Context as Services } from 'effect'
import { type Context, Hono } from 'hono'
import { type BackfillClients, type BackfillReply, folderBackfillName } from '../backfill/port.js'
import { mergeD1Usage } from '../metrics/request-metrics.js'
import { type BackendRuntime, BlobStoreService } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { readVisibleVersion } from '../templates/use-cases.js'

const respond = <T>(c: Context, result: BackfillReply<T>): Response => {
  mergeD1Usage(result.usage)
  return result.ok ? Response.json(result.value) : c.json({ error: result.error }, result.status)
}

/** Admin-only preview/start/status/cancel for one server template, or every one below a folder. */
export const createBackfillAdminRoutes = (clients: BackfillClients | undefined) => {
  const routes = new Hono()
  const clientFor = (id: string) => {
    if (clients === undefined) throw new Error('Backfill is unavailable')
    return clients(id)
  }
  // Registered before the template routes, whose `:templateId` would otherwise claim `folders`.
  routes.use('/folders/:nodeId/*', async (c, next) => {
    if (!isUuidV7(c.req.param('nodeId'))) return c.json({ error: 'Invalid folder ID.' }, 400)
    if (clients === undefined)
      return c.json({ error: 'This server does not support backfill yet.' }, 503)
    await next()
  })
  const folderClient = (c: Context) => clientFor(folderBackfillName(c.req.param('nodeId') ?? ''))
  routes.get('/folders/:nodeId/preview', async (c) =>
    respond(c, await folderClient(c).previewFolder(c.req.param('nodeId'))),
  )
  routes.get('/folders/:nodeId/job', async (c) => respond(c, await folderClient(c).folderJob()))
  routes.post('/folders/:nodeId/start', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (
      body === null ||
      typeof body !== 'object' ||
      !('versionIds' in body) ||
      !('snapshotId' in body) ||
      !Array.isArray(body.versionIds) ||
      !body.versionIds.every(isUuidV7) ||
      typeof body.snapshotId !== 'number' ||
      !Number.isSafeInteger(body.snapshotId) ||
      body.snapshotId < 0
    )
      return c.json({ error: 'Choose an available snapshot for the folder.' }, 400)
    return respond(
      c,
      await folderClient(c).startFolder(c.req.param('nodeId'), body.versionIds, body.snapshotId),
    )
  })
  routes.post('/folders/:nodeId/cancel', async (c) =>
    respond(c, await folderClient(c).cancelFolder()),
  )
  routes.use('/:templateId/*', async (c, next) => {
    if (!isUuidV7(c.req.param('templateId'))) return c.json({ error: 'Invalid template ID.' }, 400)
    if (clients === undefined)
      return c.json({ error: 'This server does not support backfill yet.' }, 503)
    await next()
  })
  routes.get('/:templateId/preview', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).preview(c.req.param('templateId'))),
  )
  routes.get('/:templateId/job', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).job()),
  )
  routes.post('/:templateId/start', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (
      body === null ||
      typeof body !== 'object' ||
      !('versionId' in body) ||
      !('snapshotId' in body) ||
      typeof body.versionId !== 'string' ||
      !isUuidV7(body.versionId) ||
      typeof body.snapshotId !== 'number' ||
      !Number.isSafeInteger(body.snapshotId) ||
      body.snapshotId < 0
    )
      return c.json({ error: 'Choose a template version and available snapshot.' }, 400)
    return respond(
      c,
      await clientFor(c.req.param('templateId')).start(
        c.req.param('templateId'),
        body.versionId,
        body.snapshotId,
      ),
    )
  })
  routes.post('/:templateId/cancel', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).cancel()),
  )
  return routes
}

/**
 * Backfilled canvas history, read through templates. Sparse reads share template visibility rules;
 * PNGs remain outside live tile GC.
 */
export const createCanvasHistoryRoutes = (
  runtime: BackendRuntime,
  clients: BackfillClients | undefined,
) => {
  const routes = new Hono()
  const blobs = Services.get(runtime.context, BlobStoreService)
  routes.get('/templates/:templateId', async (c) => {
    const id = c.req.param('templateId')
    if (!isUuidV7(id)) return c.json({ error: 'Invalid template ID.' }, 400)
    const x = c.req.query('x')
    const y = c.req.query('y')
    const tile = x === undefined && y === undefined ? undefined : parseTileKey(`${x}/${y}`)
    if (tile === null) return c.json({ error: 'Invalid tile coordinates.' }, 400)
    const history = Effect.flatMap(
      readVisibleVersion(id, c.req.query('version'), c.get('caller').canSeeDrafts),
      (version) =>
        Effect.promise(async () =>
          clients === undefined ? null : clients(id).history(version, tile),
        ),
    )
    return runBackendHttp(c, runtime, history, (reply) =>
      reply === null
        ? c.json({ source: 'eralyon', basis: null, samples: [], frames: [] })
        : respond(c, reply),
    )
  })
  routes.get('/tiles/:hash', async (c) => {
    const hash = c.req.param('hash')
    if (!isSha256Hex(hash)) return c.json({ error: 'Invalid tile hash.' }, 400)
    const bytes = await blobs.get('archives', hash)
    if (bytes === null) return c.notFound()
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    })
  })
  return routes
}
