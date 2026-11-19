import {
  logoText,
  MAX_DESCRIPTION_LENGTH,
  MAX_LOGO_TEXT_LENGTH,
  normaliseHomeCopy,
  parseDiscordInviteUrl,
  parseHomeCopy,
  SERVER_ASSET_MAX_BYTES,
  type ServerAssetKind,
  type ServerInfo,
  sha256Hex,
  sniffServerAssetContentType,
} from '@caelestis/shared'
import { Hono } from 'hono'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import {
  readIngestTimings,
  readServerAsset,
  replaceServerAsset,
  resolveServerInfo,
  writeServerSettings,
} from '../server/use-cases.js'
import { readBoundedBody } from './body.js'
import { emptyPatch, INVALID_NAME, isName, jsonObject } from './params.js'

/** The `:kind` of a request `assetRoutes` already admitted, which is one of the two. */
const assetKind = (kind: string | undefined): ServerAssetKind =>
  kind === 'logo' ? 'logo' : 'preview'

/** Refuse any `:kind` other than a branding asset, for every route under `/assets/:kind`. */
const assetRoutes = () => {
  const routes = new Hono()
  routes.use('/:kind', async (c, next) => {
    const kind = c.req.param('kind')
    if (kind !== 'logo' && kind !== 'preview') return c.json({ error: 'asset not found' }, 404)
    await next()
  })
  return routes
}

/** Public, and deliberately so: this is how a userscript decides whether it needs a token at all. */
export const createServerRoutes = (runtime: BackendRuntime, base: ServerInfo) =>
  new Hono().get('/', (c) =>
    runBackendHttp(c, runtime, resolveServerInfo(base), (server) => c.json(server)),
  )

/** The branding images `/server` names, served to anyone. */
export const createServerAssetRoutes = (runtime: BackendRuntime) => {
  const routes = assetRoutes()
  routes.on(['GET', 'HEAD'], '/:kind', async (c) =>
    runBackendHttp(c, runtime, readServerAsset(assetKind(c.req.param('kind'))), (asset) => {
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
    }),
  )
  return routes
}

/**
 * Operator-managed public server details and branding assets.
 *
 * Its own route under `/admin` rather than a method on the public one, so the read stays reachable
 * without a credential while the write never is.
 */
export const createServerAdminRoutes = (runtime: BackendRuntime, currentSeason: number) => {
  const routes = new Hono()

  routes.patch('/', async (c) => {
    const body = await jsonObject(c)
    if (body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, description, discordInviteUrl, homeCopy, logoText: rawLogoText } = body

    // A server name must also show something: whitespace alone is refused.
    if (name !== undefined && (!isName(name) || name.trim().length === 0)) {
      return c.json({ error: INVALID_NAME }, 400)
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
      return c.json(
        { error: `description must be 1..${MAX_DESCRIPTION_LENGTH} characters, or null` },
        400,
      )
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
      return c.json(
        { error: `logoText must be 1..${MAX_LOGO_TEXT_LENGTH} characters, or null` },
        400,
      )
    }
    const empty = emptyPatch({
      name,
      description,
      discordInviteUrl,
      homeCopy,
      logoText: rawLogoText,
    })
    if (empty !== null) return c.json({ error: empty }, 400)

    return runBackendHttp(
      c,
      runtime,
      writeServerSettings(
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

  const assets = assetRoutes()
  assets.put('/:kind', async (c) => {
    const kind = assetKind(c.req.param('kind'))
    const limit = SERVER_ASSET_MAX_BYTES[kind]
    const bytes = await readBoundedBody(c.req.raw, limit)
    if (bytes === null) {
      return c.json(
        {
          error: kind === 'logo' ? 'logo must be at most 512 KiB' : 'preview must be at most 2 MiB',
        },
        413,
      )
    }
    if (bytes.byteLength === 0) return c.json({ error: 'upload must not be empty' }, 400)
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
  assets.delete('/:kind', async (c) =>
    runBackendHttp(
      c,
      runtime,
      replaceServerAsset(assetKind(c.req.param('kind')), null, null, currentSeason),
      () => c.json({ ok: true }),
    ),
  )
  routes.route('/assets', assets)

  routes.get('/ingest-timings', async (c) =>
    runBackendHttp(
      c,
      runtime,
      readIngestTimings(currentSeason, c.req.query('reset') === 'true'),
      (timings) => c.json(timings),
    ),
  )

  return routes
}
