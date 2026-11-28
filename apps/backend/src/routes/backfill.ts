import { type ArchiveHistory, isSha256Hex, isUuidV7, parseTileKey } from '@caelestis/shared'
import { Effect, Context as Services } from 'effect'
import { type Context, Hono } from 'hono'
import {
  type BackfillClients,
  type BackfillReply,
  type BackfillSubject,
  folderBackfillName,
} from '../backfill/port.js'
import { mergeD1Usage } from '../metrics/request-metrics.js'
import {
  type BackendRuntime,
  BackfillService,
  BlobStoreService,
} from '../runtime/backend-runtime.js'
import { BoundedCache, memoize } from '../runtime/bounded-cache.js'
import { runBackendHttp } from '../runtime/hono.js'
import { readVisibleVersion } from '../templates/use-cases.js'
import { jsonObject } from './params.js'

const respond = <T>(c: Context, result: BackfillReply<T>): Response => {
  mergeD1Usage(result.usage)
  return result.ok ? Response.json(result.value) : c.json({ error: result.error }, result.status)
}

/** How one kind of subject reads its routes: the object it names, and the artwork its start shows. */
interface SubjectRoutes {
  readonly kind: BackfillSubject['kind']
  readonly invalidId: string
  readonly invalidStart: string
  readonly objectName: (id: string) => string
  /** The artwork versions a start body names, or null when it names none validly. */
  readonly versionIds: (body: Partial<Record<string, unknown>>) => readonly string[] | null
}

const SUBJECTS = {
  folder: {
    kind: 'folder',
    invalidId: 'Invalid folder ID.',
    invalidStart: 'Choose an available snapshot for the folder.',
    objectName: folderBackfillName,
    versionIds: ({ versionIds }) =>
      Array.isArray(versionIds) && versionIds.every(isUuidV7) ? versionIds : null,
  },
  template: {
    kind: 'template',
    invalidId: 'Invalid template ID.',
    invalidStart: 'Choose a template version and available snapshot.',
    objectName: (id) => id,
    versionIds: ({ versionId }) =>
      typeof versionId === 'string' && isUuidV7(versionId) ? [versionId] : null,
  },
} as const satisfies Record<string, SubjectRoutes>

const isSnapshotId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Preview, start, status and cancel for one kind of subject, each under `/:id`. */
const subjectRoutes = (clientFor: BackfillClients, subject: SubjectRoutes) => {
  const routes = new Hono()
  routes.use('/:id/*', async (c, next) => {
    if (!isUuidV7(c.req.param('id'))) return c.json({ error: subject.invalidId }, 400)
    await next()
  })
  const named = (c: Context): BackfillSubject => ({
    kind: subject.kind,
    id: c.req.param('id') ?? '',
  })
  const client = (c: Context) => clientFor(subject.objectName(c.req.param('id') ?? ''))
  routes.get('/:id/preview', async (c) => respond(c, await client(c).preview(named(c))))
  routes.get('/:id/job', async (c) => respond(c, await client(c).job()))
  routes.post('/:id/start', async (c) => {
    const body = await jsonObject(c)
    const versionIds = body === null ? null : subject.versionIds(body)
    if (body === null || !isSnapshotId(body.snapshotId) || versionIds === null)
      return c.json({ error: subject.invalidStart }, 400)
    return respond(c, await client(c).start(named(c), versionIds, body.snapshotId))
  })
  routes.post('/:id/cancel', async (c) => respond(c, await client(c).cancel()))
  return routes
}

/** Admin-only preview/start/status/cancel for one server template, or every one below a folder. */
export const createBackfillAdminRoutes = (runtime: BackendRuntime) => {
  const clientFor = Services.get(runtime.context, BackfillService)
  // Folders mount first, so the template routes' `:id` never claims `folders`.
  return new Hono()
    .route('/folders', subjectRoutes(clientFor, SUBJECTS.folder))
    .route('/', subjectRoutes(clientFor, SUBJECTS.template))
}

const ARCHIVE_HISTORY_CACHE_TTL_MS = 60_000
const ARCHIVE_HISTORY_CACHE_MAX_ENTRIES = 512
const ARCHIVE_HISTORY_CACHE_MAX_BYTES = 16 * 1024 * 1024

const archiveReplyBytes = (reply: BackfillReply<ArchiveHistory>): number =>
  reply.ok ? Math.max(128, (reply.value.samples.length + reply.value.frames.length) * 96) : 0

/**
 * Backfilled canvas history, read through templates. Sparse reads share template visibility rules;
 * PNGs remain outside live tile GC.
 */
export const createCanvasHistoryRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()
  const blobs = Services.get(runtime.context, BlobStoreService)
  const clients = Services.get(runtime.context, BackfillService)
  const historyCache = new BoundedCache<Promise<BackfillReply<ArchiveHistory>>>({
    maxEntries: ARCHIVE_HISTORY_CACHE_MAX_ENTRIES,
    maxBytes: ARCHIVE_HISTORY_CACHE_MAX_BYTES,
    ttlMs: ARCHIVE_HISTORY_CACHE_TTL_MS,
  })
  routes.get('/templates/:templateId', async (c) => {
    const id = c.req.param('templateId')
    if (!isUuidV7(id)) return c.json({ error: 'Invalid template ID.' }, 400)
    const x = c.req.query('x')
    const y = c.req.query('y')
    const tile = x === undefined && y === undefined ? undefined : parseTileKey(`${x}/${y}`)
    if (tile === null) return c.json({ error: 'Invalid tile coordinates.' }, 400)
    const history = Effect.flatMap(
      readVisibleVersion(id, c.req.query('version'), c.get('caller').canSeeDrafts),
      (version) => {
        const key = `${id}:${version}:${tile === undefined ? 'all' : `${tile.x}/${tile.y}`}`
        return Effect.promise(() =>
          memoize(
            historyCache,
            key,
            async () => {
              const reply = await clients(id).history(version, tile)
              mergeD1Usage(reply.usage)
              return reply
            },
            archiveReplyBytes,
          ),
        )
      },
    )
    return runBackendHttp(c, runtime, history, (reply) =>
      reply.ok
        ? Response.json(reply.value, {
            headers: { 'cache-control': 'private, max-age=60', vary: 'Authorization' },
          })
        : c.json({ error: reply.error }, reply.status),
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
