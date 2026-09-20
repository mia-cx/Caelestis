import {
  logoText,
  normaliseHomeCopy,
  parseDiscordInviteUrl,
  parseHomeCopy,
  SERVER_ASSET_MAX_BYTES,
  type ServerAssetKind,
  type ServerInfo,
  sha256Hex,
  sniffServerAssetContentType,
} from '@caelestis/shared'
import { Effect, Context as Services } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { ServerAssetRecord, SqlStore } from '../ports/sql-store.js'
import {
  type BackendRuntime,
  BlobStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { BackendStorageError, SqlStoreReadError } from '../runtime/errors.js'
import { runBackendHttp } from '../runtime/hono.js'
import { mergeServerInfo, serverAssetInfo } from '../server-info.js'
import { publishManifestChange } from '../status-read-model/port.js'
import { ingestTimings } from '../telemetry/ingest-timing.js'

const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4096

const assetKind = (kind: string): ServerAssetKind | null =>
  kind === 'logo' || kind === 'preview' ? kind : null

const readServerSettings = Effect.gen(function* () {
  const sql = yield* SqlStoreService
  return yield* Effect.tryPromise({
    try: () => sql.readServerSettings(),
    catch: (cause) => new SqlStoreReadError({ operation: 'readServerSettings', cause }),
  })
})

/**
 * What this server calls itself, as the deployment configured it and an admin has since renamed it.
 *
 * Resolved per request rather than fixed at start-up, because a rename has to take effect without a
 * redeploy — the whole point of moving it out of `[vars]`. The vars stay the value a fresh
 * deployment begins with; anything set here wins for as long as it is set.
 */
export const resolveServerInfoEffect = (
  base: ServerInfo,
): Effect.Effect<ServerInfo, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const settings = yield* readServerSettings
    return mergeServerInfo(base, settings)
  })

/** Persist a partial operator override without changing omitted fields. */
export const writeServerSettings = (
  settings: Parameters<SqlStore['writeServerSettings']>[0],
): Effect.Effect<void, BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    yield* Effect.tryPromise({
      try: () => sql.writeServerSettings(settings),
      catch: (cause) => new BackendStorageError({ operation: 'writeServerSettings', cause }),
    })
  })

/**
 * Store a replacement (or clear the asset), then drop whatever the settings no longer reference.
 *
 * Branding is never swept, so every object this leaves behind is leaked for good. One rule keeps
 * that bounded: after our write, delete exactly the objects the settings no longer reference. That
 * covers the old object (unless an overlapping upload restored it), our own object when an
 * overlapping upload superseded it, and a settings write that failed after the store.
 */
const replaceServerAsset = (
  kind: ServerAssetKind,
  record: ServerAssetRecord | null,
  bytes: Uint8Array | null,
  season: number,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const deleteBlob = (key: string) =>
      Effect.tryPromise({
        try: () => blobs.delete('branding', [key]),
        catch: (cause) => new BackendStorageError({ operation: 'deleteServerAsset', cause }),
      })
    const previous = (yield* readServerSettings)[kind]
    // Re-uploading identical bytes overwrites the object the settings already reference; that one
    // must survive a failed write.
    const storedFresh = record !== null && bytes !== null && previous?.blobKey !== record.blobKey
    if (record !== null && bytes !== null) {
      yield* Effect.tryPromise({
        try: () => blobs.put('branding', record.blobKey, bytes),
        catch: (cause) => new BackendStorageError({ operation: 'putServerAsset', cause }),
      })
    }
    yield* writeServerSettingsAndPublish({ [kind]: record }, season).pipe(
      Effect.tapError(() =>
        storedFresh && record !== null ? Effect.ignore(deleteBlob(record.blobKey)) : Effect.void,
      ),
    )
    // Delete whatever the settings no longer reference after our write: the old object unless an
    // overlapping upload restored it, and our own object if an overlapping upload superseded it.
    const current = (yield* readServerSettings)[kind]
    if (previous !== null && current?.blobKey !== previous.blobKey) {
      yield* deleteBlob(previous.blobKey)
    }
    if (storedFresh && record !== null && current?.blobKey !== record.blobKey) {
      yield* deleteBlob(record.blobKey)
    }
  })

const writeServerSettingsAndPublish = (
  settings: Parameters<typeof writeServerSettings>[0],
  season: number,
): Effect.Effect<void, BackendStorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    yield* writeServerSettings(settings)
    const statusReadModel = yield* StatusReadModelService
    yield* Effect.promise(() => publishManifestChange(statusReadModel, season))
  })

export const createServerRoutes = (runtime: BackendRuntime, base: ServerInfo) => {
  const routes = new Hono()
  // Public, and deliberately so: this is how a userscript decides whether it needs a token at all.
  routes.get('/', (c) =>
    runBackendHttp(c, runtime, resolveServerInfoEffect(base), (server) => c.json(server)),
  )
  routes.on(['GET', 'HEAD'], '/assets/:kind', (c) => {
    const kind = assetKind(c.req.param('kind'))
    if (kind === null) return c.json({ error: 'asset not found' }, 404)
    return runBackendHttp(
      c,
      runtime,
      Effect.gen(function* () {
        const record = (yield* readServerSettings)[kind]
        if (record === null) return null
        const blobs = yield* BlobStoreService
        const bytes = yield* Effect.tryPromise({
          try: () => blobs.get('branding', record.blobKey),
          catch: (cause) => new BackendStorageError({ operation: 'getServerAsset', cause }),
        })
        return bytes === null ? null : { bytes, ...serverAssetInfo(record) }
      }),
      (asset) => {
        if (asset === null) return c.json({ error: 'asset not found' }, 404)
        const headers = {
          'content-type': asset.contentType,
          'content-length': String(asset.bytes.byteLength),
          etag: `"${asset.etag}"`,
          'x-content-type-options': 'nosniff',
          'content-disposition': 'inline',
          'cache-control':
            c.req.query('v') === asset.etag
              ? 'public, max-age=31536000, immutable'
              : 'public, no-cache',
        }
        const candidates = (c.req.header('if-none-match') ?? '')
          .split(',')
          .map((candidate) => candidate.trim().replace(/^W\//, ''))
        if (candidates.includes(headers.etag) || candidates.includes('*')) {
          return new Response(null, { status: 304, headers })
        }
        return new Response(c.req.method === 'HEAD' ? null : asset.bytes.slice().buffer, {
          headers,
        })
      },
    )
  })
  return routes
}

/**
 * Operator-managed public server details and branding assets.
 *
 * Its own route under `/admin` rather than a method on the public one, so the read stays reachable
 * without a credential while the write never is.
 */
export const createServerAdminRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  currentSeason: number,
) => {
  const routes = new Hono()

  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))

  routes.patch('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const {
      name,
      description,
      discordInviteUrl,
      homeCopy,
      logoText: rawLogoText,
    } = body as {
      name?: unknown
      description?: unknown
      discordInviteUrl?: unknown
      homeCopy?: unknown
      logoText?: unknown
    }

    if (
      name !== undefined &&
      (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME_LENGTH)
    ) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    // Null clears it, which is not the same as leaving it alone: one goes back to whatever the
    // deployment configured, the other keeps whatever an admin set earlier.
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== 'string' ||
        description.trim().length === 0 ||
        description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return c.json({ error: 'description must be 1..4096 characters, or null' }, 400)
    }
    const invite = parseDiscordInviteUrl(discordInviteUrl)
    if (discordInviteUrl !== undefined && discordInviteUrl !== null && invite === null) {
      return c.json({ error: 'discordInviteUrl must be a Discord invite link, or null' }, 400)
    }
    const copy = typeof homeCopy === 'string' ? normaliseHomeCopy(homeCopy) : homeCopy
    if (copy !== undefined && copy !== null) {
      const result = parseHomeCopy(copy)
      if (!result.ok) return c.json({ error: result.message }, 400)
    }
    const text = logoText(rawLogoText)
    if (rawLogoText !== undefined && rawLogoText !== null && text === null) {
      return c.json({ error: 'logoText must be 1..64 characters, or null' }, 400)
    }
    if (
      [name, description, discordInviteUrl, homeCopy, rawLogoText].every(
        (value) => value === undefined,
      )
    ) {
      return c.json(
        {
          error:
            'patch must set at least one of name, description, discordInviteUrl, homeCopy, logoText',
        },
        400,
      )
    }

    return runBackendHttp(
      c,
      runtime,
      writeServerSettingsAndPublish(
        {
          ...(name === undefined ? {} : { name: (name as string).trim() }),
          ...(description === undefined
            ? {}
            : { description: description === null ? null : (description as string) }),
          ...(discordInviteUrl === undefined ? {} : { discordInviteUrl: invite }),
          ...(homeCopy === undefined ? {} : { homeCopy: copy as string | null }),
          ...(rawLogoText === undefined ? {} : { logoText: text }),
        },
        currentSeason,
      ),
      () => c.json({ ok: true }),
    )
  })

  routes.put('/assets/:kind', async (c) => {
    const kind = assetKind(c.req.param('kind'))
    if (kind === null) return c.json({ error: 'asset not found' }, 404)
    const limit = SERVER_ASSET_MAX_BYTES[kind]
    const tooLarge = () =>
      c.json(
        {
          error: kind === 'logo' ? 'logo must be at most 512 KiB' : 'preview must be at most 2 MiB',
        },
        413,
      )
    if (Number(c.req.header('content-length')) > limit) return tooLarge()
    const body = await c.req.arrayBuffer().catch(() => null)
    if (body === null || body.byteLength === 0)
      return c.json({ error: 'upload must not be empty' }, 400)
    if (body.byteLength > limit) return tooLarge()
    const bytes = new Uint8Array(body)
    const contentType = sniffServerAssetContentType(bytes)
    if (contentType === null) return c.json({ error: 'upload a PNG, JPEG, WebP or GIF image' }, 415)
    const etag = await sha256Hex(bytes)
    return runBackendHttp(
      c,
      runtime,
      replaceServerAsset(kind, { blobKey: `${kind}/${etag}`, contentType }, bytes, currentSeason),
      () => c.json({ etag, contentType }),
    )
  })

  routes.delete('/assets/:kind', (c) => {
    const kind = assetKind(c.req.param('kind'))
    if (kind === null) return c.json({ error: 'asset not found' }, 404)
    return runBackendHttp(c, runtime, replaceServerAsset(kind, null, null, currentSeason), () =>
      c.json({ ok: true }),
    )
  })

  // Where live uploads, offers, and paints spend their time since the last reset. Live commands
  // run in the current season's coordinator, which on Cloudflare is a Durable Object rather than
  // this Worker, so ask the read model when it can reach that context.
  routes.get('/ingest-timings', async (c) => {
    const reset = c.req.query('reset') === 'true'
    const statusReadModel = Services.get(runtime.context, StatusReadModelService)
    if (statusReadModel.readIngestTimings !== undefined) {
      return c.json(await statusReadModel.readIngestTimings(currentSeason, reset))
    }
    const snapshot = ingestTimings.snapshot()
    if (reset) ingestTimings.reset()
    return c.json(snapshot)
  })

  return routes
}
